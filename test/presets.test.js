// Checks the shared starter presets in presets/*.json: they must import, use known effects in the standard
// slot order, keep values in range and encode into a valid 01 01 preset upload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import * as M from '../src/spark/messages.js';
import { findEffect, SLOT_ORDER } from '../src/spark/effects.js';

const dir = new URL('../presets/', import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith('.json'));

test('there is at least one starter preset', () => {
  assert.ok(files.length > 0);
});

for (const file of files) {
  test(`presets/${file}`, () => {
    const json = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const p = M.presetFromJson(json);

    assert.match(p.uuid, /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
    assert.equal(p.slot, 0x7f, 'shared presets target the temporary slot');
    for (const s of [p.name, p.description]) {
      assert.match(s, /^[\x20-\x7e]*$/, 'strings are sent as ASCII');
      assert.ok(s.length <= 255);
    }
    assert.ok(p.name.length > 0 && p.name.length <= 31, 'name fits the amp display');

    assert.equal(p.pedals.length, 7);
    p.pedals.forEach((fx, i) => {
      const e = findEffect(fx.name);
      assert.ok(e, `${fx.name} is a known effect`);
      assert.equal(e.slot, SLOT_ORDER[i], `${fx.name} sits in the ${SLOT_ORDER[i]} slot`);
      assert.ok(fx.params.length >= e.params.length, `${fx.name} has all its parameters`);
      for (const v of fx.params) assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${fx.name} value ${v} in 0..1`);
    });

    // JSON round-trip keeps the file's content
    assert.deepEqual(M.presetToJson(p), json);

    // encodes for the amp and parses back with a valid checksum
    const bytes = M.presetWriter(p).toBytes();
    const back = M.parsePreset(bytes);
    assert.ok(back.checksumOk);
    assert.equal(back.name, p.name);
    assert.deepEqual(back.pedals.map((f) => f.name), p.pedals.map((f) => f.name));
  });
}
