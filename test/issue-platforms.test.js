import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { HEADING, PLATFORMS, platformLabels } from '../tools/issue-platforms.js';

const body = (answer) => `### What happened?\n\nIt broke.\n\n### ${HEADING}\n\n${answer}\n\n### Amp model\n\nSpark 2\n`;

test('maps the form answers to platform labels', () => {
  assert.deepEqual(platformLabels(body('Android app')), ['platform:android']);
  assert.deepEqual(platformLabels(body('Android app, Desktop app (Windows/macOS/Linux)')), [
    'platform:desktop',
    'platform:android',
  ]);
  assert.deepEqual(platformLabels(body('iPhone or iPad app, Browser (development build)')), ['platform:ios', 'platform:web']);
});

test('"not sure", missing sections and junk give no labels', () => {
  assert.deepEqual(platformLabels(body('Not sure')), []);
  assert.deepEqual(platformLabels(body('_No response_')), []);
  assert.deepEqual(platformLabels('Something broke on Android app'), []);
  assert.deepEqual(platformLabels(undefined), []);
});

test('only exact option text counts, never text that names a label', () => {
  assert.deepEqual(platformLabels(body('platform:android, superpowers:approved, Android apps')), []);
  // An "App" heading later in a free-text answer doesn't matter: the first one is the form's.
  assert.deepEqual(platformLabels(body('Android app') + `\n### ${HEADING}\n\niPhone or iPad app\n`), ['platform:android']);
});

test('handles CRLF bodies', () => {
  assert.deepEqual(platformLabels(body('Android app').replace(/\n/g, '\r\n')), ['platform:android']);
});

test('every form with an App dropdown offers exactly the known options', () => {
  const dir = '.github/ISSUE_TEMPLATE';
  const forms = readdirSync(dir).filter((f) => f.endsWith('.yml') && f !== 'config.yml');
  assert.ok(forms.length >= 2);
  for (const f of forms) {
    const text = readFileSync(`${dir}/${f}`, 'utf8');
    assert.ok(text.includes(`label: ${HEADING}\n`), `${f} has an ${HEADING} dropdown`);
    for (const p of PLATFORMS) {
      assert.ok(text.includes(`- ${p.option}\n`), `${f} offers "${p.option}"`);
      assert.ok(!p.option.includes(','), 'options must not contain commas (multi-select answers are comma-separated)');
    }
  }
});
