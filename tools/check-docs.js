#!/usr/bin/env node
// Enforces the rule in AGENTS.md: a material change to how the system works
// must update the docs (README.md or docs/) AND AGENTS.md in the same change.
//
//   node tools/check-docs.js [base-ref]      # default base: origin/main
//
// Opt out for changes that genuinely don't alter behaviour (typo fix, pure
// refactor, styling) with a commit trailer anywhere in the range:
//   Docs-Not-Needed: <reason>
// or, in CI, the PR label "docs-not-needed" (passed in via DOCS_NOT_NEEDED).

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Paths whose changes alter how the system works. */
export const MATERIAL = [
  /^src\/spark\//, // protocol library, transports
  /^src\/app\/(?!styles\.css$)/, // app behaviour (pure styling excluded)
  /^src\/index\.html$/,
  /^src\/manifest\.webmanifest$/,
  /^desktop\//, // Electron shell
  /^tools\//, // CLIs and this check
  /^capacitor\.config\.json$/,
  /^android\/app\/src\/main\/AndroidManifest\.xml$/,
  /^android\/variables\.gradle$/,
  /^android\/(app\/)?build\.gradle$/, // versioning, signing
  /^ios\/App\/App\/Info\.plist$/,
  /^package\.json$/, // scripts, entry points, build config, dependencies
  /^\.github\/workflows\//,
  /^src\/version\.js$/,
  /^telemetry\//, // the error-report Worker
  /^\.claude\//, // project skills and plugin settings (feature-request workflow)
  /^\.github\/feature-workflow\.json$/,
];

/** Paths that count as user/developer documentation. */
export const DOCS = [/^README\.md$/, /^docs\/.+\.md$/, /^src\/guide\/index\.html$/]; // incl. the in-app user guide
export const AGENTS = 'AGENTS.md';

/**
 * @param {string[]} files changed paths
 * @param {{ optOut?: string }} opts reason for skipping, if any
 * @returns {{ ok: boolean, material: string[], missing: string[], skipped?: string }}
 */
export function checkDocs(files, { optOut } = {}) {
  const material = files.filter((f) => MATERIAL.some((re) => re.test(f)));
  if (!material.length) return { ok: true, material, missing: [] };
  if (optOut) return { ok: true, material, missing: [], skipped: optOut };
  const missing = [];
  if (!files.includes(AGENTS)) missing.push(AGENTS);
  if (!files.some((f) => DOCS.some((re) => re.test(f)))) missing.push('README.md or docs/*.md');
  return { ok: missing.length === 0, material, missing };
}

/** Find a "Docs-Not-Needed: reason" trailer in commit messages. */
export function findOptOut(messages) {
  const m = /^Docs-Not-Needed:\s*(.+)$/im.exec(messages);
  return m ? m[1].trim() : undefined;
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function main() {
  const base = process.argv[2] || 'origin/main';
  if (/^0+$/.test(base)) {
    console.log('check-docs: no base commit (new branch); nothing to compare.');
    return;
  }
  const files = git('diff', '--name-only', `${base}...HEAD`).split('\n').filter(Boolean);
  const optOut = process.env.DOCS_NOT_NEEDED || findOptOut(git('log', '--format=%B', `${base}..HEAD`));
  const r = checkDocs(files, { optOut });

  if (!r.material.length) {
    console.log('check-docs: no material changes.');
    return;
  }
  if (r.skipped) {
    console.log(`check-docs: material changes, docs update skipped: ${r.skipped}`);
    return;
  }
  if (r.ok) {
    console.log('check-docs: material changes come with docs and AGENTS.md updates. ✓');
    return;
  }
  console.error(`check-docs: these changes alter how the system works:\n${r.material.map((f) => `  ${f}`).join('\n')}`);
  console.error(`\nbut the change does not update: ${r.missing.join(' and ')}.`);
  console.error(
    '\nUpdate the docs that describe this behaviour and AGENTS.md (see "Documentation rule" in AGENTS.md).' +
      '\nIf the change really does not alter behaviour, add a commit trailer\n  Docs-Not-Needed: <reason>\nor the PR label "docs-not-needed".',
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
