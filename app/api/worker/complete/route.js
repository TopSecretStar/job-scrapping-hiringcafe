import { NextResponse } from 'next/server';
import { completeSearch } from '../../../../lib/store.js';
import { isWorker } from '../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

// Worker: POST /api/worker/complete { id, jobs, meta } or { id, error, diagnostics }
export async function POST(req) {
  if (!isWorker(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const { id, ...result } = await req.json();
    const search = await completeSearch(id, result);
    return NextResponse.json({ ok: true, status: search.status });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: err.status || 500 });
  }
}
