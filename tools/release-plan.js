#!/usr/bin/env node
// Decides which apps a release tag needs to build, based on what changed since
// the previous release tag. Used by .github/workflows/release.yml.
//
//   node tools/release-plan.js <tag> [previous-tag]
//
// Prints a summary and, when $GITHUB_OUTPUT is set, writes:
//   android / desktop = true|false, version, version_code, prerelease, previous

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Paths that affect each app. `src/` is shared by all of them. */
export const APP_PATHS = {
  android: [/^src\//, /^android\//, /^capacitor\.config\.json$/, /^package(-lock)?\.json$/],
  desktop: [/^src\//, /^desktop\//, /^build\//, /^package(-lock)?\.json$/], // build/ = desktop icons
};

/**
 * @param {string[]|null} files changed paths since the previous release, or null for "no previous release"
 * @param {{ force?: boolean }} opts
 */
export function planRelease(files, { force = false } = {}) {
  const plan = {};
  for (const [app, patterns] of Object.entries(APP_PATHS)) {
    if (force || files === null) {
      plan[app] = { build: true, reason: force ? 'forced' : 'first release' };
      continue;
    }
    const hits = files.filter((f) => patterns.some((re) => re.test(f)));
    plan[app] = hits.length ? { build: true, reason: `${hits.length} changed file(s), e.g. ${hits[0]}` } : { build: false, reason: 'no changes' };
  }
  return plan;
}

/**
 * vMAJOR.MINOR.PATCH[-pre.N] -> version name + monotonically increasing Android versionCode.
 * code = major*1e6 + minor*1e4 + patch*100 + suffix, where suffix is
 *   alpha.N -> 0+N, beta.N -> 33+N, rc.N -> 66+N (N up to 32), final release -> 99
 * so 1.2.3-alpha.1 < 1.2.3-beta.1 < 1.2.3-beta.2 < 1.2.3-rc.1 < 1.2.3 < 1.2.4-alpha.1.
 * Android refuses to install an update with a lower versionCode, so this order matters.
 */
export function versionFromTag(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(tag).trim());
  if (!m) throw new Error(`tag "${tag}" is not a semantic version like v1.2.3 or v1.2.3-beta.1`);
  const [, maj, min, pat, pre] = m;
  const [major, minor, patch] = [maj, min, pat].map(Number);
  if (minor > 99 || patch > 99) throw new Error('minor and patch must be 0-99 to fit the Android versionCode scheme');
  let suffix = 99;
  if (pre) {
    const channel = /^(alpha|beta|rc)/i.exec(pre)?.[1].toLowerCase();
    const n = Number(/(\d+)$/.exec(pre)?.[1] ?? 0);
    if (n > 32) throw new Error('pre-release number must be 0-32');
    suffix = ({ alpha: 0, beta: 33, rc: 66 }[channel] ?? 0) + n;
  }
  return {
    name: `${major}.${minor}.${patch}${pre ? `-${pre}` : ''}`,
    code: major * 1_000_000 + minor * 10_000 + patch * 100 + suffix,
    prerelease: !!pre,
  };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function previousTag(tag) {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', `${tag}^`);
  } catch {
    return null; // no earlier release tag
  }
}

function main() {
  const tag = process.argv[2];
  if (!tag) throw new Error('usage: release-plan <tag> [previous-tag]');
  const v = versionFromTag(tag); // validate before touching git
  const force = process.env.FORCE_ALL === 'true';
  const prev = process.argv[3] || previousTag(tag);
  const files = prev ? git('diff', '--name-only', `${prev}...${tag}`).split('\n').filter(Boolean) : null;
  const plan = planRelease(files, { force });

  console.log(`release ${tag} (version ${v.name}, Android versionCode ${v.code})`);
  console.log(prev ? `changes since ${prev}: ${files.length} file(s)` : 'no previous release tag: building everything');
  for (const [app, p] of Object.entries(plan)) console.log(`  ${app.padEnd(8)} ${p.build ? 'BUILD' : 'skip '}  ${p.reason}`);

  if (process.env.GITHUB_OUTPUT) {
    const out = [
      ...Object.entries(plan).map(([app, p]) => `${app}=${p.build}`),
      ...Object.entries(plan).map(([app, p]) => `${app}_reason=${p.reason}`),
      `version=${v.name}`,
      `version_code=${v.code}`,
      `prerelease=${v.prerelease}`,
      `previous=${prev ?? ''}`,
    ];
    appendFileSync(process.env.GITHUB_OUTPUT, `${out.join('\n')}\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (err) {
    console.error(`release-plan: ${err.message}`);
    process.exitCode = 1;
  }
}
