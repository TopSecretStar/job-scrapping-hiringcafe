'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { buildResults } from '../lib/results.js';
import { toCsv } from '../lib/parse.js';

const RECENT_KEY = 'job-scrapper:recent:v2';
const REGION_SUGGESTIONS = ['Europe', 'United Kingdom', 'North America', 'Latin America', 'Asia Pacific', 'Middle East & Africa', 'Germany', 'Netherlands', 'Spain', 'Poland'];
const WORKPLACE_OPTIONS = [
  { id: 'remote', label: 'Remote' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'onsite', label: 'On-site' },
];
const STAGE_TEXT = {
  searching: 'Searching…',
  collecting: 'Collecting jobs…',
};

const describe = (s) => [s.q, s.location, s.workplace?.join('/')].filter(Boolean).join(' · ');

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return String(v);
  // Date-only values ("2026-11-01") are UTC midnight; don't shift them a day in other time zones.
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? d.toLocaleDateString(undefined, { timeZone: 'UTC' }) : d.toLocaleDateString();
}

/** Ask the browser extension to run a search; resolves with the collected raw data. */
function runInExtension(params, onProgress, timeoutMs = 3 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
    };
    const onMessage = (e) => {
      if (e.source !== window || e.data?.source !== 'job-scrapper-ext' || e.data.id !== id) return;
      const m = e.data;
      if (m.type === 'progress') onProgress(m);
      if (m.type === 'result') { cleanup(); resolve(m); }
      if (m.type === 'error') { cleanup(); reject(Object.assign(new Error(m.error), { diagnostics: m.diagnostics })); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('The extension did not respond in time.')); }, timeoutMs);
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'job-scrapper-page', type: 'search', id, params }, window.location.origin);
  });
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [workplace, setWorkplace] = useState([]);
  const [worldwide, setWorldwide] = useState(true);
  const [max, setMax] = useState(50);
  const [loading, setLoading] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('');
  const [recent, setRecent] = useState([]);
  const [ext, setExt] = useState(null); // null = checking, false = missing, { version } = installed
  const timer = useRef(null);

  useEffect(() => {
    try { setRecent(JSON.parse(localStorage.getItem(RECENT_KEY)) || []); } catch {}

    // Detect the browser extension.
    const onMessage = (e) => {
      if (e.source === window && e.data?.source === 'job-scrapper-ext' && e.data.type === 'ready') setExt({ version: e.data.version });
    };
    window.addEventListener('message', onMessage);
    window.postMessage({ source: 'job-scrapper-page', type: 'ping' }, window.location.origin);
    const t = setTimeout(() => setExt((v) => v ?? false), 1500);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimeout(t);
    };
  }, []);

  function remember(s) {
    const next = [s, ...recent.filter((r) => describe(r).toLowerCase() !== describe(s).toLowerCase())].slice(0, 6);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch {}
  }

  function toggleWorkplace(id) {
    setWorkplace((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));
  }

  async function search(s = { q: query, location, workplace, worldwide }) {
    const q = s.q.trim();
    if (!q || loading) return;
    const loc = s.location?.trim() || '';
    const wp = s.workplace || [];
    const ww = s.worldwide ?? true;
    setQuery(q);
    setLocation(loc);
    setWorkplace(wp);
    setWorldwide(ww);
    setError(null);
    setResult(null);
    setFilter('');

    if (!ext) {
      setError({ message: 'The Job Scrapper Helper extension is not installed or not enabled for this site. See the setup steps above.' });
      return;
    }

    setLoading(true);
    setSeconds(0);
    setProgress({ stage: 'searching' });
    timer.current = setInterval(() => setSeconds((n) => n + 1), 1000);
    try {
      // With a location/workplace filter many jobs are dropped, so scan more than we show.
      const filtered = Boolean(loc || wp.length);
      const scanTarget = filtered ? Math.min(max * 5, 800) : max;
      const collected = await runInExtension({ q, scanTarget }, setProgress);
      const built = buildResults(collected, { location: loc, workplaceTypes: wp, includeWorldwide: ww, max });
      setResult({ ...built, query: q, durationMs: collected.meta?.durationMs ?? 0, source: collected.meta?.source, debug: { ...collected.meta, sampleRawJob: collected.rawJobs?.[0] ?? null } });
      remember({ q, location: loc, workplace: wp, worldwide: ww });
    } catch (e) {
      setError({ message: e.message, diagnostics: e.diagnostics });
    } finally {
      clearInterval(timer.current);
      setLoading(false);
      setProgress(null);
    }
  }

  const shown = useMemo(() => {
    if (!result) return [];
    const f = filter.trim().toLowerCase();
    if (!f) return result.jobs;
    return result.jobs.filter((j) => [j.title, j.company, j.location, j.workplace, j.commitment, j.seniority].join(' ').toLowerCase().includes(f));
  }, [result, filter]);

  const slug = (result?.query || 'jobs').toLowerCase().replace(/[^a-z0-9]+/g, '-');

  return (
    <main className="container">
      <header>
        <h1>Job Scrapper</h1>
        <p>Search Jobs and export the results.</p>
        {ext !== null && (
          <p className={`worker ${ext ? 'online' : 'offline'}`}>
            <span className="dot" />
            {ext ? `Browser extension connected (v${ext.version})` : 'Browser extension not detected'}
          </p>
        )}
      </header>

      {ext === false && (
        <section className="setup">
          <strong>One-time setup: install the Job Scrapper Helper extension</strong>
          <ol>
            <li>Download or clone this project and find its <code>extension</code> folder.</li>
            <li>In Chrome or Edge, open <code>chrome://extensions</code> and turn on <em>Developer mode</em>.</li>
            <li>Click <em>Load unpacked</em> and select the <code>extension</code> folder.</li>
            <li>Reload this page.</li>
          </ol>
          <p>Searches run quietly in the background of your own browser; no tabs or windows are opened.</p>
        </section>
      )}

      <form className="search" onSubmit={(e) => { e.preventDefault(); search(); }}>
        <div className="row">
          <label className="field">
            <span>What</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Job title or keyword, e.g. AI Engineer"
              autoFocus
            />
          </label>
          <label className="field">
            <span>Where</span>
            <input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g. Europe Remote, Germany, UK"
              list="regions"
            />
            <datalist id="regions">
              {REGION_SUGGESTIONS.map((r) => <option key={r} value={r} />)}
            </datalist>
          </label>
        </div>
        <div className="row options">
          <div className="toggles" role="group" aria-label="Workplace type">
            {WORKPLACE_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`toggle${workplace.includes(o.id) ? ' on' : ''}`}
                aria-pressed={workplace.includes(o.id)}
                onClick={() => toggleWorkplace(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          <label className="check" title="Keep jobs listed as Remote – Worldwide / Anywhere when filtering by region">
            <input type="checkbox" checked={worldwide} onChange={(e) => setWorldwide(e.target.checked)} />
            Include worldwide remote
          </label>
          <span className="spacer" />
          <select value={max} onChange={(e) => setMax(Number(e.target.value))} aria-label="Max results">
            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} results</option>)}
          </select>
          <button className="primary" type="submit" disabled={loading || !query.trim()}>
            {loading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </form>

      {recent.length > 0 && (
        <div className="recent">
          {recent.map((r) => (
            <button key={describe(r)} type="button" onClick={() => search(r)} disabled={loading}>{describe(r)}</button>
          ))}
        </div>
      )}

      {error && (
        <div className="error">
          <strong>Search failed:</strong> {error.message}
          {error.diagnostics && (
            <details>
              <summary>Details</summary>
              <pre>{JSON.stringify(error.diagnostics, null, 2)}</pre>
            </details>
          )}
        </div>
      )}

      {loading && (
        <>
          <p className="status">
            {STAGE_TEXT[progress?.stage] || 'Working…'}
            {progress?.stage === 'collecting' && progress.scanned ? ` ${progress.scanned} scanned` : ''} · {seconds}s
          </p>
          <div className="list">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)}</div>
        </>
      )}

      {result && (
        <>
          <p className="status">
            {result.count} jobs for “{result.query}”
            {result.filterActive
              ? ` in ${[result.filter.places.join(', '), result.filter.workplaceTypes.join('/')].filter(Boolean).join(' · ')} (${result.scanned} scanned)`
              : ''}
            {' · '}{(result.durationMs / 1000).toFixed(1)}s
            {result.source === 'dom' ? ' · read from page' : ''}
          </p>

          {result.count > 0 ? (
            <>
              <div className="toolbar">
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter results…" aria-label="Filter results" />
                <button type="button" onClick={() => download(`${slug}.csv`, toCsv(result.jobs), 'text/csv')}>Download CSV</button>
                <button type="button" onClick={() => download(`${slug}.json`, JSON.stringify(result.jobs, null, 2), 'application/json')}>Download JSON</button>
              </div>
              <div className="list">
                {shown.map((job) => (
                  <article key={job.id} className="card">
                    <div>
                      <h3>{job.title}</h3>
                      {job.company && <p className="company">{job.company}</p>}
                      <div className="chips">
                        {[job.location, job.workplace, job.commitment, job.seniority, job.salary, formatDate(job.postedAt)]
                          .filter(Boolean)
                          .map((c, i) => <span key={i} className="chip">{String(c)}</span>)}
                      </div>
                    </div>
                    {job.url && <a className="btn" href={job.url} target="_blank" rel="noopener noreferrer">Apply ↗</a>}
                  </article>
                ))}
                {shown.length === 0 && <p className="empty">No results match “{filter}”.</p>}
              </div>
            </>
          ) : (
            <p className="empty">
              No jobs found{result.scanned ? ` among ${result.scanned} scanned` : ''}. Try a broader location or a different keyword.
            </p>
          )}

          <details className="debug">
            <summary>Debug info</summary>
            <pre>{JSON.stringify(result.debug, null, 2)}</pre>
          </details>
        </>
      )}
    </main>
  );
}
