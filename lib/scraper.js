import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { buildLocationFilter, collectLocationText } from './location.js';

const BASE_URL = 'https://hiringcafe.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const BLOCKED_HOSTS =
  /(google-analytics|googletagmanager|doubleclick|googlesyndication|segment\.(io|com)|hotjar|intercom|sentry|clarity\.ms|facebook|fullstory|mixpanel|amplitude|posthog|hubspot|linkedin|twitter|tiktok|crisp)\./i;

// Candidate selectors for the search box, tried in order.
const SEARCH_SELECTORS = [
  'input[placeholder*="search" i]',
  'input[placeholder*="job" i]',
  'input[type="search"]',
  'input[type="text"]',
  'input:not([type])',
  'textarea',
];

/**
 * Scrape hiringcafe.com for a keyword.
 * @param {object} opts
 * @param {string} opts.query          search keyword, e.g. "react developer"
 * @param {string} [opts.location]     e.g. "Europe Remote", "Germany", "UK, Hybrid"
 * @param {string[]} [opts.workplaceTypes] any of "remote" | "hybrid" | "onsite"
 * @param {boolean} [opts.includeWorldwide] keep "Remote - Worldwide/Anywhere" jobs when filtering by region (default true)
 * @param {number} [opts.maxJobs]      stop after this many matching jobs (default 100)
 * @param {number} [opts.maxScrolls]   max infinite-scroll attempts (default 20)
 * @param {number} [opts.timeBudgetMs] stop scrolling after this long (default 45s; keeps serverless under its limit)
 * @param {boolean} [opts.headless]    default true
 * @param {string} [opts.debugDir]     if set, dumps screenshots, HTML and raw API responses here
 * @param {boolean} [opts.screenshotOnError] attach a base64 screenshot to error diagnostics
 * @returns {Promise<{jobs: object[], meta: object}>}
 */
// One browser at a time per process: Vercel can run several requests in one instance,
// and parallel Chromiums exhaust memory (net::ERR_INSUFFICIENT_RESOURCES).
let queue = Promise.resolve();
export function scrapeJobs(opts) {
  const run = queue.then(() => scrapeJobsNow(opts));
  queue = run.catch(() => {});
  return run;
}

