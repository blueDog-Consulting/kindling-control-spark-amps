import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planRelease, versionFromTag } from '../tools/release-plan.js';

const builds = (plan) => Object.entries(plan).filter(([, p]) => p.build).map(([a]) => a).sort();

test('shared web code rebuilds every app', () => {
  assert.deepEqual(builds(planRelease(['src/app/rig.js'])), ['android', 'desktop', 'ios']);
});

test('app-specific changes only rebuild that app', () => {
  assert.deepEqual(builds(planRelease(['desktop/main.js'])), ['desktop']);
  assert.deepEqual(builds(planRelease(['build/icon-mac.png'])), ['desktop']);
  assert.deepEqual(builds(planRelease(['android/app/build.gradle'])), ['android']);
  assert.deepEqual(builds(planRelease(['ios/App/App/Info.plist'])), ['ios']);
  assert.deepEqual(builds(planRelease(['capacitor.config.json'])), ['android', 'ios']);
  assert.deepEqual(builds(planRelease(['package-lock.json'])), ['android', 'desktop', 'ios']);
});

test('docs, tests and tools build nothing', () => {
  assert.deepEqual(builds(planRelease(['README.md', 'docs/APPS.md', 'test/codec.test.js', 'tools/release-ios.sh', 'AGENTS.md'])), []);
  assert.equal(planRelease(['README.md']).android.reason, 'no changes');
});

test('first release or force builds everything', () => {
  assert.deepEqual(builds(planRelease(null)), ['android', 'desktop', 'ios']);
  assert.deepEqual(builds(planRelease([], { force: true })), ['android', 'desktop', 'ios']);
});

test('version codes increase through alpha, beta, rc to the final release', () => {
  const tags = ['v0.9.9', 'v1.2.3-alpha.1', 'v1.2.3-beta.1', 'v1.2.3-beta.2', 'v1.2.3-rc.1', 'v1.2.3-rc.2', 'v1.2.3', 'v1.2.4-alpha', 'v1.2.4', 'v1.10.0', 'v2.0.0'];
  const codes = tags.map((t) => versionFromTag(t).code);
  for (let i = 1; i < codes.length; i++) assert.ok(codes[i] > codes[i - 1], `${tags[i]} (${codes[i]}) > ${tags[i - 1]} (${codes[i - 1]})`);
  assert.equal(versionFromTag('v1.2.3').code, 1020399);
  assert.equal(versionFromTag('v1.2.3-beta.1').code, 1020334);
  assert.equal(versionFromTag('v1.2.3-beta.1').name, '1.2.3-beta.1');
  assert.equal(versionFromTag('v1.2.3-beta.1').prerelease, true);
  assert.equal(versionFromTag('1.2.3').prerelease, false);
  assert.ok(versionFromTag('v2100.0.0').code < 2 ** 31, 'fits a signed 32-bit int');
  assert.throws(() => versionFromTag('release-1'), /semantic version/);
  assert.throws(() => versionFromTag('v1.100.0'), /0-99/);
  assert.throws(() => versionFromTag('v1.0.0-beta.40'), /0-32/);
  // PR test builds (android-debug.yml): any PR number works, and they sort below the release.
  assert.equal(versionFromTag('v0.2.0-pr48').code, 20000);
  assert.equal(versionFromTag('v0.2.0-pr48').name, '0.2.0-pr48');
  assert.equal(versionFromTag('v0.2.0-dev').code, 20000);
});

test('the iOS build check runs for every path that rebuilds iOS', () => {
  const wf = readFileSync(new URL('../.github/workflows/ios-build.yml', import.meta.url), 'utf8');
  for (const path of ['src/**', 'ios/**', 'capacitor.config.json', 'package.json', 'package-lock.json']) {
    assert.ok(wf.includes(`- '${path}'`), `ios-build.yml paths should include ${path}`);
  }
  const rel = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const job = rel.slice(rel.indexOf('\n  ios:'), rel.indexOf('\n  release:'));
  assert.match(job, /continue-on-error: true/, 'a failed iOS build must not block the release');
  // iOS builds stay off until the maintainer turns them on with the repo variable
  assert.match(job, /if: vars\.IOS_BUILDS_ENABLED == 'true' && /);
  assert.match(wf, /\n {4}if: vars\.IOS_BUILDS_ENABLED == 'true'\n/);
  assert.doesNotMatch(rel, /needs: \[[^\]]*\bios\b/, 'the release job must not wait for iOS');
});
