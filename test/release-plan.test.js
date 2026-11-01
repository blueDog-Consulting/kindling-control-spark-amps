import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRelease, versionFromTag } from '../tools/release-plan.js';

const builds = (plan) => Object.entries(plan).filter(([, p]) => p.build).map(([a]) => a).sort();

test('shared web code rebuilds every app', () => {
  assert.deepEqual(builds(planRelease(['src/app/rig.js'])), ['android', 'desktop', 'web']);
});

test('app-specific changes only rebuild that app', () => {
  assert.deepEqual(builds(planRelease(['desktop/main.js'])), ['desktop']);
  assert.deepEqual(builds(planRelease(['build/icon-mac.png'])), ['desktop']);
  assert.deepEqual(builds(planRelease(['android/app/build.gradle', 'capacitor.config.json'])), ['android']);
  assert.deepEqual(builds(planRelease(['wrangler.jsonc'])), ['web']);
  assert.deepEqual(builds(planRelease(['site/index.html', 'site/screenshots/rig-desktop.jpg'])), ['web']);
  assert.deepEqual(builds(planRelease(['package-lock.json'])), ['android', 'desktop']);
});

test('docs, tests, tools and iOS changes build nothing', () => {
  assert.deepEqual(builds(planRelease(['README.md', 'docs/APPS.md', 'test/codec.test.js', 'ios/App/App/Info.plist', 'AGENTS.md'])), []);
  assert.equal(planRelease(['README.md']).web.reason, 'no changes');
});

test('first release or force builds everything', () => {
  assert.deepEqual(builds(planRelease(null)), ['android', 'desktop', 'web']);
  assert.deepEqual(builds(planRelease([], { force: true })), ['android', 'desktop', 'web']);
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
});
