import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftNotes, notesRequired, release } from '../tools/release.js';
import { STORES } from '../tools/release-notes.js';

/** A fake git + editor + prompt. `state` overrides the repo; `calls` records mutating commands. */
function fakes({ branch = 'main', dirty = '', behind = '0', tags = '', remoteTags = '', changed = 'src/app/app.js\n', prev = 'v0.1.0',
  tests = true, editorText = 'Reorder your chain.', answers = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'release-'));
  const calls = [];
  const logs = [];
  const run = (...a) => {
    const [cmd] = a;
    if (cmd === 'tag' && a[1] === '--list') return tags;
    if (cmd === 'ls-remote') return remoteTags;
    if (cmd === 'rev-parse') return branch;
    if (cmd === 'status') return dirty;
    if (cmd === 'rev-list') return behind;
    if (cmd === 'describe') {
      if (!prev) throw new Error('no tags');
      return prev;
    }
    if (cmd === 'diff') return changed;
    if (cmd === 'log') return 'Add chain reorder\nFix tuner crash\n';
    if (cmd !== 'fetch') calls.push(['git', ...a].join(' '));
    return '';
  };
  const deps = {
    root,
    git: run,
    gitShow: (...a) => calls.push(['git', ...a].join(' ')),
    test: () => tests,
    edit: (file) => {
      calls.push('edit');
      writeFileSync(file, editorText);
      return true;
    },
    confirm: async () => (answers.length ? answers.shift() : true),
    log: (m) => logs.push(m),
  };
  return { deps, calls, logs, root };
}

test('notes are required only for a final release that builds Android', () => {
  const built = { android: { build: true }, desktop: { build: false } };
  const skipped = { android: { build: false }, desktop: { build: true } };
  assert.equal(notesRequired(built, false), true);
  assert.equal(notesRequired(built, true), false);
  assert.equal(notesRequired(skipped, false), false);
});

test('draft lists commit subjects and stays within the Play limit', () => {
  assert.equal(draftNotes(['Add chain reorder', ' Fix tuner crash ', '']), '- Add chain reorder\n- Fix tuner crash\n');
  const long = draftNotes(Array.from({ length: 200 }, (_, i) => `Change number ${i}`));
  assert.ok([...long.trim()].length <= STORES.android.limit);
  assert.match(draftNotes([]), /What/); // never an empty file
});

test('refuses bad tags, existing tags, other branches, dirty trees and a stale main', async () => {
  await assert.rejects(release('0.3.0', {}, fakes().deps), /must start with "v"/);
  await assert.rejects(release('latest', {}, fakes().deps), /semantic version/);
  await assert.rejects(release('v0.3.0', {}, fakes({ tags: 'v0.3.0' }).deps), /already exists locally/);
  await assert.rejects(release('v0.3.0', {}, fakes({ remoteTags: 'abc\trefs/tags/v0.3.0' }).deps), /already exists on origin/);
  await assert.rejects(release('v0.3.0', {}, fakes({ branch: 'dev' }).deps), /cut from main/);
  await assert.rejects(release('v0.3.0', {}, fakes({ dirty: ' M a' }).deps), /uncommitted/);
  await assert.rejects(release('v0.3.0', {}, fakes({ behind: '2' }).deps), /behind origin/);
});

test('failing tests stop the release before anything is committed or pushed', async () => {
  const f = fakes({ tests: false });
  await assert.rejects(release('v0.3.0', {}, f.deps), /tests failed/);
  assert.deepEqual(f.calls, []);
});

test('a final Android release writes notes, commits, pushes main, then tags and pushes the tag, in that order', async () => {
  const f = fakes();
  const r = await release('v0.3.0', {}, f.deps);
  assert.equal(r.pushed, true);
  assert.deepEqual(f.calls, [
    'edit',
    'git add release-notes/0.3.0/android.txt',
    'git commit -m Release notes for v0.3.0',
    'git push origin main',
    'git tag v0.3.0',
    'git push origin v0.3.0',
  ]);
  assert.equal(readFileSync(join(f.root, 'release-notes/0.3.0/android.txt'), 'utf8'), 'Reorder your chain.');
});

test('the editor opens on a draft built from the commit log', async () => {
  const f = fakes();
  let seen;
  f.deps.edit = (file) => {
    seen = readFileSync(file, 'utf8');
    return true;
  };
  await release('v0.3.0', {}, f.deps);
  assert.equal(seen, '- Add chain reorder\n- Fix tuner crash\n');
});

test('invalid notes re-open the editor, or abort when the user declines', async () => {
  const tooLong = 'x'.repeat(STORES.android.limit + 1);
  const f = fakes({ editorText: tooLong, answers: [false] });
  await assert.rejects(release('v0.3.0', {}, f.deps), /not valid/);
  assert.ok(!f.calls.includes('git push origin main'));
});

test('valid existing notes are used as they are: no editor, no notes commit', async () => {
  const f = fakes();
  mkdirSync(join(f.root, 'release-notes/0.3.0'), { recursive: true });
  writeFileSync(join(f.root, 'release-notes/0.3.0/android.txt'), 'Already written.');
  await release('v0.3.0', { yes: true }, f.deps);
  assert.deepEqual(f.calls, ['git push origin main', 'git tag v0.3.0', 'git push origin v0.3.0']);
});

test('pre-releases and releases that skip Android need no notes', async () => {
  const pre = fakes();
  await release('v0.3.0-beta.1', { yes: true }, pre.deps);
  assert.ok(!pre.calls.includes('edit'));
  const docsOnly = fakes({ changed: 'docs/RELEASING.md\n' });
  await release('v0.3.0', { yes: true }, docsOnly.deps);
  assert.ok(!docsOnly.calls.includes('edit'));
});

test('--yes will not open an editor for missing notes', async () => {
  const f = fakes();
  await assert.rejects(release('v0.3.0', { yes: true }, f.deps), /--yes opens no editor/);
  assert.deepEqual(f.calls, []);
});

test('a dry run shows the draft and changes nothing', async () => {
  const f = fakes();
  const r = await release('v0.3.0', { dryRun: true }, f.deps);
  assert.equal(r.pushed, false);
  assert.deepEqual(f.calls, []);
  assert.ok(!existsSync(join(f.root, 'release-notes')));
  assert.match(f.logs.join('\n'), /Add chain reorder/);
});

test('declining the final confirmation pushes and tags nothing', async () => {
  const f = fakes({ answers: [false] });
  f.deps.edit = (file) => {
    writeFileSync(file, 'ok');
    return true;
  };
  await assert.rejects(release('v0.3.0', {}, f.deps), /cancelled/);
  assert.deepEqual(f.calls, []);
});
