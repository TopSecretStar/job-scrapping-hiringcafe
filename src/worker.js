#!/usr/bin/env node
// Local scraper worker: picks up searches queued on the website, scrapes them from this
// machine (home connection), and uploads the results.
//
// Setup: create .env with
//   APP_URL=https://your-app.vercel.app
//   WORKER_TOKEN=<same value as the WORKER_TOKEN env var in Vercel>
// Run:  npm run worker            (opens a visible browser window; add --headless to hide it,
//                                  but Cloudflare usually blocks headless browsers)
import os from 'node:os';
import { scrapeJobs } from '../lib/scraper.js';

try { process.loadEnvFile?.('.env'); } catch {}

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const TOKEN = process.env.WORKER_TOKEN;
const HEADLESS = process.argv.includes('--headless');
const POLL_MS = 3000;
const PAUSE_BETWEEN_SEARCHES_MS = 5000; // be polite to hiringcafe.com
const WORKER_NAME = `${os.hostname()}`;

if (!TOKEN) {
  console.error('WORKER_TOKEN is not set. Add it to .env (same value as in your Vercel project settings).');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

async function api(path, body) {
  const res = await fetch(`${APP_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${data.error || ''}`.trim());
  return data;
}

async function runSearch(search) {
  const p = search.params;
  log(`▶ "${p.q}"${p.location ? ` in "${p.location}"` : ''}${p.workplace.length ? ` [${p.workplace.join('/')}]` : ''} (max ${p.max})`);
  try {
    const { jobs, meta } = await scrapeJobs({
      query: p.q,
      location: p.location,
      workplaceTypes: p.workplace,
      includeWorldwide: p.worldwide,
      maxJobs: p.max,
      timeBudgetMs: 120_000,
      headless: HEADLESS,
    });
    await api('/api/worker/complete', { id: search.id, jobs, meta: { ...meta, firstRawJob: undefined } });
    log(`✔ ${jobs.length} jobs (scanned ${meta.scanned}) in ${(meta.durationMs / 1000).toFixed(1)}s`);
  } catch (err) {
    log(`✖ ${err.message.split('\n')[0]}`);
    const { screenshot, ...diagnostics } = err.diagnostics || {};
    await api('/api/worker/complete', { id: search.id, error: err.message, diagnostics: err.diagnostics ? diagnostics : null }).catch((e) =>
      log('  could not report failure:', e.message)
    );
  }
}

log(`Worker "${WORKER_NAME}" polling ${APP_URL} every ${POLL_MS / 1000}s. Ctrl+C to stop.`);
let lastError = '';
for (;;) {
  try {
    const { search } = await api('/api/worker/claim', { worker: WORKER_NAME });
    lastError = '';
    if (search) {
      await runSearch(search);
      await sleep(PAUSE_BETWEEN_SEARCHES_MS);
      continue;
    }
  } catch (err) {
    if (err.message !== lastError) log('⚠ Cannot reach app:', err.message);
    lastError = err.message;
  }
  await sleep(POLL_MS);
}
