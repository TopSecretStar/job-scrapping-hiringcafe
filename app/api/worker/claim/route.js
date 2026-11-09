import { NextResponse } from 'next/server';
import { claimSearch } from '../../../../lib/store.js';
import { isWorker } from '../../../../lib/auth.js';

export const dynamic = 'force-dynamic';

// Worker: POST /api/worker/claim -> { search } or { search: null } if the queue is empty.
export async function POST(req) {
  if (!isWorker(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    return NextResponse.json({ search: await claimSearch(body.worker) });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
