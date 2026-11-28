import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SparkClient } from '../src/spark/client.js';
import { MockSparkTransport, demoPresets } from '../src/spark/transport-mock.js';
import { requestPreset } from '../src/spark/messages.js';

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

test('swapEffect uses 01 06 when the amp takes it', async () => {
  const { t, c } = await connected();
  const sent = [];
  c.addEventListener('sent', (e) => sent.push(`${e.detail.cmd}:${e.detail.sub}`));
  const { method, preset } = await c.swapEffect('ChorusAnalog', 'UniVibe');
  assert.equal(method, 'swap');
  assert.equal(preset.pedals[4].name, 'UniVibe');
  assert.equal(t.slot, 0); // still on the hardware preset
  assert.ok(!sent.includes('1:1'), 'no preset upload');
});

for (const [swap, how] of [['ignore', 'acks 01 06 but keeps the old model'], ['silent', 'never acks 01 06']]) {
  test(`swapEffect falls back to the temporary slot when the amp ${how}`, async () => {
    const t = new MockSparkTransport({ latencyMs: 1, swap });
    const c = new SparkClient(t, { timeoutMs: 150 });
    await c.connect();
    const stored = structuredClone(t.presets[0]);
    const { method, preset } = await c.swapEffect('ChorusAnalog', 'UniVibe');
    assert.equal(method, 'preset');
    assert.equal(preset.pedals[4].name, 'UniVibe');
    assert.deepEqual(preset.pedals[4].params, [0.5, 0, 0.5]); // knob, switch, knob
    assert.equal(preset.pedals[4].isOn, true); // keeps the slot's on/off state
    assert.equal(t.slot, 0x7f);
    assert.deepEqual(t.presets[0], stored); // nothing stored changed
  });
}

test('swapEffect rejects when the effect is not in the live preset', async () => {
  const { c } = await connected({ swap: 'ignore' });
  await assert.rejects(c.swapEffect('NoSuchFx', 'UniVibe'), /isn't in the amp's current preset/);
});

// Issue #9: "timeout waiting for 3:1" when preset reads overlap (e.g. the amp's preset
// button pressed twice quickly, each press triggering a refresh).
test('overlapping preset reads are sent one at a time, so none times out (#9)', async () => {
  const { t, c } = await connected({ busyPresets: true });
  const sent = [];
  c.addEventListener('sent', (e) => e.detail.sub === 0x01 && sent.push(performance.now()));
  const [a, b, d] = await Promise.all([c.getPreset('current'), c.getPreset(1), c.getPreset(2)]);
  assert.equal(a.current, true);
  assert.equal(a.name, t.current.name);
  assert.equal(b.name, demoPresets()[1].name);
  assert.equal(d.name, demoPresets()[2].name);
  assert.equal(sent.length, 3);
});

test('a failed request does not block the next one with the same reply key', async () => {
  const { t, c } = await connected();
  t.presets[3] = null; // the mock stays silent for an empty slot
  const missing = c.request(requestPreset(3), { timeoutMs: 50 });
  const next = c.getPreset(1);
  await assert.rejects(missing, /timeout waiting for 3:1/);
  assert.equal((await next).name, demoPresets()[1].name);
});

test('different reply keys still run concurrently', async () => {
  const { c } = await connected({ name: 'Spark GO' });
  const [name, preset] = await Promise.all([c.ampName(), c.getPreset('current')]);
  assert.equal(name, 'Spark GO');
  assert.equal(preset.current, true);
});

test('handshake fails if the amp drops the link part-way (#43)', async () => {
  const { t, c } = await connected();
  let disconnected = 0;
  c.addEventListener('disconnected', () => disconnected++);
  // Drop the link right after the amp has answered the name request.
  const request = t._request.bind(t);
  t._request = (sub, m, seq) => {
    const r = request(sub, m, seq);
    if (sub === 0x11) setTimeout(() => t.disconnect(), 5);
    return r;
  };
  assert.equal(c.connected, true);
  await assert.rejects(c.handshake(), /disconnected/);
  assert.equal(c.connected, false);
  assert.equal(disconnected, 1);
});

test('handshake fails at once if the link drops before the name arrives', async () => {
  const { t, c } = await connected({ latencyMs: 50 });
  setTimeout(() => t.disconnect(), 5);
  await assert.rejects(c.handshake(), /disconnected/);
});

test('handshake retries the amp name once when the first request is ignored (issue #26)', async () => {
  const { c } = await connected({ dropFirstRequests: 1 });
  const info = await c.handshake();
  assert.equal(info.name, 'Spark 40');
});

