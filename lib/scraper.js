// Scrapes hiringcafe.com by driving a real Chromium window on THIS computer, the same way a
// person would: open the site, type the search, scroll, read what the page shows.
//
// Deliberately plain: no stealth tricks, no challenge solving, no direct API calls, one search
// at a time, polite delays. If Cloudflare shows its "Just a moment..." check, you complete it in
// the window yourself; the browser profile (.browser-profile/) remembers the clearance afterwards.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { buildLocationFilter, collectLocationText } from './location.js';
import { findJobArrays, normalizeJob, toCsv } from './parse.js';

export { toCsv };

export const BASE_URL = process.env.HIRINGCAFE_URL || 'https://hiringcafe.com';
const PROFILE_DIR = process.env.BROWSER_PROFILE_DIR || path.resolve(process.cwd(), '.browser-profile');
const CHALLENGE_WAIT_MS = 120_000; // how long to wait for you to pass a Cloudflare check
const CHALLENGE_RE = /just a moment|attention required|verify you are human|checking your browser|security verification/i;

// Ad/analytics hosts: skipped to make pages lighter, like an ad blocker would.
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
 * @param {object} opts
 * @param {string} opts.query               search keyword, e.g. "AI Engineer"
 * @param {string} [opts.location]          e.g. "Europe Remote", "Germany", "UK, Hybrid"
 * @param {string[]} [opts.workplaceTypes]  any of "remote" | "hybrid" | "onsite"
 * @param {boolean} [opts.includeWorldwide] keep "Remote - Worldwide/Anywhere" jobs when filtering by region (default true)
 * @param {number} [opts.maxJobs]           stop after this many matching jobs (default 100)
 * @param {number} [opts.maxScrolls]        max infinite-scroll attempts (default 40)
 * @param {number} [opts.timeBudgetMs]      stop scrolling after this long (default 90s)
 * @param {boolean} [opts.headless]         default: visible window (env HEADLESS=1 to hide it)
 * @param {string} [opts.debugDir]          if set, dumps screenshots, HTML and raw API responses here
 * @param {(stage: string) => void} [opts.onStage] progress callback: opening | challenge | searching | collecting
 * @returns {Promise<{jobs: object[], meta: object}>}
 */
// One browser at a time: parallel searches would hammer the site and exhaust memory.
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
  timeBudgetMs = 90_000,
  headless = process.env.HEADLESS === '1',
  debugDir,
  onStage = () => {},
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
    challengeShown: false,
    searchRequest: null, // the site's own search request body (debugging only; never replayed)
    apiUrls: [],
    firstRawJob: null,
    durationMs: 0,
  };

  onStage('opening');
  const context = await launchBrowser(headless);
  const page = context.pages()[0] || (await context.newPage());

  await page.route('**/*', (route) => {
    const req = route.request();
    if (['image', 'media', 'font'].includes(req.resourceType())) return route.abort();
    if (BLOCKED_HOSTS.test(new URL(req.url()).hostname)) return route.abort();
    return route.continue();
  });

  const jobsById = new Map();
  const seen = new Set();
  let responseCount = 0;

  // 1) Read the job data the page itself loads (structured, so no brittle CSS selectors).
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
    if (!found.length) return;
    if (!meta.apiUrls.includes(res.url())) meta.apiUrls.push(res.url());
    if (!meta.searchRequest && res.request().postData()) {
      try { meta.searchRequest = JSON.parse(res.request().postData()); } catch {}
    }
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
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });

    // Cloudflare check: wait for it to clear (it often passes by itself in a real window;
    // otherwise click the checkbox in the browser window).
    if (await isChallenge(page)) {
      meta.challengeShown = true;
      onStage('challenge');
      console.warn('[cloudflare] Security check shown. If it does not clear by itself, click it in the browser window.');
      await page
        .waitForFunction((re) => !new RegExp(re, 'i').test(document.title), CHALLENGE_RE.source, { timeout: CHALLENGE_WAIT_MS })
        .catch(() => {});
      if (await isChallenge(page)) {
        throw withDiagnostics(
          new Error(`hiringcafe.com's security check did not clear within ${CHALLENGE_WAIT_MS / 1000}s. Complete it in the browser window and search again.`),
          page, headless
        );
      }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    if (debugDir) await page.screenshot({ path: path.join(debugDir, '01_home.png') });

    // 2) Type the query into the search box like a user.
    onStage('searching');
    let input;
    try {
      input = await findSearchInput(page);
    } catch (err) {
      if (debugDir) fs.writeFileSync(path.join(debugDir, 'no_input.html'), await page.content().catch(() => ''));
      throw await withDiagnostics(err, page, headless);
    }
    await input.click();
    await input.fill('');
    await input.type(query, { delay: 40 });
    jobsById.clear(); // drop default/home-page results; keep only results for this query
    seen.clear();
    meta.scanned = 0;
    meta.firstRawJob = null;
    meta.searchRequest = null;
    await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2000);
    if (debugDir) await page.screenshot({ path: path.join(debugDir, '02_search.png') });

    // 3) Infinite scroll to load more results, within the time budget.
    //    With a location filter many scanned jobs are dropped, so stop on "no new jobs scanned", not "no new matches".
    onStage('collecting');
    let stagnant = 0;
    for (let i = 0; i < maxScrolls && jobsById.size < maxJobs && stagnant < 3 && elapsed() < timeBudgetMs; i++) {
      const before = seen.size;
      await page.mouse.wheel(0, 4000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500 + Math.random() * 1000);
      stagnant = seen.size === before ? stagnant + 1 : 0;
    }

    // 4) Fallback: if no structured data was seen, read the rendered page.
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
    await context.close().catch(() => {});
  }

  meta.durationMs = elapsed();
  return { jobs: [...jobsById.values()].slice(0, maxJobs), meta };
}

/** A persistent profile keeps cookies (incl. a passed Cloudflare check) between runs, like a normal browser. */
async function launchBrowser(headless) {
  const { chromium } = await import('playwright');
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    viewport: { width: 1400, height: 900 },
    locale: 'en-US',
    args: await dnsFallbackArgs(new URL(BASE_URL).hostname),
  });
}

/**
 * Some VPNs (e.g. Astrill's 198.18.0.1 resolver) fail to resolve hiringcafe.com.
 * If the system lookup fails, resolve the IP via DNS-over-HTTPS and map it in Chromium only.
 * Override manually with env HIRINGCAFE_IP=1.2.3.4.
 */
async function dnsFallbackArgs(host) {
  if (host === 'localhost' || /^[\d.]+$/.test(host)) return [];
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

async function isChallenge(page) {
  const title = await page.title().catch(() => '');
  return CHALLENGE_RE.test(title);
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
  throw new Error('Could not find the search box on hiringcafe.com (the page layout may have changed; see details).');
}

/** Attach what the browser actually showed, so failures can be understood from the UI. */
async function withDiagnostics(err, page, withScreenshot) {
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
    }))
    .catch((e) => ({ evaluateError: e.message }));
  err.diagnostics = { url: page.url(), ...info, blockedByCloudflare: CHALLENGE_RE.test(`${info.title} ${info.text}`) };
  if (withScreenshot) {
    const buf = await page.screenshot({ type: 'jpeg', quality: 50 }).catch(() => null);
    if (buf) err.diagnostics.screenshot = `data:image/jpeg;base64,${buf.toString('base64')}`;
  }
  return err;
}

/** DOM fallback: read job cards from the rendered page. */
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
