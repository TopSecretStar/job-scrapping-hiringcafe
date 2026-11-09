// Drives a hiringcafe.com tab in the user's own browser: type the query, scroll to load more,
// read the JSON the site fetched (captured by capture.js), then close the tab.
const SITE_URL = 'https://hiringcafe.com/?js_scrape=1';
const COLLECT_BUDGET_MS = 90_000;
const MAX_RAW_JOBS = 800;

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
        const result = await runSearch(msg.params, port.sender?.tab, (p) => send({ type: 'progress', ...p }));
        send({ type: 'result', ...result });
      } catch (err) {
        send({ type: 'error', error: err.message, diagnostics: err.diagnostics ?? null });
      }
    });
  });
});

async function runSearch(params, senderTab, progress) {
  const startedAt = Date.now();
  const query = String(params?.q || '').trim();
  if (!query) throw new Error('Missing search query');
  const scanTarget = Math.min(Math.max(Number(params.scanTarget) || 50, 1), MAX_RAW_JOBS);

  progress({ stage: 'opening' });
  const tab = await chrome.tabs.create({
    url: SITE_URL,
    active: true, // visible tabs aren't throttled, and you can click a Cloudflare check if one appears
    ...(senderTab ? { windowId: senderTab.windowId, index: senderTab.index + 1 } : {}),
  });

  try {
    await waitForTabComplete(tab.id, 45_000);

    // Cloudflare "Just a moment..." — wait for it to clear (automatically, or by your click).
    if (await isChallenge(tab.id)) {
      progress({ stage: 'verifying' });
      const until = Date.now() + 60_000;
      while ((await isChallenge(tab.id)) && Date.now() < until) await sleep(1000);
      if (await isChallenge(tab.id)) {
        throw withDiagnostics(new Error('hiringcafe.com is still showing its Cloudflare check. Open hiringcafe.com once in this browser, complete the check, then search again.'), await diagnostics(tab.id));
      }
      await waitForTabComplete(tab.id, 30_000);
    }

    // Wait for the search box to appear (React needs a moment to render).
    progress({ stage: 'searching' });
    await sleep(1500);
    let idx = (await execMain(tab.id, () => (window.__jobScrapperCaptured || []).length)) ?? 0;
    let typed = false;
    for (const until = Date.now() + 20_000; !typed && Date.now() < until; ) {
      typed = await exec(tab.id, typeQuery, [query]);
      if (!typed) await sleep(1000);
    }
    if (!typed) {
      throw withDiagnostics(new Error('Could not find the search box on hiringcafe.com (the page layout may have changed).'), await diagnostics(tab.id));
    }

    // Collect results while scrolling.
    const rawJobs = [];
    const seenKeys = new Set();
    const apiUrls = new Set();
    let searchRequest = null;
    let stagnant = 0;
    let triedSubmit = false;

    while (rawJobs.length < scanTarget && stagnant < 4 && Date.now() - startedAt < COLLECT_BUDGET_MS) {
      await sleep(1500);
      const captured = (await execMain(tab.id, () => window.__jobScrapperCaptured || [])) || [];
      if (captured.length < idx) idx = 0; // page reloaded
      const fresh = captured.slice(idx);
      idx = captured.length;

      const before = rawJobs.length;
      for (const item of fresh) {
        const found = findJobArrays(item.data);
        if (!found.length) continue;
        apiUrls.add(item.url);
        if (!searchRequest && item.requestBody) {
          try { searchRequest = JSON.parse(item.requestBody); } catch { searchRequest = item.requestBody; }
        }
        for (const raw of found) {
          const key = jobKey(raw);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          rawJobs.push(slim(raw));
        }
      }
      progress({ stage: 'collecting', scanned: rawJobs.length });

      if (rawJobs.length === before) {
        stagnant++;
        if (!rawJobs.length && !triedSubmit && stagnant >= 2) {
          triedSubmit = true; // Enter didn't trigger a search; try submitting the form / clicking search.
          await exec(tab.id, submitSearch, []);
        }
      } else {
        stagnant = 0;
      }
      await exec(tab.id, scrollToBottom, []);
    }

    let domJobs = [];
    if (!rawJobs.length) domJobs = (await exec(tab.id, scrapeDom, [])) || [];

    return {
      rawJobs: rawJobs.slice(0, MAX_RAW_JOBS),
      domJobs,
      meta: {
        source: rawJobs.length ? 'api' : 'dom',
        apiUrls: [...apiUrls],
        searchRequest,
        durationMs: Date.now() - startedAt,
      },
    };
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
    if (senderTab?.id) chrome.tabs.update(senderTab.id, { active: true }).catch(() => {});
  }
}