test('handshake still fails when the amp never answers the name request', async () => {
  const { c } = await connected({ dropFirstRequests: 2 });
  await assert.rejects(c.handshake(), /timeout waiting for 3:17/);
});

test('a request is only retried after a timeout, not after a disconnect', async () => {
  const { t, c } = await connected({ dropFirstRequests: 1 });
  const sent = [];
  c.addEventListener('sent', (e) => sent.push(e.detail.sub));
  const p = c.ampName({ retries: 1 });
  setTimeout(() => t.disconnect(), 20);
  await assert.rejects(p, /^Error: disconnected$/);
  assert.equal(sent.length, 1);
});

test('a disconnect during the retry pause is reported as disconnected', async () => {
  const { t, c } = await connected({ dropFirstRequests: 1 });
  const p = c.ampName({ retries: 1, retryDelayMs: 200 });
  setTimeout(() => t.disconnect(), 550); // after the 500 ms timeout, before the retry
  await assert.rejects(p, /^Error: disconnected$/);
});

test('handshake retries the other reads too', async () => {
  const { t, c } = await connected();
  const realRequest = t._request.bind(t);
  let serialAsks = 0;
  t._request = (sub, m, seq) => (sub === 0x23 && serialAsks++ === 0 ? undefined : realRequest(sub, m, seq));
  const info = await c.handshake();
  assert.equal(serialAsks, 2);
  assert.equal(info.serial, 'S40SIM0000001');
});

test('the retry resets a decoder stuck inside a reply that was cut off', async () => {
  const { t, c } = await connected();
  const realRequest = t._request.bind(t);
  let first = true;
  t._request = (sub, m, seq) => {
    if (!first) return realRequest(sub, m, seq);
    first = false;
    t.onData(Uint8Array.from([0x01, 0xfe, 0, 0, 0x41, 0xff, 0x17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xf0, 0x01, seq, 0]));
  };
  assert.equal(await c.ampName({ retries: 1 }), 'Spark 40');
});

test('a late reply to a retried request is not reported as an amp-side event', async () => {
  const { t, c } = await connected();
  const realRequest = t._request.bind(t);
  let first = true;
  t._request = (sub, m, seq) => {
    if (!first) return realRequest(sub, m, seq);
    first = false;
    setTimeout(() => realRequest(sub, m, seq), 600); // answers after the 500 ms timeout, during the retry
  };
  const events = [];
  c.addEventListener('ampName', (e) => events.push(e.detail.solicited));
  assert.equal(await c.ampName({ retries: 1, retryDelayMs: 50 }), 'Spark 40');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(events, [true]);
});

/** Flips the checksum byte of the first chunk of the next `times` 03 01 preset replies the amp sends. */
function damagePresetReplies(t, times) {
  const deliver = t.onData;
  let left = times;
  t.onData = (bytes) => {
    const b = Uint8Array.from(bytes);
    for (let i = 0; left > 0 && i + 5 < b.length; i++) {
      if (b[i] === 0xf0 && b[i + 1] === 0x01 && b[i + 4] === 0x03 && b[i + 5] === 0x01) {
        b[i + 3] ^= 0x01;
        left--;
        break;
      }
    }
    deliver(b);
  };
}

test('a preset that arrives with a bad checksum is read once more (#30)', async () => {
  const { t, c } = await connected();
  const sent = [];
  const logs = [];
  c.addEventListener('sent', (e) => e.detail.sub === 0x01 && e.detail.cmd === 0x02 && sent.push(e.detail));
  c.addEventListener('log', (e) => logs.push(e.detail.text));
  damagePresetReplies(t, 1);
  const p = await c.getPreset(1);
  assert.equal(p.name, demoPresets()[1].name);
  assert.equal(sent.length, 2);
  assert.ok(logs.some((l) => l.includes('arrived damaged')), logs.join('\n'));
});

test('a preset damaged twice is returned after one re-read, not retried forever (#30)', async () => {
  const { t, c } = await connected();
  const sent = [];
  c.addEventListener('sent', (e) => e.detail.sub === 0x01 && e.detail.cmd === 0x02 && sent.push(e.detail));
  damagePresetReplies(t, 5);
  const p = await c.getPreset(1);
  assert.equal(p.name, demoPresets()[1].name);
  assert.equal(sent.length, 2);
});

test('a clean preset read is not repeated', async () => {
  const { c } = await connected();
  const sent = [];
  c.addEventListener('sent', (e) => e.detail.sub === 0x01 && e.detail.cmd === 0x02 && sent.push(e.detail));
  await c.getPreset(0);
  assert.equal(sent.length, 1);
});
