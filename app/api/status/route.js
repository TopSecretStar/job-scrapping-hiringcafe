import { NextResponse } from 'next/server';
import { getStatus } from '../../../lib/store.js';

export const dynamic = 'force-dynamic';

// GET /api/status -> { worker: { online, lastSeen }, queued, storage }
export async function GET() {
  try {
    return NextResponse.json(await getStatus());
  } catch (err) {
    return NextResponse.json({ error: err.message, worker: { online: false } }, { status: 500 });
  }
}
