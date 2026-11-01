// JSON API for the presets hub (everything under /api/). See docs/PRESETS.md.

import {
  COOKIE,
  createSignInLink,
  currentUser,
  endSession,
  normaliseEmail,
  redeemSignInLink,
  sessionCookie,
} from './auth.js';
import { sendSignInEmail } from './mail.js';
import { MAX_UPLOAD_BYTES, normalisePreset } from './preset.js';
import { HttpError, cleanText, clientKey, errorResponse, json, randomToken, rateLimit } from './util.js';

const PAGE_SIZE = 24;
const MAX_PAGE = 100;
const REPORTS_TO_HIDE = 3;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export async function handleApi(request, env, ctx, now = Date.now()) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  try {
    if (method !== 'GET' && method !== 'HEAD') checkWriteRequest(request, env);
    const origin = siteOrigin(env, url);

    // ---- auth
    if (path === '/api/auth/request' && method === 'POST') return await requestSignIn(request, env, origin, now);
    if (path === '/api/auth/verify' && method === 'POST') {
      const { token } = await readJson(request);
      const session = await redeemSignInLink(env, token, now);
      return json({ ok: true }, 200, { 'set-cookie': sessionCookie(session) });
    }
    if (path === '/api/auth/logout' && method === 'POST') {
      await endSession(env, request);
      return json({ ok: true }, 200, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }

    // ---- the signed-in person
    if (path === '/api/me' && method === 'GET') {
      const user = await currentUser(env, request, now);
      return json({ user: user && { email: user.email, displayName: user.displayName, isAdmin: user.isAdmin } });
    }
    if (path === '/api/me' && method === 'PATCH') {
      const user = await requireUser(env, request, now);
      const { displayName } = await readJson(request);
      const name = cleanText(displayName, 40);
      if (name.length < 2) throw new HttpError(400, 'Pick a display name of at least 2 characters.');
      await env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(name, user.id).run();
      return json({ ok: true, displayName: name });
    }
    if (path === '/api/me/presets' && method === 'GET') {
      const user = await requireUser(env, request, now);
      const { results } = await env.DB.prepare(
        `SELECT id, name, description, amp, downloads, hidden, created_at AS createdAt
           FROM presets WHERE user_id = ? ORDER BY created_at DESC LIMIT 200`,
      )
        .bind(user.id)
        .all();
      return json({ items: results.map((r) => ({ ...r, hidden: !!r.hidden })) });
    }

    // ---- presets
    if (path === '/api/presets' && method === 'GET') return await listPresets(env, url);
    if (path === '/api/presets' && method === 'POST') return await createPreset(request, env, now);

    const m = /^\/api\/presets\/([A-Za-z0-9_-]{6,32})(?:\/(download|report|restore))?$/.exec(path);
    if (m) {
      const [, id, action] = m;
      if (!action && method === 'GET') return await getPreset(env, request, id, now);
      if (!action && method === 'DELETE') return await deletePreset(env, request, id, now);
      if (action === 'download' && method === 'GET') return await downloadPreset(env, id);
      if (action === 'report' && method === 'POST') return await reportPreset(env, request, id, now);
      if (action === 'restore' && method === 'POST') return await restorePreset(env, request, id, now);
    }

    // ---- moderation
    if (path === '/api/admin/hidden' && method === 'GET') {
      await requireAdmin(env, request, now);
      const { results } = await env.DB.prepare(
        `SELECT p.id, p.name, p.amp, u.display_name AS author, p.created_at AS createdAt,
                (SELECT COUNT(*) FROM reports r WHERE r.preset_id = p.id) AS reports,
                (SELECT GROUP_CONCAT(reason, ' | ') FROM reports r WHERE r.preset_id = p.id) AS reasons
           FROM presets p JOIN users u ON u.id = p.user_id
          WHERE p.hidden = 1 ORDER BY p.created_at DESC LIMIT 200`,
      ).all();
      return json({ items: results });
    }

    return errorResponse(404, 'Not found.');
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err.status, err.message);
    console.error(err);
    return errorResponse(500, 'Something went wrong. Please try again.');
  }
}

