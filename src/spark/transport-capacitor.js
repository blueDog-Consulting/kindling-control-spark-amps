// Native BLE transport for the Capacitor apps (Android, iPhone, iPad), using
// @capacitor-community/bluetooth-le. Capacitor's native bridge injects the
// plugin as window.Capacitor.Plugins.BluetoothLe, so no bundler is needed;
// the raw plugin API exchanges values as hex strings and wants 128-bit UUIDs.

import { BLE_SERVICE, BLE_WRITE_CHAR, BLE_NOTIFY_CHAR, UNKNOWN_MODEL } from './constants.js';
import { toHex, fromHex } from './codec.js';

const uuid128 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const SERVICE = uuid128(BLE_SERVICE);
const WRITE = uuid128(BLE_WRITE_CHAR);
const NOTIFY = uuid128(BLE_NOTIFY_CHAR);

export class CapacitorBleTransport {
  constructor({ withResponse = false } = {}) {
    // Without response by default, like Ignitron; we fall back to with-response once if that fails.
    this.withResponse = withResponse;
    this.maxWrite = UNKNOWN_MODEL.maxBleWrite;
    this.blockDelayMs = UNKNOWN_MODEL.blockDelayMs;
    this.mtuPayload = 20; // until getMtu tells us more
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.onLog = () => {};
    this.deviceId = null;
    this.listeners = [];
  }

  static isAvailable() {
    const cap = globalThis.Capacitor;
    return !!(cap?.isNativePlatform?.() && cap.Plugins?.BluetoothLe);
  }

  get ble() {
    return globalThis.Capacitor.Plugins.BluetoothLe;
  }

  async connect() {
    const ble = this.ble;
    await ble.initialize({ androidNeverForLocation: true });
    const { value: enabled } = await ble.isEnabled();
    if (!enabled) {
      // Android can prompt the user to switch Bluetooth on; iOS can't, so we just report it
      if (globalThis.Capacitor.getPlatform() === 'android') await ble.requestEnable();
      else throw new Error('Bluetooth is turned off. Turn it on in Control Center and try again.');
    }

    let device;
    try {
      device = await ble.requestDevice({ services: [SERVICE], optionalServices: [SERVICE] });
    } catch (err) {
      // Closing the native chooser rejects with "requestDevice cancelled." Mark it like Web Bluetooth's
      // NotFoundError so the app treats it as the user backing out, not a failure to report.
      if (/cancel/i.test(err?.message || '')) throw Object.assign(new Error(err.message), { name: 'NotFoundError' });
      throw err;
    }
    const id = device.deviceId;
    this.deviceId = id;

    await this._listen(`disconnected|${id}`, () => {
      this._cleanup();
      this.onDisconnect();
    });
    await ble.connect({ deviceId: id, timeout: 15000 });
    await this._listen(`notification|${id}|${SERVICE}|${NOTIFY}`, (ev) => {
      if (ev?.value) this.onData(fromHex(ev.value));
    });
    await ble.startNotifications({ deviceId: id, service: SERVICE, characteristic: NOTIFY });

    try {
      const { value: mtu } = await ble.getMtu({ deviceId: id });
      if (mtu > 23) this.mtuPayload = mtu - 3;
    } catch {
      // getMtu is Android/iOS only; keep the default
    }
    return { name: device.name, id };
  }

  async disconnect() {
    if (!this.deviceId) return;
    try {
      await this.ble.disconnect({ deviceId: this.deviceId });
    } finally {
      // the plugin fires the disconnected listener, which calls onDisconnect
    }
  }

  configure(model) {
    this.maxWrite = model.maxBleWrite;
    this.blockDelayMs = model.blockDelayMs;
  }

  async write(block) {
    if (!this.deviceId) throw new Error('not connected');
    // Writes with response can be longer than the MTU (the OS does a long write), but
    // without response they must fit in one packet.
    const size = this.withResponse ? this.maxWrite : Math.min(this.maxWrite, this.mtuPayload);
    for (let i = 0; i < block.length; i += size) {
      const value = toHex(block.subarray(i, i + size), '');
      try {
        await this._write(value);
      } catch (err) {
        if (this.switchedMode) throw new Error(`write to 0xFFC1 failed: ${err.message}`, { cause: err });
        this.switchedMode = true;
        this.withResponse = !this.withResponse;
        this.onLog(`write failed (${err.message}); retrying ${this.withResponse ? 'with' : 'without'} response`);
        // the other mode may allow a different size: restart this block from here
        return this.write(block.subarray(i));
      }
    }
    if (this.blockDelayMs) await new Promise((r) => setTimeout(r, this.blockDelayMs));
  }

  _write(value) {
    const opts = { deviceId: this.deviceId, service: SERVICE, characteristic: WRITE, value };
    return this.withResponse ? this.ble.write(opts) : this.ble.writeWithoutResponse(opts);
  }

  async _listen(event, cb) {
    this.listeners.push(await this.ble.addListener(event, cb));
  }

  _cleanup() {
    for (const l of this.listeners) l?.remove?.();
    this.listeners = [];
    this.deviceId = null;
  }
}
