import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SparkClient } from '../src/spark/client.js';
import { MockSparkTransport, demoPresets } from '../src/spark/transport-mock.js';

async function connected(opts) {
  const t = new MockSparkTransport({ latencyMs: 1, ...opts });
  const c = new SparkClient(t, { timeoutMs: 500 });
  await c.connect();
  return { t, c };
}

test('handshake against simulated amp', async () => {
  const { c } = await connected({ name: 'Spark GO' });
  const info = await c.handshake();
  assert.equal(info.name, 'Spark GO');
  assert.equal(info.serial, 'S40SIM0000001');
  assert.equal(info.firmware, '1.9.7.60');
  assert.equal(info.presetNumber, 0);
  assert.equal(info.status.charging, 'discharging');
  assert.equal(info.status.batteryRaw, 3900);
});

test('Spark 40 without battery status still handshakes', async () => {
  const { c } = await connected({ battery: false });
  const info = await c.handshake();
  assert.equal(info.name, 'Spark 40');
  assert.equal(info.status, null);
});

test('read presets, change params, toggle effects, swap amp', async () => {
  const { t, c } = await connected();
  const p2 = await c.getPreset(1);
  assert.equal(p2.name, demoPresets()[1].name);

  await c.selectPreset(2);
  let cur = await c.getPreset('current');
  assert.equal(cur.current, true);
  assert.equal(cur.name, 'Treadplate Lead');

  await c.setParam('Rectifier', 0, 0.123);
  await c.setEffectOnOff('Flanger', true);
  await c.changeEffect('Rectifier', 'EVH');
  cur = await c.getPreset('current');
  assert.equal(cur.pedals[4].isOn, true);
  assert.equal(cur.pedals[3].name, 'EVH');
  assert.equal(t.current.pedals[3].name, 'EVH');
});

test('param 01 04 reaches the amp', async () => {
  const { t, c } = await connected();
  await c.setParam('RolandJC120', 4, 0.9);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.current.pedals[3].params[4], Math.fround(0.9));
});

test('upload preset to temp slot and activate', async () => {
  const { c } = await connected();
  const p = demoPresets()[3];
  p.name = 'Uploaded';
  await c.loadPreset(p);
  const cur = await c.getPreset('current');
  assert.equal(cur.name, 'Uploaded');
});

test('amp-side events are emitted', async () => {
  const { t, c } = await connected();
  const got = [];
  c.addEventListener('param', (e) => got.push(e.detail));
  c.addEventListener('presetSelected', (e) => got.push(e.detail));
  t.turnKnob(3, 0, 0.77);
  t.pressPreset(3);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(got[0].type, 'param');
  assert.equal(got[0].effect, 'RolandJC120');
  assert.equal(got[0].value, Math.fround(0.77));
  assert.equal(got[0].solicited, false);
  assert.equal(got[1].slot, 3);
});

test('Spark 2: second bank is hardware slots 4-7 via the same 01 38 message', async () => {
  const { t, c } = await connected({ name: 'Spark 2' });
  const info = await c.handshake();
  assert.equal(info.model.presetSlots, 8);

  await c.selectPreset(5); // bank 2, preset 2
  assert.equal(t.slot, 5);
  assert.equal((await c.getPreset('current')).name, 'Crunch Plexi B');
  assert.equal((await c.getPreset(6)).name, 'Treadplate Lead B');

  const got = [];
  c.addEventListener('presetSelected', (e) => got.push(e.detail.slot));
  t.pressPreset(7); // bank 2, preset 4 pressed on the amp
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got, [7]);
});

test('tryChainOrder: fixed-chain amp normalises the order, flexible amp keeps it', async () => {
  const reordered = (p) => ({ ...p, pedals: [p.pedals[0], p.pedals[2], p.pedals[1], ...p.pedals.slice(3)] }); // drive before comp
  for (const fixedChain of [true, false]) {
    const { c } = await connected({ fixedChain });
    const p = await c.getPreset('current');
    const r = await c.tryChainOrder(reordered(p));
    assert.equal(r.accepted, !fixedChain);
    assert.equal(r.preset.pedals[1].name, fixedChain ? p.pedals[1].name : p.pedals[2].name);
  }
});