async function scrapeJobsNow({
  query,
  location = '',
  workplaceTypes = [],
  includeWorldwide = true,
  maxJobs = 100,
  maxScrolls = 40,
  timeBudgetMs = 45_000,
  headless = true,
  debugDir,
  screenshotOnError = false,
} = {}) {
  if (!query) throw new Error('query is required');
  if (debugDir) fs.mkdirSync(debugDir, { recursive: true });

  const filter = buildLocationFilter({ location, workplaceTypes, includeWorldwide });
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const meta = {
    query,
    filter: { location, places: filter.places, workplaceTypes: filter.workplaceTypes, includeWorldwide },
    source: 'api',
    scanned: 0,
    siteFilters: null, // filters we managed to apply on hiringcafe's own search request
    searchRequest: null, // hiringcafe's search request body (for debugging/wiring more filters)
    apiUrls: [],
    firstRawJob: null,
    durationMs: 0,
  };

  const browser = await launchBrowser(headless);
  const context = await browser.newContext({ userAgent: UA, viewport: { width: 1400, height: 900 }, locale: 'en-US' });
  const page = await context.newPage();

  // Skip heavy assets and trackers to save time and memory (important on serverless).
  await page.route('**/*', (route) => {
    const req = route.request();
    if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort();
    if (BLOCKED_HOSTS.test(new URL(req.url()).hostname)) return route.abort();
    if (req.method() === 'POST' && req.postData()?.includes('searchState')) {
      return route.continue(applySiteFilters(req.postData(), filter.workplaceTypes, meta));
    }
    return route.continue();
  });

  const jobsById = new Map();
  const seen = new Set();
  let responseCount = 0;

  // 1) Primary strategy: capture the JSON the React app fetches from its own API.
  page.on('response', async (res) => {
    const type = res.request().resourceType();
    if (type !== 'xhr' && type !== 'fetch') return;
    if (!(res.headers()['content-type'] || '').includes('json')) return;
    let data;
    try { data = await res.json(); } catch { return; }

    if (debugDir) {
      const name = `resp_${String(++responseCount).padStart(3, '0')}_${new URL(res.url()).pathname.replace(/\W+/g, '_')}.json`;
      fs.writeFileSync(path.join(debugDir, name), JSON.stringify({ url: res.url(), request: res.request().postData(), data }, null, 2));
    }

    const found = findJobArrays(data);
    if (found.length && !meta.apiUrls.includes(res.url())) meta.apiUrls.push(res.url());
    for (const raw of found) {
      meta.firstRawJob ??= raw;
      const job = normalizeJob(raw);
      if (!job.title || seen.has(job.id)) continue;
      seen.add(job.id);
      meta.scanned++;
      const locText = [job.location, ...collectLocationText(raw)].filter(Boolean).join(' | ');
      if (filter.matches(locText, job.workplace || '')) jobsById.set(job.id, job);
    }
  });

  try {
    await gotoWithRetry(page, BASE_URL);
    // If Cloudflare's "Just a moment..." check is showing, give it time to clear
    // (a real browser window usually passes on its own, or you can click it).
    if (/just a moment|attention required/i.test(await page.title())) {
      console.warn('[cloudflare] Verification page shown; waiting up to 45s for it to clear...');
      await page
        .waitForFunction(() => !/just a moment|attention required/i.test(document.title), null, { timeout: 45_000 })
        .catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    if (debugDir) await page.screenshot({ path: path.join(debugDir, '01_home.png') });

    // 2) Type the query into the search box like a user.
    let input;
    try {
      input = await findSearchInput(page);
    } catch (err) {
      err.diagnostics = await pageDiagnostics(page, screenshotOnError);
      if (err.diagnostics.blockedByCloudflare) {
        err.message = 'hiringcafe.com showed a Cloudflare bot check to the server, so the search page never loaded.';
      }
      if (debugDir) fs.writeFileSync(path.join(debugDir, 'no_input.html'), await page.content().catch(() => ''));
      throw err;
    }
    await input.click();
    await input.fill('');
    await input.type(query, { delay: 30 });
    jobsById.clear(); // drop default/home-page results; keep only results for this query
    seen.clear();
    meta.scanned = 0;
    meta.firstRawJob = null;
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (debugDir) await page.screenshot({ path: path.join(debugDir, '02_search.png') });

    // 3) Infinite scroll to load more results, within the time budget.
    //    With a location filter many scanned jobs are dropped, so stop on "no new jobs scanned", not "no new matches".
    let stagnant = 0;
    for (let i = 0; i < maxScrolls && jobsById.size < maxJobs && stagnant < 3 && elapsed() < timeBudgetMs; i++) {
      const before = seen.size;
      await page.mouse.wheel(0, 4000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1200 + Math.random() * 800);
      stagnant = seen.size === before ? stagnant + 1 : 0;
    }

    // 4) Fallback: if no API data was captured, read the rendered DOM.
    if (seen.size === 0) {
      meta.source = 'dom';
      for (const job of await scrapeDom(page)) {
        meta.scanned++;
        if (filter.matches(`${job.location || ''} | ${job.text}`, job.text)) jobsById.set(job.id, job);
      }
    }

    if (debugDir) {
      await page.screenshot({ path: path.join(debugDir, '03_final.png') });
      fs.writeFileSync(path.join(debugDir, 'final.html'), await page.content());
    }
  } finally {
    await browser.close();
  }

  meta.durationMs = elapsed();
  return { jobs: [...jobsById.values()].slice(0, maxJobs), meta };
}

/**
 * Best effort: set the workplace type on hiringcafe's own search request, but only if its
 * searchState already has a workplace-like array field (we never invent fields).
 * Location regions are filtered on our side, since the site expects geocoded location objects.
 */
function applySiteFilters(postData, workplaceTypes, meta) {
  let body;
  try { body = JSON.parse(postData); } catch { return undefined; }
  meta.searchRequest ??= body;
  const state = body?.searchState;
  if (!state || !workplaceTypes.length) return undefined;

  const key = Object.keys(state).find((k) => /workplace/i.test(k) && Array.isArray(state[k]));
  if (!key) return undefined;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const wanted = state[key].filter((v) => workplaceTypes.includes(norm(v)));
  if (!wanted.length) return undefined;

  state[key] = wanted;
  meta.siteFilters = { [key]: wanted };
  return { postData: JSON.stringify(body) };
}

/**
 * Runs on your own machine (worker/CLI) with Playwright's Chromium.
 * Not used on Vercel: hiringcafe.com's Cloudflare check blocks data-center IPs.
 */
async function launchBrowser(headless) {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ headless, args: await dnsFallbackArgs(new URL(BASE_URL).hostname) });
}

