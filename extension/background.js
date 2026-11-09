// Calls hiringcafe.com's search API directly from the extension's background service worker.
// No tab or window is ever opened. Requests use your browser's own connection and cookies,
// so Cloudflare sees the same browser you normally browse with.
// Network fallbacks: tried in order if an address can't be reached at all.
const API_URLS = [
  'https://hiringcafe.com/api/search-jobs',
  'https://www.hiringcafe.com/api/search-jobs',
  'https://hiring.cafe/api/search-jobs', // old domain, redirects to hiringcafe.com
];
const HOST_ORIGINS = ['https://hiringcafe.com/*', 'https://*.hiringcafe.com/*', 'https://hiring.cafe/*', 'https://*.hiring.cafe/*'];
const PAGE_SIZE = 40;
const MAX_PAGES = 20;
const MAX_RAW_JOBS = 800;
const DELAY_BETWEEN_PAGES_MS = 400; // be polite
const REQUEST_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

// The API's request format isn't documented, so try likely formats and keep the first one that
// returns jobs matching the query. (POST was rejected with 405, so GET formats come first.)
const REQUEST_STYLES = [
  { name: 'GET ?s=<searchState JSON>', build: (base, q, page) => ({ url: `${base}?s=${encodeURIComponent(JSON.stringify({ searchQuery: q }))}&size=${PAGE_SIZE}&page=${page}` }) },
  { name: 'GET ?s=<base64 searchState>', build: (base, q, page) => ({ url: `${base}?s=${encodeURIComponent(b64(JSON.stringify({ searchQuery: q })))}&size=${PAGE_SIZE}&page=${page}` }) },
  { name: 'GET ?searchState=<JSON>', build: (base, q, page) => ({ url: `${base}?searchState=${encodeURIComponent(JSON.stringify({ searchQuery: q }))}&size=${PAGE_SIZE}&page=${page}` }) },
  { name: 'GET ?searchQuery=', build: (base, q, page) => ({ url: `${base}?searchQuery=${encodeURIComponent(q)}&size=${PAGE_SIZE}&page=${page}` }) },
  { name: 'GET ?query=', build: (base, q, page) => ({ url: `${base}?query=${encodeURIComponent(q)}&size=${PAGE_SIZE}&page=${page}` }) },
  { name: 'GET ?q=', build: (base, q, page) => ({ url: `${base}?q=${encodeURIComponent(q)}&size=${PAGE_SIZE}&page=${page}` }) },
  { name: 'POST JSON', build: (base, q, page) => ({ url: base, method: 'POST', body: { size: PAGE_SIZE, page, searchState: { searchQuery: q } } }) },
];
let working = null; // { base, style } remembered while the service worker is alive

// One search at a time.
let queue = Promise.resolve();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'job-scrapper') return;
  port.onMessage.addListener((msg) => {
    if (msg.type !== 'search') return;
    const send = (m) => {
      try { port.postMessage({ id: msg.id, ...m }); } catch {}
    };
    queue = queue.then(async () => {
      try {
        const result = await runSearch(msg.params, (p) => send({ type: 'progress', ...p }));
        send({ type: 'result', ...result });
      } catch (err) {
        send({ type: 'error', error: err.message, diagnostics: err.diagnostics ?? null });
      }
    });
  });
});

async function runSearch(params, progress) {
  const startedAt = Date.now();
  const query = String(params?.q || '').trim();
  if (!query) throw new Error('Missing search query');
  const scanTarget = Math.min(Math.max(Number(params.scanTarget) || 50, 1), MAX_RAW_JOBS);

  progress({ stage: 'searching' });
  const first = await findWorkingRequest(query);
  const rawJobs = [];
  const seen = new Set();
  const addJobs = (found) => {
    let added = 0;
    for (const raw of found) {
      const key = jobKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      rawJobs.push(slim(raw));
      added++;
    }
    return added;
  };

  let found = first.jobs;
  addJobs(found);
  progress({ stage: 'collecting', scanned: rawJobs.length });

  for (let page = 1; page < MAX_PAGES && rawJobs.length < scanTarget && found.length >= Math.min(PAGE_SIZE, first.jobs.length); page++) {
    await sleep(DELAY_BETWEEN_PAGES_MS);
    const r = await send(working.style.build(working.base, query, page));
    if (!r.ok) break;
    found = findJobArrays(r.data);
    if (!found.length || addJobs(found) === 0) break; // no more pages (or paging not supported)
    progress({ stage: 'collecting', scanned: rawJobs.length });
  }

  return {
    rawJobs: rawJobs.slice(0, MAX_RAW_JOBS),
    domJobs: [],
    meta: {
      source: 'api',
      apiUrls: [working.base],
      requestFormat: working.style.name,
      exampleRequest: first.request,
      queryMatched: first.relevant,
      durationMs: Date.now() - startedAt,
    },
  };
}

