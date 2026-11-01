import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapacitorBleTransport } from '../src/spark/transport-capacitor.js';
import { MockSparkTransport } from '../src/spark/transport-mock.js';
import { SparkClient } from '../src/spark/client.js';
import { fromHex, toHex } from '../src/spark/codec.js';

const SVC = '0000ffc0-0000-1000-8000-00805f9b34fb';
const WR = '0000ffc1-0000-1000-8000-00805f9b34fb';
const NT = '0000ffc2-0000-1000-8000-00805f9b34fb';

/** Fake of the raw native BluetoothLe plugin, backed by the simulated amp. */
function fakeNativePlugin(amp, { mtu = 185 } = {}) {
  const listeners = new Map();
  const writes = [];
  const plugin = {
    writes,
    initialize: async () => {},
    isEnabled: async () => ({ value: true }),
    requestDevice: async (opts) => {
      assert.deepEqual(opts.services, [SVC]);
      return { deviceId: 'AA:BB', name: 'Spark 40 BLE' };
    },
    connect: async ({ deviceId }) => {
      assert.equal(deviceId, 'AA:BB');
      await amp.connect();
      amp.onData = (bytes) => listeners.get(`notification|AA:BB|${SVC}|${NT}`)?.({ value: toHex(bytes, '') });
    },
    startNotifications: async (o) => assert.deepEqual([o.service, o.characteristic], [SVC, NT]),
    getMtu: async () => ({ value: mtu }),
    write: async (o) => {
      assert.equal(o.characteristic, WR);
      assert.equal(typeof o.value, 'string');
      writes.push(o.value);
      await amp.write(fromHex(o.value));
    },
    writeWithoutResponse: async (o) => plugin.write(o),
    disconnect: async () => listeners.get('disconnected|AA:BB')?.(),
    addListener: async (key, cb) => {
      listeners.set(key, cb);
      return { remove: () => listeners.delete(key) };
    },
  };
  return plugin;
}

test('Capacitor transport drives the amp through the native plugin API', async (t) => {
  const amp = new MockSparkTransport({ latencyMs: 1, name: 'Spark MINI', battery: true });
  const plugin = fakeNativePlugin(amp);
  globalThis.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'ios', Plugins: { BluetoothLe: plugin } };
  t.after(() => delete globalThis.Capacitor);

  assert.ok(CapacitorBleTransport.isAvailable());
  const transport = new CapacitorBleTransport();
  const client = new SparkClient(transport, { timeoutMs: 500 });
  const r = await client.connect();
  assert.equal(r.name, 'Spark 40 BLE');

  const info = await client.handshake();
  assert.equal(info.name, 'Spark MINI');
  assert.equal(transport.maxWrite, 0x64, 'MINI uses smaller writes');

  const p = await client.getPreset('current');
  assert.equal(p.pedals.length, 7);

  // a preset upload is several 0xAD blocks; each must be split into <=0x64-byte writes
  plugin.writes.length = 0;
  await client.loadPreset({ ...p, name: 'From iPad' });
  assert.ok(plugin.writes.length > 3);
  assert.ok(plugin.writes.every((h) => h.length / 2 <= 0x64));
  assert.equal((await client.getPreset('current')).name, 'From iPad');

  let gone = false;
  client.addEventListener('disconnected', () => (gone = true));
  await client.disconnect();
  assert.ok(gone);
});

test('isAvailable is false in a plain browser', () => {
  assert.equal(CapacitorBleTransport.isAvailable(), false);
});
