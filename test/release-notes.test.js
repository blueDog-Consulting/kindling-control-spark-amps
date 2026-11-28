import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changeTitles, commitsTouching, fillNotes, generateNotes, GENERIC_NOTES, inputNotes, loadStoreNotes, notesMarkdown, STORES,
} from '../tools/release-notes.js';

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
  const root = repoWith('0.3.0', { 'android.txt': 'Android', 'macos.txt': 'Mac' });
  const out = join(root, 'out');
  const run = (...args) => spawnSync(process.execPath, [cli, '0.3.0', '--root', root, ...args], { encoding: 'utf8' });

  const ok = run('--only', 'macos', '--out', out);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readdirSync(out), ['kindling-control-0.3.0-macos-whatsnew.txt']);
  assert.equal(readFileSync(join(out, 'kindling-control-0.3.0-macos-whatsnew.txt'), 'utf8'), 'Mac\n');

  const bad = run('--only', 'macos', '--require', 'android');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--require android is not in --only macos/);
});

test('ios notes are validated against the 4000 character App Store limit', () => {
  assert.equal(STORES.ios.limit, 4000);
  const ok = repoWith('0.3.0', { 'ios.txt': 'x'.repeat(4000) });
  assert.deepEqual(loadStoreNotes('0.3.0', { root: ok, only: ['ios'] }).notes, { ios: 'x'.repeat(4000) });
  const bad = repoWith('0.3.0', { 'ios.txt': 'x'.repeat(4001) });
  assert.match(loadStoreNotes('0.3.0', { root: bad, only: ['ios'] }).errors[0], /4001 characters; App Store \(iOS\) allows 4000/);
  assert.match(loadStoreNotes('0.3.0', { root: repoWith('0.3.0', {}), require: ['ios'] }).errors[0], /missing App Store \(iOS\) notes/);
});

test('change titles come from merged pull requests and commits, without merges of branches or notes commits', () => {
  const titles = changeTitles([
    { subject: 'Merge pull request #48 from org/branch', body: 'Run one Connect attempt at a time (#47)\n\nmore' },
    { subject: 'Fix the tuner needle (#50)' },
    { subject: "Merge branch 'main' into x" },
    { subject: "Merge remote-tracking branch 'origin/main'" },
    { subject: 'Release notes for v0.3.0' },
    { subject: 'Fix the tuner needle' },
    { subject: 'Merge pull request #9 from org/empty', body: '' },
  ]);
  assert.deepEqual(titles, ['Run one Connect attempt at a time', 'Fix the tuner needle']);
});

test('generated notes fit the store limit and are never empty', () => {
  assert.equal(generateNotes(['A', 'B'], 500), '- A\n- B');
  const long = generateNotes(Array.from({ length: 200 }, (_, i) => `Change number ${i}`), STORES.android.limit);
  assert.ok([...long].length <= STORES.android.limit);
  assert.equal(generateNotes([], 500), GENERIC_NOTES);
});

test('notes typed into the workflow input turn \\n into line breaks', () => {
  assert.equal(inputNotes('  New tuner.\\nFixes.  '), 'New tuner.\nFixes.');
  assert.equal(inputNotes(undefined), '');
});

test('only commits that changed the app count', () => {
  const git = (cmd, ...rest) => {
    if (cmd === 'log') {
      assert.equal(rest.at(-1), 'v0.2.0..v0.3.0');
      return 'a1\x1fMerge pull request #1 from o/b\x1fNew tuner\n\x1e\nb2\x1fAdd issue forms\x1f\x1e\n';
    }
    return rest.at(-1) === 'a1' ? 'src/app/app.js\n' : '.github/ISSUE_TEMPLATE/bug.yml\n';
  };
  assert.deepEqual(commitsTouching(git, 'v0.2.0', 'v0.3.0', [/^src\//]), [{ subject: 'Merge pull request #1 from o/b', body: 'New tuner\n' }]);
  assert.deepEqual(commitsTouching(git, null, 'v0.3.0', [/^src\//]), []);
});

test('fill writes missing notes from the input, else generates them, and never replaces a committed file', () => {
  const git = (cmd) => (cmd === 'log' ? 'a1\x1fAdd the looper (#3)\x1f\x1e' : 'src/app/app.js\n');
  const fresh = repoWith('0.3.0', {});
  assert.deepEqual(fillNotes('v0.3.0', ['android'], { root: fresh, since: 'v0.2.0', git }), { android: 'generated' });
  assert.equal(readFileSync(join(fresh, 'release-notes/0.3.0/android.txt'), 'utf8'), '- Add the looper\n');

  const typed = repoWith('0.3.0', {});
  assert.deepEqual(fillNotes('v0.3.0', ['android'], { root: typed, text: 'Hi\\nthere', git }), { android: 'input' });
  assert.equal(readFileSync(join(typed, 'release-notes/0.3.0/android.txt'), 'utf8'), 'Hi\nthere\n');

  const committed = repoWith('0.3.0', { 'android.txt': 'Mine.' });
  assert.deepEqual(fillNotes('v0.3.0', ['android'], { root: committed, text: 'Other', git }), { android: 'committed' });
  assert.equal(readFileSync(join(committed, 'release-notes/0.3.0/android.txt'), 'utf8'), 'Mine.');
});

test('typed notes over the limit still fail validation', () => {
  const root = repoWith('0.3.0', {});
  fillNotes('v0.3.0', ['android'], { root, text: 'x'.repeat(STORES.android.limit + 1), git: () => '' });
  assert.match(loadStoreNotes('0.3.0', { root, require: ['android'] }).errors[0], /501 characters/);
});
