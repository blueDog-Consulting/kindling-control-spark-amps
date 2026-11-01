// Web Bluetooth transport (Chrome / Edge on Android, Windows, macOS, Linux,
// ChromeOS, and the Electron desktop app). Needs a secure context.
//
// Write mode: like Ignitron (tested on Spark 40 / MINI / GO / 2), we prefer
// write-without-response. Some amps (seen on Spark 2 + macOS) fail
// write-with-response with "GATT operation failed for unknown reason". If the
// preferred mode fails we switch to the other one once and remember it.

import { BLE_SERVICE, BLE_WRITE_CHAR, BLE_NOTIFY_CHAR, UNKNOWN_MODEL } from './constants.js';

export class WebBluetoothTransport {
  constructor({ writeMode = 'auto' } = {}) {
    this.writeMode = writeMode; // 'auto' | 'withoutResponse' | 'withResponse'
    this.maxWrite = UNKNOWN_MODEL.maxBleWrite;
    this.blockDelayMs = UNKNOWN_MODEL.blockDelayMs;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.onLog = () => {};
    this.device = null;
    this.bluetooth = globalThis.navigator?.bluetooth;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect() {
    if (!this.bluetooth) {
      throw new Error('Web Bluetooth is not available in this browser. Use Chrome on Android or desktop.');
    }
    this.device = await this.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE] }, { namePrefix: 'Spark' }],
      optionalServices: [BLE_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect());
    this.onLog(`selected "${this.device.name}"`);

    const server = await step('connect to GATT server', () => this.device.gatt.connect());
    const service = await step('find Spark service 0xFFC0', () => server.getPrimaryService(BLE_SERVICE));
    this.tx = await step('find write characteristic 0xFFC1', () => service.getCharacteristic(BLE_WRITE_CHAR));
    this.rx = await step('find notify characteristic 0xFFC2', () => service.getCharacteristic(BLE_NOTIFY_CHAR));
    this.onLog(`0xFFC1 supports: ${describe(this.tx.properties)}`);
    this.onLog(`0xFFC2 supports: ${describe(this.rx.properties)}`);

    if (this.writeMode === 'auto') {
      const p = this.tx.properties ?? {};
      this.writeMode = p.writeWithoutResponse || !p.write ? 'withoutResponse' : 'withResponse';
    }
    this.onLog(`writing ${this.writeMode === 'withResponse' ? 'with' : 'without'} response`);

    this.rx.addEventListener('characteristicvaluechanged', (ev) => {
      const v = ev.target.value;
      this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    // macOS occasionally fails the first CCCD write right after connecting; retry once.
    await step('start notifications on 0xFFC2', () => this.rx.startNotifications(), { retries: 1, delayMs: 400 });
    return { name: this.device.name, id: this.device.id };
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  configure(model) {
    this.maxWrite = model.maxBleWrite;
    this.blockDelayMs = model.blockDelayMs;
  }

  async write(block) {
    for (let i = 0; i < block.length; i += this.maxWrite) {
      await this._writePart(block.subarray(i, i + this.maxWrite));
    }
    if (this.blockDelayMs) await sleep(this.blockDelayMs);
  }

  async _writePart(part) {
    try {
      await this._writeWith(this.writeMode, part);
    } catch (err) {
      if (this.switchedMode || !this.device?.gatt?.connected) throw wrap('write to 0xFFC1', err);
      const other = this.writeMode === 'withResponse' ? 'withoutResponse' : 'withResponse';
      this.onLog(`write ${this.writeMode} failed (${err.message}); retrying ${other}`);
      this.switchedMode = true;
      this.writeMode = other;
      try {
        await this._writeWith(other, part);
      } catch (err2) {
        throw wrap('write to 0xFFC1 (both write modes)', err2);
      }
    }
  }

  _writeWith(mode, part) {
    if (mode === 'withResponse') {
      return this.tx.writeValueWithResponse ? this.tx.writeValueWithResponse(part) : this.tx.writeValue(part);
    }
    return this.tx.writeValueWithoutResponse(part);
  }
}

async function step(what, fn, { retries = 0, delayMs = 0 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw wrap(what, err);
      await sleep(delayMs);
    }
  }
}

function wrap(what, err) {
  const e = new Error(`${what} failed: ${err.message}`, { cause: err });
  e.name = err.name;
  e.step = what;
  return e;
}

function describe(p = {}) {
  const keys = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate'];
  return keys.filter((k) => p[k]).join(', ') || 'unknown';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
