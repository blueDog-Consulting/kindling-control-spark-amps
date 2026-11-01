// Public entry point for the Spark protocol library.
export * from './constants.js';
export * from './codec.js';
export * as messages from './messages.js';
export { decode, parsePreset, presetToJson, presetFromJson, randomUuid } from './messages.js';
export * from './effects.js';
export { SparkClient } from './client.js';
export { WebBluetoothTransport } from './transport-ble.js';
export { CapacitorBleTransport } from './transport-capacitor.js';
export { MockSparkTransport, demoPresets } from './transport-mock.js';
export { decodeBtsnoop, extractSparkFragments, parseBtsnoopRecords } from './btsnoop.js';
