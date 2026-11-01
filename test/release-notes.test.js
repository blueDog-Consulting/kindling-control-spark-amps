import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStoreNotes, notesMarkdown, STORES } from '../tools/release-notes.js';

function repoWith(version, files) {
  const root = mkdtempSync(join(tmpdir(), 'release-notes-'));
  mkdirSync(join(root, 'release-notes', version), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, 'release-notes', version, name), text);
  return root;
}

test('notes are looked up by the version in the tag', () => {
  const root = repoWith('0.3.0', { 'android.txt': 'New: reorder chain.\r\n' });
  const r = loadStoreNotes('v0.3.0', { root, require: ['android'] });
  assert.equal(r.version, '0.3.0');
  assert.deepEqual(r.errors, []);
  assert.equal(r.notes.android, 'New: reorder chain.');
});

test('other versions do not pick up these notes', () => {
  const root = repoWith('0.3.0', { 'android.txt': 'x' });
  assert.equal(loadStoreNotes('v0.3.1', { root }).notes.android, undefined);
  assert.equal(loadStoreNotes('v0.3.0-beta.1', { root }).notes.android, undefined);
});

test('required notes that are missing are an error; optional ones are not', () => {
  const root = repoWith('0.3.0', {});
  assert.equal(loadStoreNotes('0.3.0', { root }).errors.length, 0);
  assert.match(loadStoreNotes('0.3.0', { root, require: ['android'] }).errors[0], /missing Google Play notes/);
});

test('empty notes and notes over the store limit are errors', () => {
  const root = repoWith('0.3.0', {
    'android.txt': 'x'.repeat(STORES.android.limit + 1),
    'macos.txt': '  \n',
  });
  const { errors, notes } = loadStoreNotes('0.3.0', { root });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /501 characters; Google Play allows 500/);
  assert.match(errors[1], /empty/);
  assert.deepEqual(notes, {});
});

test('the limit counts characters, not bytes', () => {
  const root = repoWith('0.3.0', { 'android.txt': '🔥'.repeat(STORES.android.limit) });
  assert.deepEqual(loadStoreNotes('0.3.0', { root }).errors, []);
});

test('an invalid tag is rejected', () => {
  assert.throws(() => loadStoreNotes('latest'), /semantic version/);
});

test('markdown lists each store that has notes', () => {
  assert.equal(notesMarkdown({}), '');
  const md = notesMarkdown({ macos: 'Hi' });
  assert.match(md, /### Mac App Store/);
  assert.doesNotMatch(md, /Google Play/);
});

test('an option followed by another option is an error, not its value', () => {
  const cli = fileURLToPath(new URL('../tools/release-notes.js', import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), 'release-notes-cli-'));
  const r = spawnSync(process.execPath, [cli, '0.3.0', '--out', '--markdown', 'notes.md'], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--out needs a value/);
});

test('--only limits the stores that are read', () => {
  const root = repoWith('0.3.0', { 'android.txt': 'Android', 'macos.txt': 'Mac' });
  assert.deepEqual(loadStoreNotes('0.3.0', { root, only: ['macos'] }).notes, { macos: 'Mac' });
  // a broken file for a store that is left out is not looked at either
  const broken = repoWith('0.3.0', { 'android.txt': 'x'.repeat(STORES.android.limit + 1), 'macos.txt': 'Mac' });
  assert.deepEqual(loadStoreNotes('0.3.0', { root: broken, only: ['macos'] }).errors, []);
});

test('the CLI writes only the --only stores and rejects --require outside them', () => {
  const cli = fileURLToPath(new URL('../tools/release-notes.js', import.meta.url));
  const cwd = mkdtempSync(join(tmpdir(), 'release-notes-cli-'));
  const out = join(cwd, 'out');
  const ok = spawnSync(process.execPath, [cli, '0.1.0', '--only', 'macos', '--out', out], { cwd, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  const bad = spawnSync(process.execPath, [cli, '0.1.0', '--only', 'macos', '--require', 'android'], { cwd, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--require android is not in --only macos/);
});
