import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocs, findOptOut } from '../tools/check-docs.js';

test('non-material changes pass without docs', () => {
  assert.equal(checkDocs(['test/codec.test.js', 'src/app/styles.css', 'NOTICE']).ok, true);
});

test('material change needs both AGENTS.md and a doc', () => {
  const code = 'src/spark/client.js';
  assert.deepEqual(checkDocs([code]).missing, ['AGENTS.md', 'README.md or docs/*.md']);
  assert.deepEqual(checkDocs([code, 'docs/PROTOCOL.md']).missing, ['AGENTS.md']);
  assert.deepEqual(checkDocs([code, 'AGENTS.md']).missing, ['README.md or docs/*.md']);
  assert.equal(checkDocs([code, 'AGENTS.md', 'README.md']).ok, true);
  assert.equal(checkDocs(['desktop/main.js', 'AGENTS.md', 'docs/APPS.md']).ok, true);
});

test('native config, scripts and CI count as material', () => {
  for (const f of ['ios/App/App/Info.plist', 'android/app/src/main/AndroidManifest.xml', 'package.json', '.github/workflows/ci.yml', 'tools/serve.js', 'src/index.html']) {
    assert.equal(checkDocs([f]).ok, false, f);
  }
});

test('opt-out trailer skips the check', () => {
  const reason = findOptOut('Fix typo in log message\n\nDocs-Not-Needed: wording only\n');
  assert.equal(reason, 'wording only');
  const r = checkDocs(['src/app/app.js'], { optOut: reason });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'wording only');
  assert.equal(findOptOut('Normal commit\n\nCo-Authored-By: x'), undefined);
});
