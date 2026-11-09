// Calls hiringcafe.com's search API directly from the extension's background service worker.
// No tab or window is ever opened. Requests use your browser's own connection and cookies,
// so Cloudflare sees the same browser you normally browse with.
const API_URL = 'https://hiringcafe.com/api/search-jobs';
const PAGE_SIZE = 40;
const MAX_PAGES = 20;
const MAX_RAW_JOBS = 800;
const DELAY_BETWEEN_PAGES_MS = 400; // be polite
const REQUEST_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const rawJobs = [];
  const seen = new Set();
  let firstRequest = null;

  progress({ stage: 'searching' });
  for (let page = 0; page < MAX_PAGES && rawJobs.length < scanTarget; page++) {
    const body = { size: PAGE_SIZE, page, searchState: { searchQuery: query } };
    firstRequest ??= body;
    const data = await postJson(API_URL, body);

    const found = findJobArrays(data);
    let added = 0;
    for (const raw of found) {
      const key = jobKey(raw);
      if (seen.has(key)) continue;
      seen.add(key);
      rawJobs.push(slim(raw));
      added++;
    }
    progress({ stage: 'collecting', scanned: rawJobs.length });
    if (!found.length || added === 0 || found.length < PAGE_SIZE) break; // last page
    await sleep(DELAY_BETWEEN_PAGES_MS);
  }

  return {
    rawJobs: rawJobs.slice(0, MAX_RAW_JOBS),
    domJobs: [],
    meta: { source: 'api', apiUrls: [API_URL], searchRequest: firstRequest, durationMs: Date.now() - startedAt },
  };
}

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`Could not reach hiringcafe.com (${err.name === 'TimeoutError' ? 'timed out' : err.message}).`);
  }

  const text = await res.text();
  const diagnostics = {
    request: { url, body },
    status: res.status,
    contentType: res.headers.get('content-type'),
    responseStart: text.slice(0, 600),
  };

  if (/just a moment|cf-chl|challenge-platform|attention required/i.test(text)) {
    throw Object.assign(
      new Error('hiringcafe.com asked this browser for a Cloudflare check. Visit hiringcafe.com yourself once in this browser (complete the check if shown), then search again.'),
      { diagnostics }
    );
  }
  if (!res.ok) {
    throw Object.assign(new Error(`hiringcafe.com search API returned HTTP ${res.status}. The API may have changed; see details.`), { diagnostics });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('hiringcafe.com returned something other than JSON. The API may have changed; see details.'), { diagnostics });
  }
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
