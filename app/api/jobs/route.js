import { NextResponse } from 'next/server';
import { scrapeJobs } from '../../../lib/scraper.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // seconds; raise it if your Vercel plan allows longer functions

// Per-instance cache so repeat searches don't re-launch a browser.
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map();

// GET /api/jobs?q=AI%20Engineer&location=Europe&workplace=remote,hybrid&worldwide=1&max=50&debug=1
// `location` also accepts free text like "Europe Remote".
export async function GET(req) {
  const params = req.nextUrl.searchParams;
  const q = (params.get('q') || '').trim();
  const location = (params.get('location') || '').trim();
  const workplaceTypes = (params.get('workplace') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const includeWorldwide = params.get('worldwide') !== '0';
  const max = Math.min(Math.max(Number(params.get('max')) || 50, 1), 300);
  const debug = params.get('debug') === '1';
  if (!q) return NextResponse.json({ error: 'Missing ?q= search query' }, { status: 400 });

  const key = JSON.stringify([q.toLowerCase(), location.toLowerCase(), [...workplaceTypes].sort(), includeWorldwide, max]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS && !debug) {
    return NextResponse.json({ ...hit.body, cached: true });
  }

  try {
    const { jobs, meta } = await scrapeJobs({
      query: q,
      location,
      workplaceTypes,
      includeWorldwide,
      maxJobs: max,
      timeBudgetMs: (maxDuration - 18) * 1000,
      screenshotOnError: debug,
    });
    const body = {
      query: q,
      filter: meta.filter,
      count: jobs.length,
      scanned: meta.scanned,
      source: meta.source,
      durationMs: meta.durationMs,
      jobs,
      ...(debug
        ? { debug: { apiUrls: meta.apiUrls, siteFilters: meta.siteFilters, searchRequest: meta.searchRequest, firstRawJob: meta.firstRawJob } }
        : {}),
    };
    cache.set(key, { at: Date.now(), body });
    return NextResponse.json({ ...body, cached: false });
  } catch (err) {
    console.error('[api/jobs]', err);
    return NextResponse.json(
      { error: err.message || 'Scrape failed', ...(err.diagnostics ? { diagnostics: err.diagnostics } : {}) },
      { status: err.diagnostics?.blockedByCloudflare ? 502 : 500 }
    );
  }
}
