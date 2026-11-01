#!/usr/bin/env node
// Builds the website for kindlingspark.app into site-dist/:
//   /           the landing page and the presets hub pages (site/)
//   /guide/     the user guide (src/guide/), the same file the apps show under Help
//   /icon.svg, /icons/   app icons (src/)
// The web app itself is deliberately not published: people install the desktop or
// Android app. Developers run it from source with `npm run serve`.
// The presets API is the Worker in worker/ (see wrangler.jsonc).
//
//   npm run site        # then: npm run site:dev  (site + API on http://localhost:8788)

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}site-dist`;

rmSync(out, { recursive: true, force: true });
cpSync(`${root}site`, out, { recursive: true });
cpSync(`${root}src/guide`, `${out}/guide`, { recursive: true });
cpSync(`${root}src/icon.svg`, `${out}/icon.svg`);
cpSync(`${root}src/icons`, `${out}/icons`, { recursive: true });

// On the website the guide's header links back to the landing page, not to the app.
const guide = `${out}/guide/index.html`;
const html = readFileSync(guide, 'utf8');
const patched = html.replace('<a class="back" href="../">Open the app →</a>', '<a class="back" href="../">← Home</a>');
if (patched === html) throw new Error('build-site: guide header link not found; update tools/build-site.js');
writeFileSync(guide, patched);

for (const f of ['index.html', 'guide/index.html', 'presets/index.html']) {
  if (!existsSync(`${out}/${f}`)) throw new Error(`build-site: missing ${f}`);
}
if (existsSync(`${out}/app`)) throw new Error('build-site: the web app must not be published');
console.log('build-site: site-dist/ = site/ + guide at /guide/ (no web app)');