// ---------- tab helpers ----------

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => id === tabId && info.status === 'complete' && done();
    const timer = setTimeout(done, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => t.status === 'complete' && done()).catch(done);
  });
}

async function exec(tabId, func, args) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return r?.result;
  } catch {
    return undefined; // page navigating / not ready yet
  }
}

async function execMain(tabId, func, args = []) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
    return r?.result;
  } catch {
    return undefined;
  }
}

async function isChallenge(tabId) {
  const title = (await exec(tabId, () => document.title, [])) || '';
  return /just a moment|attention required|security verification/i.test(title);
}

function withDiagnostics(err, diag) {
  err.diagnostics = diag;
  return err;
}

const diagnostics = (tabId) => exec(tabId, pageDiagnostics, []);

// ---------- data helpers (run in the extension) ----------

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

// ---------- functions injected into the hiringcafe.com tab (must be self-contained) ----------

function typeQuery(query) {
  const selectors = [
    'input[placeholder*="search" i]',
    'input[placeholder*="job" i]',
    'input[type="search"]',
    'input[type="text"]',
    'input:not([type])',
    'textarea',
  ];
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
  let input = null;
  for (const sel of selectors) {
    input = [...document.querySelectorAll(sel)].find(visible);
    if (input) break;
  }
  if (!input) {
    const opener = [...document.querySelectorAll('button, [role="button"], [aria-label]')].find((b) =>
      /search/i.test(b.getAttribute('aria-label') || b.textContent || '')
    );
    opener?.click();
    return false;
  }
  input.focus();
  input.select?.();
  const inserted = document.execCommand('insertText', false, query);
  if (!inserted || input.value !== query) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter ? setter.call(input, query) : (input.value = query);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  for (const type of ['keydown', 'keypress', 'keyup']) {
    input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
  return true;
}

function submitSearch() {
  const visible = (el) => !!(el.offsetWidth || el.offsetHeight);
  const input = document.activeElement?.matches?.('input, textarea') ? document.activeElement : null;
  if (input?.form) {
    input.form.requestSubmit?.();
    return 'form';
  }
  const btn = [...document.querySelectorAll('button, [role="button"]')].find(
    (b) => visible(b) && /search|find/i.test(b.getAttribute('aria-label') || b.textContent || '')
  );
  btn?.click();
  return btn ? 'button' : 'none';
}

function scrollToBottom() {
  window.scrollTo(0, document.documentElement.scrollHeight);
  // Also scroll inner scrollable containers (some job lists scroll inside a div).
  for (const el of document.querySelectorAll('main, div, section, ul')) {
    if (el.scrollHeight > el.clientHeight + 200) {
      const oy = getComputedStyle(el).overflowY;
      if (oy === 'auto' || oy === 'scroll') el.scrollTop = el.scrollHeight;
    }
  }
}

function scrapeDom() {
  const cards = new Set();
  document.querySelectorAll('a[href*="/job"], a[href*="viewjob"], a[target="_blank"]').forEach((a) => {
    const card = a.closest('[class*="card" i], li, article, div[class*="job" i]') || a.parentElement;
    if (card) cards.add(card);
  });
  return [...cards]
    .map((card, i) => {
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
    })
    .filter((j) => j.title);
}

function pageDiagnostics() {
  return {
    url: location.href,
    title: document.title,
    text: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 800),
    inputs: [...document.querySelectorAll('input, textarea, [contenteditable="true"]')].slice(0, 15).map((e) => ({
      tag: e.tagName.toLowerCase(),
      type: e.getAttribute('type'),
      placeholder: e.getAttribute('placeholder'),
      ariaLabel: e.getAttribute('aria-label'),
      visible: !!(e.offsetWidth || e.offsetHeight),
    })),
    buttons: [...document.querySelectorAll('button, [role="button"]')]
      .slice(0, 25)
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim().slice(0, 60))
      .filter(Boolean),
  };
}
