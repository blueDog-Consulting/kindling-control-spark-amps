// Protocol constants for Positive Grid Spark amps (Spark 40 / MINI / GO / 2 / NEO).
// See docs/PROTOCOL.md for the full description.

// BLE GATT layout (same on every Spark model seen so far).
export const BLE_SERVICE = 0xffc0;
export const BLE_WRITE_CHAR = 0xffc1; // app -> amp (write / write without response)
export const BLE_NOTIFY_CHAR = 0xffc2; // amp -> app (notify)

// Block header: 01 FE 00 00 <dir hi> <dir lo> <block len> 00 + 8 x 00  (16 bytes)
export const BLOCK_MAGIC = [0x01, 0xfe, 0x00, 0x00];
export const BLOCK_HEADER_LEN = 16;
export const DIR_TO_AMP = [0x53, 0xfe];
export const DIR_FROM_AMP = [0x41, 0xff];

// Chunk framing: F0 01 <seq> <xor checksum> <cmd> <sub> <7-bit data...> F7
export const CHUNK_START = [0xf0, 0x01];
export const CHUNK_END = 0xf7;

// Size limits. "chunk" sizes count 8-bit payload bytes (before 7-bit packing,
// excluding the 3-byte multi-chunk sub-header); "block" sizes include the header.
export const LIMITS = {
  toAmp: { chunk: 0x80, block: 0xad },
  fromAmp: { chunk: 0x19, block: 0x6a },
};

export const CMD = {
  WRITE: 0x01, // app -> amp: change something
  REQUEST: 0x02, // app -> amp: ask for something
  RESPONSE: 0x03, // amp -> app: answer / unsolicited event
  ACK: 0x04, // amp -> app: final acknowledgement
  ACK_PARTIAL: 0x05, // amp -> app: intermediate ack (multi-chunk preset upload)
};

export const SUB = {
  PRESET: 0x01,
  PARAM: 0x04, // 01 04: set param (app->amp)
  CHANGE_EFFECT: 0x06,
  PRESET_NUMBER: 0x10,
  AMP_NAME: 0x11,
  EFFECT_ONOFF: 0x15,
  SERIAL: 0x23,
  STORE_PRESET: 0x27, // 03 27: amp stored current state to a hardware slot
  AMP_INFO: 0x28, // 01 28 enable expression/volume info; 03 28 value
  CHECKSUMS: 0x2a,
  CHECKSUMS_EXT: 0x2b,
  FIRMWARE: 0x2f,
  PARAM_CHANGED: 0x37, // 03 37: knob moved on the amp
  CHANGE_PRESET: 0x38,
  TAP_TEMPO: 0x63,
  TUNER_OUTPUT: 0x64,
  TUNER_ONOFF: 0x65,
  INPUT_VOLUME: 0x6b,
  LICENSE: 0x70,
  AMP_STATUS: 0x71, // battery / power info (MINI, GO, 2, NEO)
  LOOPER_COMMAND: 0x75,
  LOOPER_SETTINGS: 0x76,
  LOOPER_MEASURE: 0x77,
  LOOPER_STATUS: 0x78,
};

// Hardware preset slots: 0-3 (0-7 on Spark 2, whose second bank is 4-7).
// 0x7f is the "temporary" slot the app uses for presets not stored on the amp.
export const PRESETS_PER_BANK = 4;
export const TEMP_SLOT = 0x7f;

// Per-model transport quirks (values from Ignitron's field testing):
//   maxBleWrite   largest single BLE write; longer blocks are split
//   blockDelayMs  pause after each block (MINI / 2 drop data without it)
export const AMP_MODELS = {
  'Spark 40': { maxBleWrite: 0xad, blockDelayMs: 0, presetSlots: 4 },
  'Spark GO': { maxBleWrite: 0xad, blockDelayMs: 0, presetSlots: 4 },
  'Spark NEO': { maxBleWrite: 0xad, blockDelayMs: 0, presetSlots: 4 },
  'Spark MINI': { maxBleWrite: 0x64, blockDelayMs: 80, presetSlots: 4 },
  'Spark 2': { maxBleWrite: 0x64, blockDelayMs: 80, presetSlots: 8 }, // two banks of 4: slots 0-3, 4-7
};
export const DEFAULT_MODEL = AMP_MODELS['Spark 40'];
// Used until the amp has told us its name, and for names we don't recognise:
// the conservative settings work on every model.
export const UNKNOWN_MODEL = { maxBleWrite: 0x64, blockDelayMs: 80, presetSlots: 4 };

/** Look up per-model settings by the name the amp reports (case-insensitive). */
export function modelSettings(name = '') {
  const key = Object.keys(AMP_MODELS).find((k) => k.toLowerCase() === String(name).trim().toLowerCase());
  return key ? AMP_MODELS[key] : UNKNOWN_MODEL;
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
