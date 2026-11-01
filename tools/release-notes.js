#!/usr/bin/env node
// Versioned store release notes ("What's new") for the Android and macOS store listings.
// Notes live in release-notes/<version>/<store>.txt and are tied to the release tag, so
// v0.3.0 ships exactly the notes committed under release-notes/0.3.0/.
//
//   node tools/release-notes.js <tag|version> [--require android,macos] [--out <dir>] [--markdown <file>]
//
//   --require   stores whose notes must exist (the build fails if one is missing or invalid)
//   --out       write each store's notes to <dir>/kindling-control-<version>-<store>-whatsnew.txt
//   --markdown  append a "Store release notes" section to <file> (used for the GitHub Release body)
//
// Used by .github/workflows/release.yml. See release-notes/README.md.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { versionFromTag } from './release-plan.js';

/** Per-store limits (characters) and display names. Play: 500 per language; App Store / Mac App Store: 4000. */
export const STORES = {
  android: { label: 'Google Play', limit: 500 },
  macos: { label: 'Mac App Store', limit: 4000 },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read and validate the notes for one version.
 * @param {string} version e.g. "0.3.0" or "0.3.0-beta.1" (a leading "v" is accepted)
 * @param {{ root?: string, require?: string[] }} opts `require`: stores whose notes must exist
 * @returns {{ version: string, notes: Record<string, string>, errors: string[] }}
 */
export function loadStoreNotes(version, { root = ROOT, require = [] } = {}) {
  const { name } = versionFromTag(version);
  const notes = {};
  const errors = [];
  for (const [store, { label, limit }] of Object.entries(STORES)) {
    const file = join(root, 'release-notes', name, `${store}.txt`);
    if (!existsSync(file)) {
      if (require.includes(store)) errors.push(`missing ${label} notes: release-notes/${name}/${store}.txt`);
      continue;
    }
    const text = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').trim();
    const length = [...text].length;
    if (!text) errors.push(`release-notes/${name}/${store}.txt is empty`);
    else if (length > limit) errors.push(`release-notes/${name}/${store}.txt is ${length} characters; ${label} allows ${limit}`);
    else notes[store] = text;
  }
  return { version: name, notes, errors };
}

/** Markdown section for the GitHub Release body, or '' when there are no notes. */
export function notesMarkdown(notes) {
  const stores = Object.keys(STORES).filter((s) => notes[s]);
  if (!stores.length) return '';
  const parts = ['## Store release notes', ''];
  for (const s of stores) parts.push(`### ${STORES[s].label}`, '', '```text', notes[s], '```', '');
  return `${parts.join('\n')}\n`;
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const [, value] = args.splice(i, 2);
    if (!value) throw new Error(`${flag} needs a value`);
    return value;
  };
  const require = (opt('--require') ?? '').split(',').filter(Boolean);
  const out = opt('--out');
  const markdown = opt('--markdown');
  const unknown = require.filter((s) => !STORES[s]);
  if (unknown.length) throw new Error(`unknown store(s): ${unknown.join(', ')} (expected ${Object.keys(STORES).join(', ')})`);
  if (!args[0]) throw new Error('usage: release-notes <tag|version> [--require android,macos] [--out dir] [--markdown file]');

  const { version, notes, errors } = loadStoreNotes(args[0], { require });
  if (errors.length) {
    for (const e of errors) console.error(`  ✗ ${e}`);
    throw new Error(`release notes for ${version} are not ready`);
  }
  const found = Object.keys(notes);
  console.log(found.length ? `release notes for ${version}: ${found.join(', ')}` : `no store release notes for ${version}`);

  if (out) {
    mkdirSync(out, { recursive: true });
    for (const [store, text] of Object.entries(notes)) {
      writeFileSync(join(out, `kindling-control-${version}-${store}-whatsnew.txt`), `${text}\n`);
    }
  }
  if (markdown) appendFileSync(markdown, notesMarkdown(notes));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv);
  } catch (err) {
    console.error(`release-notes: ${err.message}`);
    process.exitCode = 1;
  }
}
