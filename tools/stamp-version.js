#!/usr/bin/env node
// Writes the release version into src/version.js so the apps know which build
// they are (used in anonymous error reports). Run by .github/workflows/release.yml
// before `cap sync` and electron-builder; don't commit the stamped file.
//
//   node tools/stamp-version.js 0.3.0

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function stamp(source, version) {
  if (!VERSION_RE.test(version)) throw new Error(`"${version}" is not a version like 1.2.3 or 1.2.3-beta.1`);
  const out = source.replace(/export const VERSION = '[^']*';/, `export const VERSION = '${version}';`);
  if (out === source && !source.includes(`'${version}'`)) throw new Error('VERSION line not found in src/version.js');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = fileURLToPath(new URL('../src/version.js', import.meta.url));
  const version = String(process.argv[2] ?? '').replace(/^v/, '');
  writeFileSync(file, stamp(readFileSync(file, 'utf8'), version));
  console.log(`src/version.js -> ${version}`);
}
