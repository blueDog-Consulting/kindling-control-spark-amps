#!/usr/bin/env node
// One command to cut a release: checks, store notes, commit, push, tag, push the tag.
//
//   npm run release -- v0.3.0 [--dry-run] [--yes]
//
//   --dry-run  run the checks and show the draft notes and the git commands; change nothing
//   --yes      don't ask for confirmation (the notes must already be valid: no editor is opened)
//
// Order matters: the notes are committed and `main` is pushed *before* the tag, because the release
// workflow checks out the tag and fails early when a final Android release has no
// release-notes/<version>/android.txt. See docs/RELEASING.md.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planRelease, versionFromTag } from './release-plan.js';
import { STORES, loadStoreNotes } from './release-notes.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ACTIONS_URL = 'https://github.com/bluedog-consulting/kindling-control-spark-amps/actions/workflows/release.yml';

/** Does this release need store notes? Only a final tag that builds Android does (as in release.yml). */
export function notesRequired(plan, prerelease) {
  return !!plan.android?.build && !prerelease;
}

/** Plain-text draft for a store listing: one "- subject" line per commit, cut to fit `limit` characters. */
export function draftNotes(subjects, limit = STORES.android.limit) {
  const lines = [];
  let length = 0;
  for (const subject of subjects.map((s) => s.trim()).filter(Boolean)) {
    const line = `- ${subject}`;
    const next = length + [...line].length + (lines.length ? 1 : 0);
    if (next > limit) break;
    lines.push(line);
    length = next;
  }
  return lines.length ? `${lines.join('\n')}\n` : 'What’s new: \n';
}

/** Default side effects; tests pass fakes. */
const realDeps = {
  git: (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  gitShow: (...args) => execFileSync('git', args, { cwd: ROOT, stdio: 'inherit' }),
  test: () => spawnSync('npm', ['test'], { cwd: ROOT, stdio: 'inherit' }).status === 0,
  edit: (file) => {
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    return spawnSync(`${editor} "${file}"`, { shell: true, stdio: 'inherit' }).status === 0;
  },
  confirm: async (question) => {
    if (!process.stdin.isTTY) return false;
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
    } finally {
      rl.close();
    }
  },
  log: (msg) => console.log(msg),
  root: ROOT,
};

function lastTag(git) {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', 'HEAD');
  } catch {
    return null; // no earlier release
  }
}

/**
 * @param {string} tag e.g. "v0.3.0"
 * @param {{ dryRun?: boolean, yes?: boolean }} opts
 */
export async function release(tag, { dryRun = false, yes = false } = {}, deps = realDeps) {
  const d = { ...realDeps, ...deps };
  const { git, gitShow, log, root } = d;
  const v = versionFromTag(tag);
  if (!tag.startsWith('v')) throw new Error(`tag "${tag}" must start with "v", like v${v.name}`);

  // 1. The tag must be new, locally and on origin.
  if (git('tag', '--list', tag)) throw new Error(`tag ${tag} already exists locally`);
  git('fetch', '--tags', '--quiet', 'origin');
  if (git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`)) throw new Error(`tag ${tag} already exists on origin`);

  // 2. Releases are cut from an up-to-date, clean main.
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') throw new Error(`releases are cut from main (you are on ${branch})`);
  if (git('status', '--porcelain')) throw new Error('the working tree has uncommitted changes; commit or stash them first');
  if (Number(git('rev-list', '--count', 'HEAD..origin/main')) > 0) throw new Error('main is behind origin/main; run git pull first');

  // 3. Same tests CI runs, before anything is pushed.
  log('Running tests...');
  if (!d.test()) throw new Error('tests failed; nothing was committed, pushed or tagged');

  // 4. Which apps does this release build, and does that need store notes?
  const prev = lastTag(git);
  const files = prev ? git('diff', '--name-only', `${prev}...HEAD`).split('\n').filter(Boolean) : null;
  const plan = planRelease(files);
  const built = Object.entries(plan).filter(([, p]) => p.build).map(([app]) => app);
  log(`${tag}: version ${v.name}, ${prev ? `changes since ${prev}` : 'first release'}, builds ${built.join(', ') || 'nothing'}`);

  // 5. Store notes: keep valid ones, otherwise draft from the commit log and open the editor.
  const notesPath = join(root, 'release-notes', v.name, 'android.txt');
  const relNotes = `release-notes/${v.name}/android.txt`;
  let writeNotes = false;
  if (!notesRequired(plan, v.prerelease)) {
    log('No store release notes needed for this release.');
  } else if (loadStoreNotes(v.name, { root, only: ['android'], require: ['android'] }).errors.length === 0) {
    log(`Using the existing ${relNotes}.`);
  } else {
    const subjects = prev ? git('log', `${prev}..HEAD`, '--no-merges', '--format=%s').split('\n') : [];
    const draft = draftNotes(subjects);
    if (dryRun) {
      log(`\nDraft ${relNotes} (not written in a dry run):\n\n${draft}`);
    } else {
      if (yes) throw new Error(`${relNotes} is missing or invalid, and --yes opens no editor; write it first`);
      mkdirSync(dirname(notesPath), { recursive: true });
      if (!existsSync(notesPath)) writeFileSync(notesPath, draft);
      for (;;) {
        log(`Opening ${relNotes} in your editor. Write for users, plain text, ${STORES.android.limit} characters at most.`);
        if (!d.edit(notesPath)) throw new Error('the editor exited with an error; notes not saved');
        const { errors } = loadStoreNotes(v.name, { root, only: ['android'], require: ['android'] });
        if (!errors.length) break;
        errors.forEach((e) => log(`  ✗ ${e}`));
        if (!(await d.confirm('Edit again?'))) throw new Error('release notes are not valid; nothing was committed, pushed or tagged');
      }
      writeNotes = true;
    }
  }

  // 6. Say what is about to happen.
  const steps = [
    ...(writeNotes ? [`git add ${relNotes}`, `git commit -m "Release notes for ${tag}"`] : []),
    'git push origin main',
    `git tag ${tag}`,
    `git push origin ${tag}`,
  ];
  log(`\n${dryRun ? 'Dry run, would run' : 'About to run'}:\n${steps.map((s) => `  ${s}`).join('\n')}\n`);
  if (dryRun) return { steps, pushed: false };
  if (!yes && !(await d.confirm(`Release ${tag}?`))) throw new Error('cancelled; nothing was pushed or tagged');

  // 7. Notes first, then main, then the tag, so the tag's commit is on origin when the workflow checks it out.
  if (writeNotes) {
    git('add', relNotes);
    git('commit', '-m', `Release notes for ${tag}`);
  }
  gitShow('push', 'origin', 'main');
  git('tag', tag);
  gitShow('push', 'origin', tag);
  log(`\nPushed ${tag}. Watch the build: ${ACTIONS_URL}`);
  return { steps, pushed: true };
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return false;
    args.splice(i, 1);
    return true;
  };
  const dryRun = flag('--dry-run');
  const yes = flag('--yes');
  const [tag, ...extra] = args;
  if (!tag || extra.length) throw new Error('usage: npm run release -- <vX.Y.Z> [--dry-run] [--yes]');
  await release(tag, { dryRun, yes });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv).catch((err) => {
    console.error(`release: ${err.message}`);
    process.exitCode = 1;
  });
}
