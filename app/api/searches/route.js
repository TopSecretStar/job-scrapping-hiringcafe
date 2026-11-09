import { NextResponse } from 'next/server';
import { createSearch } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

// POST /api/searches  { q, location, workplace: ["remote"], worldwide, max }
// Queues a search for the local scraper worker. Poll GET /api/searches/:id for the result.
export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const search = await createSearch(body);
    return NextResponse.json(search, { status: search.reused ? 200 : 201 });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
