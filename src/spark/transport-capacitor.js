// Native BLE transport for the Capacitor apps (Android, iPhone, iPad), using
// @capacitor-community/bluetooth-le. Capacitor's native bridge injects the
// plugin as window.Capacitor.Plugins.BluetoothLe, so no bundler is needed;
// the raw plugin API exchanges values as hex strings and wants 128-bit UUIDs.

import { BLE_SERVICE, BLE_WRITE_CHAR, BLE_NOTIFY_CHAR, DEFAULT_MODEL } from './constants.js';
import { toHex, fromHex } from './codec.js';

const uuid128 = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
const SERVICE = uuid128(BLE_SERVICE);
const WRITE = uuid128(BLE_WRITE_CHAR);
const NOTIFY = uuid128(BLE_NOTIFY_CHAR);

export class CapacitorBleTransport {
  constructor({ withResponse = true } = {}) {
    this.withResponse = withResponse;
    this.maxWrite = DEFAULT_MODEL.maxBleWrite;
    this.writeDelayMs = DEFAULT_MODEL.writeDelayMs;
    this.mtuPayload = Infinity;
    this.onData = () => {};
    this.onDisconnect = () => {};
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

    const device = await ble.requestDevice({ services: [SERVICE], optionalServices: [SERVICE] });
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
    this.writeDelayMs = model.writeDelayMs;
  }

  async write(block) {
    if (!this.deviceId) throw new Error('not connected');
    // Writes with response can be longer than the MTU (the OS does a long write), but
    // without response they must fit in one packet.
    const size = this.withResponse ? this.maxWrite : Math.min(this.maxWrite, this.mtuPayload);
    for (let i = 0; i < block.length; i += size) {
      const opts = { deviceId: this.deviceId, service: SERVICE, characteristic: WRITE, value: toHex(block.subarray(i, i + size), '') };
      if (this.withResponse) await this.ble.write(opts);
      else await this.ble.writeWithoutResponse(opts);
      if (this.writeDelayMs) await new Promise((r) => setTimeout(r, this.writeDelayMs));
    }
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
