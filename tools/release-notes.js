#!/usr/bin/env node
// Versioned store release notes ("What's new") for the Android, iOS and macOS store listings.
// Notes live in release-notes/<version>/<store>.txt and are tied to the release tag, so
// v0.3.0 ships exactly the notes committed under release-notes/0.3.0/.
//
//   node tools/release-notes.js <tag|version> [--only android,ios,macos] [--require android,ios,macos]
//                                             [--out <dir>] [--markdown <file>] [--root <dir>]
//
//   --only      look only at these stores (default: all). The release job passes the apps it actually built,
//               so a release that skipped Android doesn't carry Play notes.
//   --require   stores whose notes must exist (the build fails if one is missing or invalid)
//   --out       write each store's notes to <dir>/kindling-control-<version>-<store>-whatsnew.txt
//   --markdown  append a "Store release notes" section to <file> (used for the GitHub Release body)
//   --root      repository root that holds release-notes/ (default: this checkout; used by the tests)
//   --fill      stores whose missing notes are written now, so a release never waits for a hand-written file:
//               the text of $RELEASE_NOTES_TEXT if set (the Release workflow's "notes" input; a literal \n
//               starts a new line), otherwise a list generated from the pull requests and commits since
//               --since <previous tag> that changed that app. A committed file always wins. Prints
//               "source=committed|input|generated" for each filled store.
//   --since     the previous release tag, for --fill (default: none, which lists nothing)
//
// Used by .github/workflows/release.yml. See release-notes/README.md.

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { APP_PATHS, versionFromTag } from './release-plan.js';