// ---------------------------------------------------------------------------- handlers

async function requestSignIn(request, env, origin, now) {
  const { email: raw } = await readJson(request);
  const email = normaliseEmail(raw);
  if (!email) throw new HttpError(400, 'Enter a valid email address.');
  const ipOk = await rateLimit(env.DB, `signin:${await clientKey(request, env)}`, 10, HOUR, now);
  const emailOk = ipOk && (await rateLimit(env.DB, `signin:${email}`, 5, HOUR, now));
  if (!ipOk || !emailOk) throw new HttpError(429, 'Too many sign-in emails. Wait a while and try again.');
  const link = await createSignInLink(env, origin, email, now);
  const sent = await sendSignInEmail(env, email, link);
  // Same answer whether or not the address has an account.
  return json({ ok: true, ...(sent.devLink ? { devLink: sent.devLink } : {}) });
}

async function listPresets(env, url) {
  const q = cleanText(url.searchParams.get('q') ?? '', 64);
  const amp = cleanText(url.searchParams.get('amp') ?? '', 64);
  const sort = url.searchParams.get('sort') === 'popular' ? 'p.downloads DESC, p.created_at DESC' : 'p.created_at DESC';
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1));

  const where = ['p.hidden = 0', 'u.banned = 0'];
  const args = [];
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push("(p.name LIKE ? ESCAPE '\\' OR p.description LIKE ? ESCAPE '\\' OR p.amp LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')");
    args.push(like, like, like, like);
  }
  if (amp) {
    where.push('p.amp = ?');
    args.push(amp);
  }
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.amp, p.chain, p.downloads, p.created_at AS createdAt, u.display_name AS author
       FROM presets p JOIN users u ON u.id = p.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${sort}
      LIMIT ? OFFSET ?`,
  )
    .bind(...args, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE)
    .all();
  const items = results.slice(0, PAGE_SIZE).map(publicPreset);
  return json({ items, page, hasMore: results.length > PAGE_SIZE }); // no-store: a just-shared preset must show up
}

async function getPreset(env, request, id, now) {
  const row = await env.DB.prepare(
    `SELECT p.id, p.user_id, p.name, p.description, p.amp, p.chain, p.downloads, p.hidden, p.created_at AS createdAt,
            u.display_name AS author, u.banned
       FROM presets p JOIN users u ON u.id = p.user_id WHERE p.id = ?`,
  )
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, 'That preset is not here any more.');
  const user = await currentUser(env, request, now);
  const canManage = !!user && (user.id === row.user_id || user.isAdmin);
  if ((row.hidden || row.banned) && !canManage) throw new HttpError(404, 'That preset is not here any more.');
  return json({ ...publicPreset(row), hidden: !!row.hidden, canManage, isAdmin: !!user?.isAdmin });
}

async function downloadPreset(env, id) {
  const row = await env.DB.prepare(
    'SELECT p.name, p.preset_json FROM presets p JOIN users u ON u.id = p.user_id WHERE p.id = ? AND p.hidden = 0 AND u.banned = 0',
  )
    .bind(id)
    .first();
  if (!row) throw new HttpError(404, 'That preset is not here any more.');
  await env.DB.prepare('UPDATE presets SET downloads = downloads + 1 WHERE id = ?').bind(id).run();
  const file = `${row.name.replace(/[^\w.-]+/g, '_') || 'preset'}.json`;
  return new Response(JSON.stringify(JSON.parse(row.preset_json), null, 2), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${file}"`,
      'cache-control': 'no-store',
      'access-control-allow-origin': '*', // lets the apps fetch shared presets
    },
  });
}

