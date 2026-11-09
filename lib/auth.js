import crypto from 'node:crypto';

/** Worker endpoints require `Authorization: Bearer <WORKER_TOKEN>`. */
export function isWorker(req) {
  const expected = process.env.WORKER_TOKEN;
  if (!expected) return false;
  const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