/** Per-store limits (characters) and display names. Play: 500 per language; App Store / Mac App Store: 4000. */
export const STORES = {
  android: { label: 'Google Play', limit: 500 },
  ios: { label: 'App Store (iOS)', limit: 4000 },
  macos: { label: 'Mac App Store', limit: 4000 },
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read and validate the notes for one version.
 * @param {string} version e.g. "0.3.0" or "0.3.0-beta.1" (a leading "v" is accepted)
 * @param {{ root?: string, only?: string[], require?: string[] }} opts `only`: stores to look at (default all);
 *   `require`: stores whose notes must exist
 * @returns {{ version: string, notes: Record<string, string>, errors: string[] }}
 */
export function loadStoreNotes(version, { root = ROOT, only = Object.keys(STORES), require = [] } = {}) {
  const { name } = versionFromTag(version);
  const notes = {};
  const errors = [];
  for (const [store, { label, limit }] of Object.entries(STORES)) {
    if (!only.includes(store)) continue;
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

/** Fallback when nothing user-facing changed (or there is no earlier tag to compare with). */
export const GENERIC_NOTES = 'Bug fixes and improvements.';

/**
 * User-facing change titles from `git log --first-parent` entries, newest first. A merged pull request
 * contributes its title (the first line of the merge commit's body); a squash merge or a direct commit its
 * subject without the trailing "(#12)". Branch merges and release-notes commits are left out.
 * @param {{ subject: string, body?: string }[]} commits
 * @returns {string[]}
 */
export function changeTitles(commits) {
  const titles = [];
  for (const { subject = '', body = '' } of commits) {
    let title = subject.trim();
    if (/^Merge pull request #\d+/.test(title)) title = body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
    else if (/^Merge (remote-tracking )?branch\b/.test(title)) continue;
    title = title.replace(/\s*\(#\d+\)$/, '').trim();
    if (!title || /^Release notes for v/i.test(title)) continue;
    if (!titles.includes(title)) titles.push(title);
  }
  return titles;
}

/** Plain-text store notes: one "- title" line per change, cut to fit `limit` characters; never empty. */
export function generateNotes(titles, limit) {
  const lines = [];
  let length = 0;
  for (const t of titles) {
    const line = `- ${t}`;
    const next = length + [...line].length + (lines.length ? 1 : 0);
    if (next > limit) break;
    lines.push(line);
    length = next;
  }
  return lines.length ? lines.join('\n') : GENERIC_NOTES;
}

/** Text typed into the workflow's single-line "notes" input: a literal \n becomes a line break. */
export function inputNotes(text) {
  return (text ?? '').replace(/\\n/g, '\n').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').trim();
}

/**
 * The first-parent commits in previous..tag that changed one of `patterns`, as { subject, body }.
 * `git` runs a git command and returns stdout (tests pass a fake).
 */
export function commitsTouching(git, previous, tag, patterns) {
  if (!previous) return [];
  const log = git('log', '--first-parent', '--format=%H%x1f%s%x1f%b%x1e', `${previous}..${tag}`);
  const commits = [];
  for (const entry of log.split('\x1e')) {
    const [hash, subject, body = ''] = entry.replace(/^\n+/, '').split('\x1f');
    if (!hash || !subject) continue;
    // For a merge, what the merge brought into the first parent; for any other commit, its own changes.
    const files = git('diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--first-parent', hash).split('\n');
    if (files.some((f) => patterns.some((re) => re.test(f)))) commits.push({ subject, body });
  }
  return commits;
}

/** Paths whose changes belong in a store's notes: the app's own build paths (iOS/macOS fall back to the web code). */
function storePaths(store) {
  return APP_PATHS[store] ?? APP_PATHS[{ macos: 'desktop' }[store]] ?? [/^src\//];
}

/**
 * Write release-notes/<version>/<store>.txt for each store in `stores` that has no file yet.
 * @returns {Record<string, 'committed'|'input'|'generated'>} where each store's notes come from
 */
export function fillNotes(version, stores, { root = ROOT, since = null, text = '', git = gitIn(root) } = {}) {
  const { name } = versionFromTag(version);
  const sources = {};
  const typed = inputNotes(text);
  for (const store of stores) {
    const file = join(root, 'release-notes', name, `${store}.txt`);
    if (existsSync(file)) {
      sources[store] = 'committed';
      continue;
    }
    const notes = typed || generateNotes(changeTitles(commitsTouching(git, since, version, storePaths(store))), STORES[store].limit);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${notes}\n`);
    sources[store] = typed ? 'input' : 'generated';
  }
  return sources;
}

function gitIn(root) {
  return (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const [, value] = args.splice(i, 2);
    if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    return value;
  };
  const stores = (flag) => (opt(flag) ?? '').split(',').filter(Boolean);
  const require = stores('--require');
  const onlyArg = stores('--only');
  const only = onlyArg.length ? onlyArg : Object.keys(STORES);
  const out = opt('--out');
  const markdown = opt('--markdown');
  const root = opt('--root');
  const fill = stores('--fill');
  const since = opt('--since');
  const unknown = [...require, ...only, ...fill].filter((s) => !STORES[s]);
  if (unknown.length) throw new Error(`unknown store(s): ${unknown.join(', ')} (expected ${Object.keys(STORES).join(', ')})`);
  const notLooked = require.filter((s) => !only.includes(s));
  if (notLooked.length) throw new Error(`--require ${notLooked.join(',')} is not in --only ${only.join(',')}`);
  if (!args[0]) {
    throw new Error(
      'usage: release-notes <tag|version> [--only stores] [--require stores] [--fill stores [--since tag]]' +
        ' [--out dir] [--markdown file] [--root dir]',
    );
  }

  const notFilled = fill.filter((s) => !only.includes(s));
  if (notFilled.length) throw new Error(`--fill ${notFilled.join(',')} is not in --only ${only.join(',')}`);
  if (fill.length) {
    const sources = fillNotes(args[0], fill, { since, text: process.env.RELEASE_NOTES_TEXT, ...(root && { root: resolve(root) }) });
    for (const [store, source] of Object.entries(sources)) console.log(`${store}: source=${source}`);
  }

  const { version, notes, errors } = loadStoreNotes(args[0], { only, require, ...(root && { root: resolve(root) }) });
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
