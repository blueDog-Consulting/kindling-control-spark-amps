#!/usr/bin/env node
// Zero-dependency static server for local development:
//   node tools/serve.js [port] [dir]     dir defaults to src/ (the app)
// Web Bluetooth works on http://localhost (a secure context). On a phone the
// browser requires HTTPS, so use a tunnel, or the Android app.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL(`../${(process.argv[3] || 'src').replace(/\/?$/, '/')}`, import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8787);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };

createServer(async (req, res) => {
  try {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root)) throw new Error('forbidden');
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(process.argv[3] ? `serving ${process.argv[3]} on http://localhost:${port}` : `KindlingControl on http://localhost:${port}  (simulated amp: http://localhost:${port}/?mock)`));
