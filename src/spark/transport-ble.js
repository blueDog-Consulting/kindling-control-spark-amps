// Web Bluetooth transport (Chrome / Edge on Android, Windows, macOS, Linux, ChromeOS).
// Requires a secure context (https:// or http://localhost).

import { BLE_SERVICE, BLE_WRITE_CHAR, BLE_NOTIFY_CHAR, DEFAULT_MODEL } from './constants.js';

export class WebBluetoothTransport {
  constructor({ withResponse = true } = {}) {
    this.withResponse = withResponse;
    this.maxWrite = DEFAULT_MODEL.maxBleWrite;
    this.writeDelayMs = DEFAULT_MODEL.writeDelayMs;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.device = null;
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect() {
    if (!WebBluetoothTransport.isSupported()) {
      throw new Error('Web Bluetooth is not available in this browser. Use Chrome on Android or desktop.');
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE_SERVICE] }, { namePrefix: 'Spark' }],
      optionalServices: [BLE_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect());
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(BLE_SERVICE);
    this.tx = await service.getCharacteristic(BLE_WRITE_CHAR);
    this.rx = await service.getCharacteristic(BLE_NOTIFY_CHAR);
    this.rx.addEventListener('characteristicvaluechanged', (ev) => {
      const v = ev.target.value;
      this.onData(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    });
    await this.rx.startNotifications();
    return { name: this.device.name, id: this.device.id };
  }

  async disconnect() {
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }

  configure(model) {
    this.maxWrite = model.maxBleWrite;
    this.writeDelayMs = model.writeDelayMs;
  }

  async write(block) {
    for (let i = 0; i < block.length; i += this.maxWrite) {
      const part = block.subarray(i, i + this.maxWrite);
      if (this.withResponse && this.tx.writeValueWithResponse) await this.tx.writeValueWithResponse(part);
      else if (this.tx.writeValueWithoutResponse) await this.tx.writeValueWithoutResponse(part);
      else await this.tx.writeValue(part);
      if (this.writeDelayMs) await sleep(this.writeDelayMs);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
