#!/usr/bin/env node
// Local preview of kindlingspark.app: the built site (site-dist/) plus the presets
// API (worker/) running against an in-memory SQLite database. No wrangler or
// Cloudflare account needed. Sign-in links are shown on the page instead of emailed.
//
//   npm run site:dev            # builds site-dist/, then serves http://localhost:8788
//   node tools/serve-site.js [port]
//
// Data is lost when the server stops. For a closer match to production, use
// `npx wrangler dev` with a local D1 database (see docs/PRESETS.md).
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../worker/index.js';
import { createD1 } from './d1-sqlite.js';

const root = fileURLToPath(new URL('../site-dist/', import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8788);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

// Apply site/_headers locally too, so CSP problems show up before deploying.
const headerRules = parseHeaders(await readFile(join(root, '_headers'), 'utf8').catch(() => ''));
function parseHeaders(text) {
  const rules = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) rules.push({ re: new RegExp(`^${line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`), headers: {} });
    else if (rules.length) {
      const i = line.indexOf(':');
      rules.at(-1).headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}
const headersFor = (path) => Object.assign({}, ...headerRules.filter((r) => r.re.test(path)).map((r) => r.headers));

async function asset(request) {
  try {
    const path = normalize(decodeURIComponent(new URL(request.url).pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root)) throw new Error('forbidden');
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const headers = { ...headersFor(new URL(request.url).pathname), 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' };
    return new Response(await readFile(file), { headers });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

const env = {
  DB: createD1(),
  ASSETS: { fetch: asset },
  DEV_SHOW_LINKS: '1',
  ADMIN_EMAILS: process.env.ADMIN_EMAILS || 'admin@localhost.test',
};
const ctx = { waitUntil() {} };

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const request = new Request(`http://localhost:${port}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
  const response = await worker.fetch(request, env, ctx);
  const headers = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => console.log(`kindlingspark.app preview on http://localhost:${port}  (presets API with an in-memory database; moderator: ${env.ADMIN_EMAILS})`));