async function createPreset(request, env, now) {
  const user = await requireUser(env, request, now);
  const body = await readJson(request, MAX_UPLOAD_BYTES + 4096);
  if (body.license !== true) throw new HttpError(400, 'Please agree to share the preset under CC0 before uploading.');
  const { preset, name, amp, chain } = normalisePreset(body.preset);
  const description = cleanText(body.description, 500, { multiline: true });
  if (!(await rateLimit(env.DB, `upload:${user.id}`, 20, DAY, now))) {
    throw new HttpError(429, "You've shared a lot of presets today. Try again tomorrow.");
  }
  const id = randomToken(9);
  await env.DB.prepare(
    `INSERT INTO presets (id, user_id, name, description, amp, chain, preset_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, user.id, name, description, amp, JSON.stringify(chain), JSON.stringify(preset), now)
    .run();
  return json({ ok: true, id }, 201);
}

async function deletePreset(env, request, id, now) {
  const user = await requireUser(env, request, now);
  const row = await env.DB.prepare('SELECT user_id FROM presets WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'That preset is not here any more.');
  if (row.user_id !== user.id && !user.isAdmin) throw new HttpError(403, 'You can only delete your own presets.');
  await env.DB.prepare('DELETE FROM reports WHERE preset_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM presets WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function reportPreset(env, request, id, now) {
  const { reason } = await readJson(request);
  const user = await currentUser(env, request, now);
  const reporter = user ? `user:${user.id}` : await clientKey(request, env);
  if (!(await rateLimit(env.DB, `report:${reporter}`, 20, HOUR, now))) throw new HttpError(429, 'Too many reports. Try again later.');
  const exists = await env.DB.prepare('SELECT id FROM presets WHERE id = ? AND hidden = 0').bind(id).first();
  if (!exists) throw new HttpError(404, 'That preset is not here any more.');
  await env.DB.prepare('INSERT OR IGNORE INTO reports (preset_id, reporter, reason, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, reporter, cleanText(reason, 300), now)
    .run();
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE preset_id = ?').bind(id).first();
  if (n >= REPORTS_TO_HIDE) await env.DB.prepare('UPDATE presets SET hidden = 1 WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function restorePreset(env, request, id, now) {
  await requireAdmin(env, request, now);
  await env.DB.prepare('DELETE FROM reports WHERE preset_id = ?').bind(id).run();
  await env.DB.prepare('UPDATE presets SET hidden = 0 WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

/** Housekeeping, run daily by the cron trigger. */
export async function cleanup(db, now) {
  await db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(now - DAY).run();
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  await db.prepare('DELETE FROM rate_events WHERE at < ?').bind(now - 2 * DAY).run();
}

// ---------------------------------------------------------------------------- helpers

function publicPreset(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    amp: row.amp,
    chain: JSON.parse(row.chain),
    downloads: row.downloads,
    createdAt: row.createdAt,
    author: row.author,
  };
}

async function requireUser(env, request, now) {
  const user = await currentUser(env, request, now);
  if (!user) throw new HttpError(401, 'Sign in first.');
  return user;
}

async function requireAdmin(env, request, now) {
  const user = await requireUser(env, request, now);
  if (!user.isAdmin) throw new HttpError(403, 'Moderators only.');
  return user;
}

/**
 * Writes must be same-origin JSON: browsers can't send a cross-site
 * application/json request without a CORS preflight, which we never approve.
 */
function checkWriteRequest(request, env) {
  const type = request.headers.get('content-type') || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const origin = request.headers.get('origin');
  if (origin && origin !== siteOrigin(env, new URL(request.url))) throw new HttpError(403, 'Cross-site request refused.');
}

function siteOrigin(env, url) {
  return env.SITE_ORIGIN || url.origin;
}

async function readJson(request, maxBytes = 8192) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'That upload is too large.');
  try {
    const data = JSON.parse(text || '{}');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
    return data;
  } catch {
    throw new HttpError(400, 'Could not read the request.');
  }
}
