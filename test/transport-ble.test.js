import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WebBluetoothTransport } from '../src/spark/transport-ble.js';
import { MockSparkTransport } from '../src/spark/transport-mock.js';
import { SparkClient } from '../src/spark/client.js';

/**
 * Fake navigator.bluetooth whose characteristics behave like a picky amp:
 * configurable properties, write-with-response optionally failing the way
 * Chrome on macOS reports it, and a flaky first startNotifications().
 */
function fakeBluetooth(amp, { props = { write: true, writeWithoutResponse: true }, withResponseFails = false, flakyNotify = false, serviceDropsFirst = false, connectFails = 0 } = {}) {
  const log = { withResponse: [], withoutResponse: [], notifyAttempts: 0 };
  const notFound = () => Object.assign(new Error('GATT operation failed for unknown reason.'), { name: 'NotSupportedError' });
  const rx = new EventTarget();
  rx.properties = { notify: true };
  rx.startNotifications = async () => {
    log.notifyAttempts++;
    if (flakyNotify && log.notifyAttempts === 1) throw notFound();
    amp.onData = (bytes) => {
      const ev = new Event('characteristicvaluechanged');
      Object.defineProperty(ev, 'target', { value: { value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) } });
      rx.dispatchEvent(ev);
    };
  };
  const tx = {
    properties: props,
    writeValueWithResponse: async (v) => {
      log.withResponse.push(v.length);
      if (withResponseFails) throw notFound();
      await amp.write(v);
    },
    writeValueWithoutResponse: async (v) => {
      log.withoutResponse.push(v.length);
      await amp.write(v);
    },
  };
  const device = Object.assign(new EventTarget(), {
    name: 'Spark 2 BLE',
    id: 'dev1',
    gatt: {
      connected: true,
      connect: async () => {
        log.connectAttempts = (log.connectAttempts ?? 0) + 1;
        if (log.connectAttempts <= connectFails) {
          throw Object.assign(new Error('Connection Error: Connection attempt failed.'), { name: 'NetworkError' });
        }
        await amp.connect();
        return { getPrimaryService: async () => {
          log.serviceAttempts = (log.serviceAttempts ?? 0) + 1;
          if (serviceDropsFirst && log.serviceAttempts === 1) {
            throw Object.assign(new Error('GATT Server is disconnected. Cannot retrieve services.'), { name: 'NetworkError' });
          }
          return ({ getCharacteristic: async (u) => (u === 0xffc1 ? tx : rx) }); } };
      },
      disconnect() {},
    },
  });
  return { bluetooth: { requestDevice: async () => device }, log };
}

async function run(opts) {
  const amp = new MockSparkTransport({ latencyMs: 1, name: 'Spark 2', battery: true });
  const { bluetooth, log } = fakeBluetooth(amp, opts);
  const t = new WebBluetoothTransport();
  t.bluetooth = bluetooth;
  const lines = [];
  const client = new SparkClient(t, { timeoutMs: 1000 });
  client.addEventListener('log', (e) => lines.push(e.detail.text));
  await client.connect();
  const info = await client.handshake();
  return { t, client, info, log, lines };
}

test('prefers write-without-response and splits to <= 0x64 bytes for Spark 2', async () => {
  const { t, client, info, log } = await run();
  assert.equal(info.name, 'Spark 2');
  assert.equal(log.withResponse.length, 0);
  assert.ok(log.withoutResponse.length > 0);
  assert.equal(t.maxWrite, 0x64);
  assert.equal(t.blockDelayMs, 80);
  const p = await client.getPreset('current');
  await client.loadPreset(p); // multi-block upload
  assert.ok(log.withoutResponse.every((n) => n <= 0x64));
});

test('macOS: flaky first startNotifications is retried', async () => {
  const { info, log } = await run({ flakyNotify: true });
  assert.equal(info.name, 'Spark 2');
  assert.equal(log.notifyAttempts, 2);
});

test('falls back to the other write mode when one fails', async () => {
  // characteristic claims only write-with-response, but that fails like on macOS
  const { info, log, lines } = await run({ props: { write: true }, withResponseFails: true });
  assert.equal(info.name, 'Spark 2');
  assert.equal(log.withResponse.length, 1);
  assert.ok(log.withoutResponse.length > 0);
  assert.ok(lines.some((l) => l.includes('retrying withoutResponse')), lines.join('\n'));
});

test('errors name the GATT step that failed', async () => {
  const amp = new MockSparkTransport({ latencyMs: 1 });
  const { bluetooth } = fakeBluetooth(amp);
  const t = new WebBluetoothTransport();
  t.bluetooth = {
    requestDevice: async () => {
      const d = await bluetooth.requestDevice();
      d.gatt.connect = async () => ({
        getPrimaryService: async () => {
          throw Object.assign(new Error('No Services matching UUID found in Device.'), { name: 'NotFoundError' });
        },
      });
      return d;
    },
  };
  await assert.rejects(t.connect(), (e) => e.message.startsWith('find Spark service 0xFFC0 failed') && e.name === 'NotFoundError');
});

test('a request before connect() finished fails with "not connected", not a TypeError (issue #47)', async () => {
  const t = new WebBluetoothTransport();
  t.bluetooth = { requestDevice: () => new Promise(() => {}) }; // device picker still open
  const client = new SparkClient(t, { timeoutMs: 1000 });
  client.connect(); // never finishes
  await assert.rejects(client.getPreset('current'), (err) => err.name === 'Error' && err.message === 'not connected');
});

test('Windows: GATT drop while finding the service is retried once (#41)', async () => {
  const { info, log } = await run({ serviceDropsFirst: true });
  assert.equal(info.name, 'Spark 2');
  assert.equal(log.serviceAttempts, 2);
});

test('Linux: a failed GATT connect is retried, waiting longer the second time (#44)', async () => {
  const { info, log, lines } = await run({ connectFails: 2 });
  assert.equal(info.name, 'Spark 2');
  assert.equal(log.connectAttempts, 3);
  assert.ok(lines.some((l) => l.includes('connect to GATT server failed') && l.includes('retrying in 400 ms')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('retrying in 1200 ms')), lines.join('\n'));
});

test('Linux: gives up after three failed GATT connects and names the step (#44)', async () => {
  await assert.rejects(run({ connectFails: 3 }), (err) => err.name === 'NetworkError'
    && err.message === 'connect to GATT server failed: Connection Error: Connection attempt failed.');
});

test('a non-network error from GATT connect is not retried', async () => {
  const amp = new MockSparkTransport({ latencyMs: 1, name: 'Spark 2' });
  const { bluetooth } = fakeBluetooth(amp);
  let calls = 0;
  const device = await bluetooth.requestDevice();
  device.gatt.connect = async () => {
    calls++;
    throw Object.assign(new Error('User cancelled'), { name: 'NotAllowedError' });
  };
  const t = new WebBluetoothTransport();
  t.bluetooth = bluetooth;
  await assert.rejects(t.connect(), (err) => err.name === 'NotAllowedError');
  assert.equal(calls, 1);
});
