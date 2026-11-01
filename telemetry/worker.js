// Cloudflare Worker that receives anonymous error reports from the apps
// (src/app/telemetry.js) and writes them to Workers Logs, where they can be
// queried in the dashboard (Workers & Pages -> kindling-errors -> Observability).
//
// Privacy: only the validated, re-scrubbed report is logged. The request's IP,
// headers, user agent and `request.cf` (location, ASN) are never read or logged,
// and wrangler.jsonc turns off invocation logs and traces for this Worker,
// because Cloudflare would otherwise record user agent, location and request
// metadata automatically. See docs/TELEMETRY.md.

import { sanitizeReport, fingerprint } from '../src/app/telemetry.js';

const MAX_BODY = 8 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export async function handle(request, log = console) {
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

  // One structured log line per report; Workers Logs indexes each field.
  log.error({ event: 'client_error', fingerprint: await fingerprint(report), ...report });
  return new Response(null, { status: 204, headers: CORS });
}

async function readLimited(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (declared > max) return null;
  const buf = await request.arrayBuffer();
  if (buf.byteLength > max) return null;
  return new TextDecoder().decode(buf);
}

export default {
  fetch: (request) => handle(request),
};