/** Find (or reuse) a base URL + request format that returns jobs for this query. */
async function findWorkingRequest(query) {
  const attempts = [];
  const candidates = [];
  if (working) candidates.push(working);
  for (const base of API_URLS) for (const style of REQUEST_STYLES) candidates.push({ base, style });

  let fallback = null; // returned jobs, but none mention the query (format may be ignoring it)
  const unreachable = new Set();
  for (const c of candidates) {
    if (unreachable.has(c.base)) continue;
    const req = c.style.build(c.base, query, 0);
    const r = await send(req);
    attempts.push({ format: c.style.name, url: req.url, ...r.summary });
    if (r.networkError) {
      unreachable.add(c.base);
      continue;
    }
    if (r.cloudflare) {
      throw Object.assign(
        new Error('hiringcafe.com asked this browser for a Cloudflare check. Visit hiringcafe.com yourself once in this browser (complete the check if shown), then search again.'),
        { diagnostics: { attempts } }
      );
    }
    if (!r.ok) continue;
    const jobs = findJobArrays(r.data);
    if (!jobs.length) continue;
    const relevant = mentionsQuery(jobs, query);
    const hit = { ...c, jobs, request: req, relevant };
    if (relevant) {
      working = c;
      return hit;
    }
    fallback ??= hit;
  }
  if (fallback) {
    working = { base: fallback.base, style: fallback.style };
    return fallback;
  }
  if (unreachable.size === API_URLS.length) throw await diagnoseUnreachable(attempts);
  throw Object.assign(
    new Error("hiringcafe.com's search API didn't accept any known request format. Please send the details below (or a \"Copy as fetch\" of the site's search request) so the format can be matched."),
    { diagnostics: { attempts } }
  );
}

/** Do the returned jobs look like results for this query? Checks job titles for whole query words. */
function mentionsQuery(jobs, query) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return true;
  const re = new RegExp(`(^|[^a-z0-9])(${words.map(esc).join('|')})(?=[^a-z0-9]|$)`, 'i');
  const titleOf = (j) =>
    j?.job_information?.title ?? j?.v5_processed_job_data?.core_job_title ?? j?.title ?? j?.job_title ?? j?.name ?? '';
  const sample = jobs.slice(0, 20);
  const hits = sample.filter((j) => re.test(String(titleOf(j)))).length;
  return hits >= Math.max(1, Math.ceil(sample.length * 0.2)); // at least 20% of titles match
}

/** Perform one request. Never throws; returns a result with a short summary for diagnostics. */
async function send({ url, method = 'GET', body }) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'include',
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const error = err.name === 'TimeoutError' ? 'timed out' : err.message;
    return { ok: false, networkError: true, summary: { error } };
  }
  const text = await res.text().catch(() => '');
  const summary = {
    status: res.status,
    allow: res.headers.get('allow') || undefined,
    contentType: res.headers.get('content-type') || undefined,
    finalUrl: res.url !== url ? res.url : undefined,
    responseStart: text.slice(0, 200),
  };
  const cloudflare = /just a moment|cf-chl|challenge-platform|attention required/i.test(text);
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok && data !== null, data, cloudflare, summary };
}

/** Work out why no API URL could be reached, and say so plainly. */
async function diagnoseUnreachable(attempts) {
  const diagnostics = { attempts, online: navigator.onLine };

  // 1) Has the user restricted the extension's site access in Chrome?
  try {
    diagnostics.permissions = {};
    for (const origin of HOST_ORIGINS) diagnostics.permissions[origin] = await chrome.permissions.contains({ origins: [origin] });
  } catch (e) {
    diagnostics.permissions = String(e);
  }
  const allowed = typeof diagnostics.permissions === 'object' ? diagnostics.permissions['https://hiringcafe.com/*'] : true;
  if (allowed === false) {
    return Object.assign(
      new Error('The extension is not allowed to access hiringcafe.com. Open chrome://extensions → Job Scrapper Helper → Details → Site access, and allow it on all listed sites.'),
      { diagnostics }
    );
  }

  // 2) Can the browser reach the site at all (simple GET)?
  diagnostics.probes = [];
  for (const origin of ['https://hiringcafe.com/', 'https://www.hiringcafe.com/', 'https://hiring.cafe/']) {
    try {
      const r = await fetch(origin, { method: 'GET', credentials: 'include', signal: AbortSignal.timeout(10_000) });
      diagnostics.probes.push({ url: origin, status: r.status, finalUrl: r.url });
    } catch (e) {
      diagnostics.probes.push({ url: origin, error: e.name === 'TimeoutError' ? 'timed out' : e.message });
    }
  }
  const anyReachable = diagnostics.probes.some((p) => p.status);

  if (!navigator.onLine) {
    return Object.assign(new Error('This browser is offline.'), { diagnostics });
  }
  if (!anyReachable) {
    return Object.assign(
      new Error(
        "This browser can't connect to hiringcafe.com at all (no answer from any of its addresses). " +
          "This is usually DNS or a VPN: your Astrill VPN's DNS couldn't resolve hiringcafe.com earlier. " +
          'Try with the VPN off or with hiringcafe.com excluded from it, or set Chrome → Settings → Privacy and security → Security → "Use secure DNS" (e.g. Cloudflare 1.1.1.1).'
      ),
      { diagnostics }
    );
  }
  return Object.assign(
    new Error(
      'hiringcafe.com is reachable, but its search API request was blocked by the browser (often a redirect to an address the extension is not allowed to use). See details.'
    ),
    { diagnostics }
  );
}

// ---------- data helpers ----------

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

function jobKey(raw) {
  return String(raw.id ?? raw.objectID ?? raw._id ?? raw.job_id ?? raw.apply_url ?? JSON.stringify(raw).slice(0, 300));
}

/** Drop very long text fields (full descriptions) to keep messages small. */
function slim(value, depth = 0) {
  if (typeof value === 'string') return value.length > 1500 ? undefined : value;
  if (!value || typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => slim(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const s = slim(v, depth + 1);
    if (s !== undefined) out[k] = s;
  }
  return out;
}
