#!/usr/bin/env node
// Builds the deployable website into site-dist/:
//   /       the landing page (site/)
//   /app/   the web app (src/)
// The desktop and mobile apps use src/ directly and don't need this.
//
//   npm run site    # then: npm run serve -- 8788 site-dist

import { cpSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = `${root}site-dist`;

rmSync(out, { recursive: true, force: true });
cpSync(`${root}site`, out, { recursive: true });
cpSync(`${root}src`, `${out}/app`, { recursive: true });
if (!existsSync(`${out}/app/index.html`) || !existsSync(`${out}/index.html`)) throw new Error('build-site: missing index.html');
console.log('build-site: site-dist/ = site/ (landing page) + src/ at /app/');
