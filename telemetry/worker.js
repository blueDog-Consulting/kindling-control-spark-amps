// Cloudflare Worker that receives anonymous error reports from the apps
// (src/app/telemetry.js) and writes them to Workers Logs, where they can be
// queried in the dashboard (Workers & Pages -> kindling-errors -> Observability).
//
// With a D1 database bound as DB, it also counts each distinct error (by
// fingerprint) and, once ISSUE_THRESHOLD installs have hit it, opens a GitHub
// issue labelled `error-report` (needs the GITHUB_TOKEN secret). That label
// starts the auto-fix workflow (.github/workflows/autofix.yml).
//
// Privacy: only the validated, re-scrubbed report is logged or stored. The
// request's IP, headers, user agent and `request.cf` (location, ASN) are never
// read, and wrangler.jsonc turns off invocation logs and traces for this Worker,
// because Cloudflare would otherwise record user agent, location and request
// metadata automatically. "Installs" are counted without ids: each app sends
// first = true only the first time it reports a given error. See docs/TELEMETRY.md.

import { sanitizeReport, fingerprint } from '../src/app/telemetry.js';

const MAX_BODY = 8 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};
export const ISSUE_LABEL = 'error-report';

export async function handle(request, env = {}, ctx = { waitUntil: () => {} }, log = console) {
  const { pathname } = new URL(request.url);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (pathname !== '/v1/report') return new Response('not found', { status: 404, headers: CORS });
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405, headers: { ...CORS, Allow: 'POST' } });

  const body = await readLimited(request, MAX_BODY);
  if (body == null) return new Response('too large', { status: 413, headers: CORS });
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    return new Response('bad json', { status: 400, headers: CORS });
  }
  const report = sanitizeReport(input);
  if (!report) return new Response('bad report', { status: 400, headers: CORS });

  const fp = await fingerprint(report);
  // One structured log line per report; Workers Logs indexes each field.
  log.error({ event: 'client_error', fingerprint: fp, ...report });
  if (env.DB) ctx.waitUntil(track(env, fp, report, log).catch((err) => log.warn({ event: 'track_failed', fingerprint: fp, error: String(err?.message ?? err) })));
  return new Response(null, { status: 204, headers: CORS });
}

/** Count the report in D1 and open a GitHub issue when enough installs have hit it. */
export async function track(env, fp, report, log = console, today = new Date().toISOString().slice(0, 10)) {
  const app = report.os ? `${report.app}/${report.os}` : report.app;
  const row = await env.DB.prepare(
    `INSERT INTO errors (fingerprint, installs, reports, first_seen, last_seen, first_version, last_version, apps, name, message, stack, "where")
     VALUES (?1, ?2, 1, ?3, ?3, ?4, ?4, ?5, ?6, ?7, ?8, ?9)
     ON CONFLICT(fingerprint) DO UPDATE SET
       installs = installs + excluded.installs,
       reports = reports + 1,
       last_seen = excluded.last_seen,
       last_version = excluded.last_version,
       apps = CASE WHEN instr(',' || apps || ',', ',' || excluded.apps || ',') > 0 THEN apps ELSE apps || ',' || excluded.apps END
     RETURNING installs, reports, apps, first_version, last_version, issue_number, issue_state`,
  )
    .bind(fp, report.first ? 1 : 0, today, report.version, app, report.name, report.message, report.stack ?? null, report.where ?? null)
    .first();

  const threshold = Number(env.ISSUE_THRESHOLD ?? 2);
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO || !(threshold > 0)) return { row, issue: null };
  if (row.installs < threshold || row.issue_state) return { row, issue: null };

  // Cap new issues per day, so a flood of (possibly forged) reports can't flood the tracker.
  const { n } = await env.DB.prepare('SELECT count(*) AS n FROM errors WHERE issue_created = ?1').bind(today).first();
  if (n >= Number(env.MAX_ISSUES_PER_DAY ?? 5)) return { row, issue: null };

  // Claim the row so concurrent reports don't open the same issue twice.
  const claim = await env.DB.prepare(
    "UPDATE errors SET issue_state = 'creating', issue_created = ?2 WHERE fingerprint = ?1 AND issue_state IS NULL",
  )
    .bind(fp, today)
    .run();
  if (claim.meta?.changes !== 1) return { row, issue: null };

  try {
    const issue = await createIssue(env, fp, report, row);
    await env.DB.prepare("UPDATE errors SET issue_number = ?2, issue_state = 'open' WHERE fingerprint = ?1").bind(fp, issue.number).run();
    log.log({ event: 'issue_created', fingerprint: fp, issue: issue.number });
    return { row, issue };
  } catch (err) {
    await env.DB.prepare('UPDATE errors SET issue_state = NULL, issue_created = NULL WHERE fingerprint = ?1').bind(fp).run();
    throw err;
  }
}

/** The issue: only the sanitised report and counts. The JSON block is what the auto-fix workflow reads. */
export function issueBody(fp, report, row) {
  const data = { fingerprint: fp, name: report.name, message: report.message, where: report.where ?? null, stack: report.stack ?? null };
  return [
    'Automatically opened from anonymous error reports (see `docs/TELEMETRY.md`).',
    '',
    '| | |',
    '|---|---|',
    `| Installs affected | ${row.installs} (${row.reports} reports) |`,
    `| Apps | ${row.apps} |`,
    `| Versions | first seen ${row.first_version}, latest ${row.last_version} |`,
    `| Where | \`${report.where ?? 'uncaught'}\` |`,
    `| Fingerprint | \`${fp}\` |`,
    '',
    'Look it up in Cloudflare: Workers & Pages → kindling-errors → Observability, filter `fingerprint = ' + fp + '`.',
    '',
    '<!-- error-report -->',
    '```json',
    JSON.stringify(data, null, 2),
    '```',
  ].join('\n');
}

async function createIssue(env, fp, report, row) {
  const title = `[error] ${report.name}: ${report.message}`.slice(0, 120);
  const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'kindling-errors-worker',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ title, body: issueBody(fp, report, row), labels: [ISSUE_LABEL] }),
  });
  if (!res.ok) throw new Error(`GitHub issue creation failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function readLimited(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > max) return null;
  return new TextDecoder().decode(buf);
}

export default {
  fetch: (request, env, ctx) => handle(request, env, ctx),
};
