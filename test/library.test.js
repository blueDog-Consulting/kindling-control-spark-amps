import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresetLibrary } from '../src/app/library.js';
import { blankPreset, paramInfo } from '../src/spark/effects.js';
import { SparkClient } from '../src/spark/client.js';
import { MockSparkTransport } from '../src/spark/transport-mock.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

test('library saves, replaces by uuid, persists and removes', () => {
  const storage = memoryStorage();
  const lib = new PresetLibrary(storage);
  const p = { ...blankPreset('Mine'), uuid: 'U-1' };
  lib.save(p);
  lib.save({ ...p, name: 'Mine v2' });
  lib.save({ ...blankPreset('Other'), uuid: 'U-2' });
  const again = new PresetLibrary(storage);
  assert.equal(again.list().length, 2);
  assert.equal(again.get('U-1').name, 'Mine v2');
  assert.deepEqual(again.get('U-1').pedals.map((f) => f.name), p.pedals.map((f) => f.name));
  again.remove('U-1');
  assert.deepEqual(new PresetLibrary(storage).list().map((x) => x.name), ['Other']);
});

test('library survives missing or corrupt storage', () => {
  const lib = new PresetLibrary(null);
  lib.save({ ...blankPreset(), uuid: 'X' });
  assert.equal(lib.list().length, 1);
  assert.equal(lib.persistent, false);
  const bad = memoryStorage();
  bad.setItem('spark-control.presets.v1', '{not json');
  assert.deepEqual(new PresetLibrary(bad).list(), []);
});

test('unknown amp models still get Gain / Treble / Middle / Bass / Volume labels', () => {
  assert.equal(paramInfo('SomeNewSpark2Amp', 0, 'amp').name, 'Gain');
  assert.equal(paramInfo('SomeNewSpark2Amp', 3, 'amp').name, 'Bass');
  assert.equal(paramInfo('SomeNewPedal', 0, 'drive').name, 'Param 1');
  assert.equal(paramInfo('Twin', 2).name, 'Middle');
});

test('storePreset writes a new preset into a Spark 2 bank-2 slot and selects it', async () => {
  const t = new MockSparkTransport({ latencyMs: 1, name: 'Spark 2' });
  const c = new SparkClient(t, { timeoutMs: 1000 });
  await c.connect();
  await c.handshake();
  await c.storePreset({ ...blankPreset('Brand New'), uuid: 'NEW-1' }, 6);
  assert.equal(t.slot, 6);
  assert.equal(t.presets[6].name, 'Brand New');
  assert.equal((await c.getPreset('current')).name, 'Brand New');
  await assert.rejects(c.storePreset(blankPreset(), 0x7f), RangeError);
});
