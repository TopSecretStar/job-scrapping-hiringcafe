import { NextResponse } from 'next/server';
import { getSearch } from '../../../../lib/store.js';

export const dynamic = 'force-dynamic';

export async function GET(_req, { params }) {
  try {
    const { id } = await params;
    const search = await getSearch(id);
    if (!search) return NextResponse.json({ error: 'Search not found (it may have expired).' }, { status: 404 });
    return NextResponse.json(search);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
