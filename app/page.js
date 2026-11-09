'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const RECENT_KEY = 'job-scrapper:recent:v2';
const REGION_SUGGESTIONS = ['Europe', 'United Kingdom', 'North America', 'Latin America', 'Asia Pacific', 'Middle East & Africa', 'Germany', 'Netherlands', 'Spain', 'Poland'];
const WORKPLACE_OPTIONS = [
  { id: 'remote', label: 'Remote' },
  { id: 'hybrid', label: 'Hybrid' },
  { id: 'onsite', label: 'On-site' },
];

const describe = (s) => [s.q, s.location, s.workplace?.join('/')].filter(Boolean).join(' · ');

function toCsv(jobs) {
  if (!jobs.length) return '';
  const cols = [...new Set(jobs.flatMap(Object.keys))];
  const esc = (v) => {
    const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...jobs.map((j) => cols.map((c) => esc(j[c])).join(','))].join('\n');
}

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Shape a stored search record for display. */
function toResult(s) {
  return {
    id: s.id,
    query: s.params.q,
    filter: s.meta?.filter ?? null,
    count: s.jobs?.length ?? 0,
    scanned: s.meta?.scanned ?? 0,
    durationMs: s.meta?.durationMs ?? 0,
    source: s.meta?.source,
    cached: !!s.reused,
    jobs: s.jobs ?? [],
  };
}

function formatDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toLocaleDateString();
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [location, setLocation] = useState('');
  const [workplace, setWorkplace] = useState([]);
  const [worldwide, setWorldwide] = useState(true);
  const [max, setMax] = useState(50);
  const [loading, setLoading] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [filter, setFilter] = useState('');
  const [recent, setRecent] = useState([]);
  const [phase, setPhase] = useState(''); // queued | running
  const [worker, setWorker] = useState(null); // { online, lastSeen } | null while unknown
  const timer = useRef(null);
  const runId = useRef(0);

  useEffect(() => {
    try { setRecent(JSON.parse(localStorage.getItem(RECENT_KEY)) || []); } catch {}
    // Open a shared search link: /?s=<id>
    const id = new URLSearchParams(window.location.search).get('s');
    if (id) {
      fetch(`/api/searches/${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((s) => {
          if (s.status === 'done') {
            setQuery(s.params.q);
            setLocation(s.params.location);
            setWorkplace(s.params.workplace);
            setWorldwide(s.params.worldwide);
            setResult(toResult(s));
          }
        })
        .catch(() => {});
    }
    // Worker online indicator.
    const check = () =>
      fetch('/api/status').then((r) => r.json()).then((d) => setWorker(d.worker ?? { online: false })).catch(() => {});
    check();
    const t = setInterval(check, 15000);
    return () => clearInterval(t);
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
    setQuery(q);
    setLocation(s.location || '');
    setWorkplace(s.workplace || []);
    setWorldwide(s.worldwide ?? true);
    setLoading(true);
    setError(null);
    setResult(null);
    setFilter('');
    setSeconds(0);
    setPhase('queued');
    timer.current = setInterval(() => setSeconds((s) => s + 1), 1000);
    const myRun = ++runId.current;
    try {
      const res = await fetch('/api/searches', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ q, location: s.location?.trim() || '', workplace: s.workplace || [], worldwide: s.worldwide ?? true, max }),
      });
      let search = await res.json().catch(() => ({ error: `Server returned ${res.status}` }));
      if (!res.ok) throw new Error(search.error || `Request failed (${res.status})`);
      const reused = !!search.reused;

      // Poll until the local worker has finished (up to 10 minutes).
      const deadline = Date.now() + 10 * 60 * 1000;
      while (search.status === 'queued' || search.status === 'running') {
        if (myRun !== runId.current) return; // a newer search replaced this one
        if (Date.now() > deadline) throw new Error('Timed out waiting for the scraper worker. Is `npm run worker` running?');
        setPhase(search.status);
        await sleep(2000);
        const r = await fetch(`/api/searches/${search.id}`);
        search = await r.json();
        if (!r.ok) throw new Error(search.error || `Request failed (${r.status})`);
      }
      if (search.status === 'failed') {
        throw Object.assign(new Error(search.error || 'Search failed'), { diagnostics: search.diagnostics });
      }
      setResult(toResult({ ...search, reused }));
      window.history.replaceState(null, '', `?s=${search.id}`);
      remember({ q, location: s.location?.trim() || '', workplace: s.workplace || [], worldwide: s.worldwide ?? true });
    } catch (e) {
      setError({ message: e.message, diagnostics: e.diagnostics });
    } finally {
      if (myRun === runId.current) {
        clearInterval(timer.current);
        setLoading(false);
        setPhase('');
      }
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
        {worker && (
          <p className={`worker ${worker.online ? 'online' : 'offline'}`}>
            <span className="dot" />
            {worker.online ? 'Scraper online' : 'Scraper offline: searches will wait until `npm run worker` is running'}
          </p>
        )}
      </header>

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
              <summary>What the scraper&apos;s browser saw</summary>
              <pre>{JSON.stringify({ ...error.diagnostics, screenshot: error.diagnostics.screenshot ? '(below)' : undefined }, null, 2)}</pre>
              {error.diagnostics.screenshot && <img src={error.diagnostics.screenshot} alt="Server browser screenshot" />}
            </details>
          )}
        </div>
      )}

      {loading && (
        <>
          <p className="status">
            {phase === 'running'
              ? `Opening Job Site and collecting jobs… ${seconds}s (this usually takes 15–60s)`
              : worker && !worker.online
                ? `Queued… ${seconds}s. The scraper is offline; start it with \`npm run worker\`.`
                : `Queued, waiting for the scraper… ${seconds}s`}
          </p>
          <div className="list">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" />)}</div>
        </>
      )}

      {result && (
        <>
          <p className="status">
            {result.count} jobs for “{result.query}”
            {result.filter && (result.filter.places.length || result.filter.workplaceTypes.length)
              ? ` in ${[result.filter.places.join(', '), result.filter.workplaceTypes.join('/')].filter(Boolean).join(' · ')} (${result.scanned} scanned)`
              : ''}
            {' · '}{(result.durationMs / 1000).toFixed(1)}s
            {result.cached ? ' · cached' : ''}{result.source === 'dom' ? ' · read from page' : ''}
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
        </>
      )}
    </main>
  );
}
