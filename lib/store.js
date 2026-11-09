// Search queue + results storage.
// Production (Vercel): Upstash Redis. Local dev without Redis env vars: in-memory fallback.
import { Redis } from '@upstash/redis';
import crypto from 'node:crypto';

const RESULT_TTL_S = 24 * 60 * 60; // keep searches for a day
const REUSE_WINDOW_MS = 30 * 60 * 1000; // identical search within 30 min -> reuse result
const MAX_QUEUE = 20; // refuse new searches if this many are waiting
export const WORKER_ONLINE_MS = 30 * 1000; // worker counts as online if it polled within 30s
export const STALE_RUNNING_MS = 4 * 60 * 1000; // a "running" search older than this is treated as failed

const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

function createStore() {
  if (url && token) {
    const redis = new Redis({ url, token });
    return {
      kind: 'redis',
      get: (k) => redis.get(k),
      set: (k, v, ttl) => (ttl ? redis.set(k, v, { ex: ttl }) : redis.set(k, v)),
      push: (k, v) => redis.lpush(k, v),
      pop: (k) => redis.rpop(k),
      len: (k) => redis.llen(k),
    };
  }
  if (process.env.VERCEL) {
    throw new Error(
      'No Redis configured. In Vercel: Storage → add Upstash Redis to this project (sets KV_REST_API_URL / KV_REST_API_TOKEN), then redeploy.'
    );
  }
  // Local dev only: lives in this Node process.
  const g = (globalThis.__jobStore ??= { kv: new Map(), lists: new Map() });
  return {
    kind: 'memory',
    get: async (k) => g.kv.get(k) ?? null,
    set: async (k, v) => void g.kv.set(k, v),
    push: async (k, v) => {
      const l = g.lists.get(k) ?? [];
      l.unshift(v);
      g.lists.set(k, l);
    },
    pop: async (k) => g.lists.get(k)?.pop() ?? null,
    len: async (k) => g.lists.get(k)?.length ?? 0,
  };
}

let store;
const db = () => (store ??= createStore());

const K = {
  search: (id) => `search:${id}`,
  byParams: (hash) => `search-by-params:${hash}`,
  queue: 'search-queue',
  worker: 'worker:last-seen',
};

export function normalizeParams({ q, location = '', workplace = [], worldwide = true, max = 50 }) {
  return {
    q: String(q || '').trim().slice(0, 120),
    location: String(location || '').trim().slice(0, 120),
    workplace: [...new Set((workplace || []).map((w) => String(w).toLowerCase()))].filter((w) => ['remote', 'hybrid', 'onsite'].includes(w)).sort(),
    worldwide: worldwide !== false,
    max: Math.min(Math.max(Number(max) || 50, 1), 300),
  };
}

const paramsHash = (p) => crypto.createHash('sha1').update(JSON.stringify([p.q.toLowerCase(), p.location.toLowerCase(), p.workplace, p.worldwide, p.max])).digest('hex');

/** Create (or reuse) a search. Returns the search record. */
export async function createSearch(rawParams) {
  const params = normalizeParams(rawParams);
  if (!params.q) throw Object.assign(new Error('Missing search query'), { status: 400 });

  const hash = paramsHash(params);
  const existingId = await db().get(K.byParams(hash));
  if (existingId) {
    const existing = await getSearch(existingId);
    const fresh = existing && Date.now() - existing.createdAt < REUSE_WINDOW_MS;
    if (fresh && existing.status !== 'failed') return { ...existing, reused: true };
  }

  if ((await db().len(K.queue)) >= MAX_QUEUE) {
    throw Object.assign(new Error('Too many searches are waiting. Please try again in a minute.'), { status: 429 });
  }

  const search = { id: crypto.randomUUID(), status: 'queued', params, createdAt: Date.now() };
  await db().set(K.search(search.id), search, RESULT_TTL_S);
  await db().set(K.byParams(hash), search.id, RESULT_TTL_S);
  await db().push(K.queue, search.id);
  return search;
}

export async function getSearch(id) {
  const s = await db().get(K.search(id));
  if (!s) return null;
  const search = typeof s === 'string' ? JSON.parse(s) : s;
  if (search.status === 'running' && Date.now() - search.startedAt > STALE_RUNNING_MS) {
    search.status = 'failed';
    search.error = 'The scraper worker stopped responding during this search.';
  }
  return search;
}

async function saveSearch(search) {
  await db().set(K.search(search.id), search, RESULT_TTL_S);
  return search;
}

/** Worker: take the oldest queued search and mark it running. */
export async function claimSearch(workerName) {
  await db().set(K.worker, { at: Date.now(), name: workerName || 'worker' }, RESULT_TTL_S);
  for (let i = 0; i < MAX_QUEUE; i++) {
    const id = await db().pop(K.queue);
    if (!id) return null;
    const search = await getSearch(id);
    if (!search || search.status !== 'queued') continue; // expired or already handled
    return saveSearch({ ...search, status: 'running', startedAt: Date.now() });
  }
  return null;
}

/** Worker: store the outcome. */
export async function completeSearch(id, { jobs, meta, error, diagnostics }) {
  const search = await getSearch(id);
  if (!search) throw Object.assign(new Error('Unknown search id'), { status: 404 });
  const done = { ...search, finishedAt: Date.now() };
  if (error) Object.assign(done, { status: 'failed', error: String(error).slice(0, 2000), diagnostics: diagnostics ?? null });
  else Object.assign(done, { status: 'done', jobs: (jobs || []).slice(0, 300), meta: meta ?? null });
  return saveSearch(done);
}

export async function getStatus() {
  const last = await db().get(K.worker);
  const worker = typeof last === 'string' ? JSON.parse(last) : last;
  return {
    storage: db().kind,
    queued: await db().len(K.queue),
    worker: worker ? { name: worker.name, lastSeen: worker.at, online: Date.now() - worker.at < WORKER_ONLINE_MS } : { online: false },
  };
}