/**
 * Some VPNs (e.g. Astrill's 198.18.0.1 resolver) fail to resolve hiringcafe.com.
 * If the system lookup fails, resolve the IP via DNS-over-HTTPS and map it in Chromium only.
 * Override manually with env HIRINGCAFE_IP=1.2.3.4.
 */
async function dnsFallbackArgs(host) {
  let ip = process.env.HIRINGCAFE_IP;
  if (!ip) {
    try {
      await dns.lookup(host);
      return []; // system DNS works, nothing to do
    } catch {}
    ip = await dohLookup(host);
    console.warn(`[dns] System DNS could not resolve ${host}; using ${ip} from DNS-over-HTTPS.`);
  }
  return [`--host-resolver-rules=MAP ${host} ${ip}, MAP *.${host} ${ip}`];
}

async function dohLookup(host) {
  const endpoints = [
    `https://1.1.1.1/dns-query?name=${host}&type=A`,
    `https://8.8.8.8/resolve?name=${host}&type=A`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
      const answer = (await res.json()).Answer?.find((a) => a.type === 1);
      if (answer) return answer.data;
    } catch {}
  }
  throw new Error(
    `Cannot resolve ${host} (system DNS and DNS-over-HTTPS both failed). ` +
      `Check your VPN, or set HIRINGCAFE_IP to the site's IP address.`
  );
}

async function gotoWithRetry(page, url) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    } catch (err) {
      if (attempt >= 2 || !/ERR_INSUFFICIENT_RESOURCES|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED/.test(err.message)) throw err;
      await page.waitForTimeout(1500);
    }
  }
}

async function findSearchInput(page) {
  const pickVisible = async () => {
    for (const sel of SEARCH_SELECTORS) {
      const loc = page.locator(sel).filter({ visible: true }).first();
      if (await loc.count()) return loc;
    }
    return null;
  };
  const anyInput = page.locator(SEARCH_SELECTORS.join(', ')).filter({ visible: true }).first();

  // React may still be hydrating: wait for any visible text box.
  await anyInput.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
  let input = await pickVisible();
  if (input) return input;

  // Some layouts hide the search box behind a "Search" button/icon.
  const opener = page.getByRole('button', { name: /search/i }).or(page.locator('[aria-label*="search" i]')).first();
  if (await opener.count()) {
    await opener.click().catch(() => {});
    await anyInput.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    input = await pickVisible();
    if (input) return input;
  }
  throw new Error('Could not find the search input on hiringcafe.com (see diagnostics for what the page showed).');
}

