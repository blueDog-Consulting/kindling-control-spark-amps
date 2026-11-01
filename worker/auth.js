// Email magic-link sign-in and cookie sessions for the presets hub.
//
// Flow: POST /api/auth/request {email} emails a one-time link to
// /presets/signin.html#token=…  The token sits in the URL fragment, so it never
// reaches the server in a GET (link scanners in mail clients can't spend it);
// the page POSTs it to /api/auth/verify when the person clicks "Finish signing in".
// Tokens and session ids are stored only as SHA-256 hashes.

import { HttpError, randomToken, sha256 } from './util.js';

export const LINK_TTL_MS = 15 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const COOKIE = 'kc_session';

export function normaliseEmail(value) {
  const e = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (e.length > 254 || !/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/.test(e)) return null;
  return e;
}

/** Creates a sign-in token for `email` and returns the link to send. */
export async function createSignInLink(env, origin, email, now) {
  const token = randomToken(32);
  await env.DB.prepare('INSERT INTO login_tokens (token_hash, email, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(token), email, now + LINK_TTL_MS)
    .run();
  return `${origin}/presets/signin.html#token=${token}`;
}

/** Spends a sign-in token. Returns the session cookie value, or throws 400. */
export async function redeemSignInLink(env, token, now) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new HttpError(400, 'That sign-in link is not valid.');
  const row = await env.DB.prepare(
    'UPDATE login_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING email',
  )
    .bind(now, await sha256(token), now)
    .first();
  if (!row) throw new HttpError(400, 'That sign-in link has expired or was already used. Ask for a new one.');

  await env.DB.prepare('INSERT OR IGNORE INTO users (id, email, display_name, created_at) VALUES (?, ?, ?, ?)')
    .bind(randomToken(12), row.email, `Player ${randomToken(3).replace(/[-_]/g, 'x')}`, now)
    .run();
  const user = await env.DB.prepare('SELECT id, banned FROM users WHERE email = ?').bind(row.email).first();
  if (!user || user.banned) throw new HttpError(403, 'This account has been suspended.');

  const session = randomToken(32);
  await env.DB.prepare('INSERT INTO sessions (id_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(await sha256(session), user.id, now + SESSION_TTL_MS)
    .run();
  return session;
}

export function sessionCookie(value, maxAgeMs = SESSION_TTL_MS) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}`;
}

function readCookie(request) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/** The signed-in user for this request, or null. */
export async function currentUser(env, request, now) {
  const value = readCookie(request);
  if (!value || value.length > 100) return null;
  const user = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name AS displayName, u.banned
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ? AND s.expires_at > ?`,
  )
    .bind(await sha256(value), now)
    .first();
  if (!user || user.banned) return null;
  return { id: user.id, email: user.email, displayName: user.displayName, isAdmin: isAdmin(env, user.email) };
}

export async function endSession(env, request) {
  const value = readCookie(request);
  if (value) await env.DB.prepare('DELETE FROM sessions WHERE id_hash = ?').bind(await sha256(value)).run();
}

export function isAdmin(env, email) {
  return String(env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email);
}
