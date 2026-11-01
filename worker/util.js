// Small helpers shared by the presets hub Worker.

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(status, message) {
  return json({ error: message }, status);
}

/** URL-safe random string with `bytes` bytes of entropy. */
export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Strip control characters, collapse whitespace, trim and cap the length. */
export function cleanText(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  let s = value.normalize('NFC').replace(multiline ? /[\u0000-\u0009\u000B-\u001F\u007F]/g : /[\u0000-\u001F\u007F]/g, ' ');
  s = multiline ? s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim().slice(0, max).trim();
}

/**
 * Sliding-window rate limit backed by D1. Records the event and returns true
 * when the caller is under `max` events in the last `windowMs`.
 */
export async function rateLimit(db, key, max, windowMs, now) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND at > ?').bind(key, now - windowMs).first();
  if ((row?.n ?? 0) >= max) return false;
  await db.prepare('INSERT INTO rate_events (key, at) VALUES (?, ?)').bind(key, now).run();
  return true;
}

/** A stable, non-reversible key for the client's IP address (for rate limits and reports). */
export async function clientKey(request, env) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  return `ip:${(await sha256(`${env.IP_HASH_SALT || 'kindling'}:${ip}`)).slice(0, 32)}`;
}