/** What the browser actually saw, so failures on Vercel can be diagnosed without file access. */
async function pageDiagnostics(page, withScreenshot) {
  const info = await page
    .evaluate(() => ({
      title: document.title,
      text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
      inputs: [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].slice(0, 15).map((e) => ({
        tag: e.tagName.toLowerCase(),
        type: e.getAttribute('type'),
        placeholder: e.getAttribute('placeholder'),
        ariaLabel: e.getAttribute('aria-label'),
        visible: !!(e.offsetWidth || e.offsetHeight),
      })),
      buttons: [...document.querySelectorAll('button, [role="button"]')].slice(0, 25).map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 60)).filter(Boolean),
      htmlLength: document.documentElement.outerHTML.length,
    }))
    .catch((e) => ({ evaluateError: e.message }));
  const diag = { url: page.url(), ...info };
  diag.blockedByCloudflare = /just a moment|attention required|verify you are human|checking your browser/i.test(`${info.title} ${info.text}`);
  if (withScreenshot) {
    const buf = await page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
    if (buf) diag.screenshot = `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
  return diag;
}

/** Recursively find arrays of objects that look like job postings. */
function findJobArrays(node, depth = 0, out = []) {
  if (!node || typeof node !== 'object' || depth > 6) return out;
  if (Array.isArray(node)) {
    if (node.length && node.every((x) => x && typeof x === 'object' && !Array.isArray(x)) && looksLikeJob(node[0])) {
      out.push(...node);
      return out;
    }
    node.forEach((x) => findJobArrays(x, depth + 1, out));
  } else {
    Object.values(node).forEach((v) => findJobArrays(v, depth + 1, out));
  }
  return out;
}

function looksLikeJob(o) {
  const s = JSON.stringify(o).slice(0, 5000).toLowerCase();
  return (s.includes('title') || s.includes('job')) && (s.includes('company') || s.includes('apply') || s.includes('location'));
}

/** Pick the first non-empty value among several possible paths (API shape may vary). */
function pick(obj, ...paths) {
  for (const p of paths) {
    const v = p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function normalizeJob(raw) {
  const v5 = 'v5_processed_job_data';
  const info = 'job_information';
  const company = 'v5_processed_company_data';
  const min = pick(raw, `${v5}.yearly_min_compensation`, 'salary_min', 'min_salary');
  const max = pick(raw, `${v5}.yearly_max_compensation`, 'salary_max', 'max_salary');
  const job = {
    id: String(pick(raw, 'id', 'objectID', '_id', 'job_id', 'requisition_id', 'apply_url') ?? ''),
    title: pick(raw, `${info}.title`, `${v5}.core_job_title`, 'title', 'job_title', 'name'),
    company: pick(raw, `${v5}.company_name`, `${company}.name`, 'company_name', 'company.name', 'company'),
    location: pick(raw, `${v5}.formatted_workplace_location`, 'location', 'locations', 'job_location'),
    workplace: pick(raw, `${v5}.workplace_type`, 'workplace_type', 'remote'),
    commitment: pick(raw, `${v5}.commitment`, 'employment_type', 'job_type'),
    seniority: pick(raw, `${v5}.seniority_level`, 'seniority'),
    salary: min || max ? `${min ?? '?'} - ${max ?? '?'} ${pick(raw, `${v5}.listed_compensation_currency`) ?? ''}`.trim() : pick(raw, 'salary', 'compensation'),
    postedAt: pick(raw, `${v5}.estimated_publish_date`, 'estimated_publish_date', 'posted_at', 'created_at', 'date_posted'),
    url: pick(raw, 'apply_url', 'url', 'job_url', 'link'),
    source: pick(raw, 'source', 'board_token'),
  };
  for (const k of ['location', 'commitment', 'workplace', 'seniority']) {
    if (Array.isArray(job[k])) job[k] = job[k].join(', ');
  }
  if (job.company && typeof job.company === 'object') job.company = job.company.name ?? JSON.stringify(job.company);
  if (!job.id) job.id = `${job.title}|${job.company}|${job.location}`;
  return job;
}

/** DOM fallback: read job cards from the rendered React page. */
async function scrapeDom(page) {
  return page.evaluate(() => {
    const cards = new Set();
    document.querySelectorAll('a[href*="/job"], a[href*="viewjob"], a[target="_blank"]').forEach((a) => {
      const card = a.closest('[class*="card" i], li, article, div[class*="job" i]') || a.parentElement;
      if (card) cards.add(card);
    });
    return [...cards].map((card, i) => {
      const lines = card.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      const link = card.querySelector('a[href]');
      return {
        id: link?.href || `dom-${i}`,
        title: card.querySelector('h1,h2,h3,h4,[class*="title" i]')?.innerText.trim() || lines[0] || null,
        company: card.querySelector('[class*="company" i]')?.innerText.trim() || lines[1] || null,
        location: card.querySelector('[class*="location" i]')?.innerText.trim() || null,
        text: lines.join(' | '),
        url: link?.href || null,
      };
    }).filter((j) => j.title);
  });
}

export function toCsv(jobs) {
  if (!jobs.length) return '';
  const cols = [...new Set(jobs.flatMap(Object.keys))];
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...jobs.map((j) => cols.map((c) => esc(j[c])).join(','))].join('\n');
}
