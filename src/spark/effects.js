// Catalog of known Spark effect / amp models.
//
// The "id" is the technical name the amp uses on the wire; "name" is what the
// official app shows. Parameter order matters: index N in the list is
// parameter N in 01 04 / 03 37 messages and in presets. Values are floats in
// 0.0 .. 1.0 (the app shows them as 0 .. 10).
//
// Sources: Ignitron reference/EffectReference.csv (BSD-3-Clause, stangreg) and
// Paul Hamshere's "Spark Protocol Description" (Apache-2.0). Models not in the
// list (newer firmware, Spark 2 / NEO additions) still work — the UI falls
// back to generic "Param N" labels.

export const SLOTS = [
  { key: 'gate', label: 'Noise Gate' },
  { key: 'comp', label: 'Comp / Wah' },
  { key: 'drive', label: 'Drive' },
  { key: 'amp', label: 'Amp' },
  { key: 'mod', label: 'Modulation / EQ' },
  { key: 'delay', label: 'Delay' },
  { key: 'reverb', label: 'Reverb' },
];

export const DELAY_MODES = [
  { label: '50 ms', value: 0.3 },
  { label: '200 ms', value: 0.4 },
  { label: '500 ms', value: 0.6 },
  { label: '1 s', value: 0.72 },
];

export const MULTIHEAD_MODES = [
  { label: 'Heads 1+3', value: 0.0 },
  { label: 'Heads 1+2', value: 0.35 },
  { label: 'Heads 2+3', value: 0.65 },
  { label: 'Heads 1+2+3', value: 0.95 },
];

export const REVERB_TYPES = [
  'Room Studio A',
  'Room Studio B',
  'Chamber',
  'Hall Natural',
  'Hall Medium',
  'Hall Ambient',
  'Plate Short',
  'Plate Rich',
  'Plate Long',
].map((label, i) => ({ label, value: i / 10 }));

const sw = (name) => ({ name, kind: 'switch' });
const sel = (name, options) => ({ name, kind: 'select', options });
const fx = (slot, id, name, params) => ({
  slot,
  id,
  name,
  params: params.map((p) => (typeof p === 'string' ? { name: p, kind: 'knob' } : p)),
});

export const EFFECTS = [
  fx("gate", "bias.noisegate", "Noise Gate", ["Threshold", "Decay"]),
  fx("comp", "LA2AComp", "LA Comp", [sw("Limit/Compress"), "Gain", "Peak Reduction"]),
  fx("comp", "BlueComp", "Sustain Comp", ["Level", "Tone", "Attack", "Sustain"]),
  fx("comp", "Compressor", "Red Comp", ["Output", "Sensitivity"]),
  fx("comp", "BassComp", "Bass Comp", ["Comp", "Gain"]),
  fx("comp", "BBEOpticalComp", "Optical Comp", ["Volume", "Comp", sw("Pad")]),
  fx("drive", "Booster", "Booster", ["Gain"]),
  fx("drive", "KlonCentaurSilver", "Clone Drive", ["Output", "Treble", "Gain"]),
  fx("drive", "DistortionTS9", "Tube Drive", ["Overdrive", "Tone", "Level"]),
  fx("drive", "Overdrive", "Over Drive", ["Level", "Tone", "Drive"]),
  fx("drive", "Fuzz", "Fuzz Face", ["Volume", "Fuzz"]),
  fx("drive", "ProCoRat", "Black Op", ["Distortion", "Filter", "Volume"]),
  fx("drive", "BassBigMuff", "Bass Muff", ["Volume", "Tone", "Sustain"]),
  fx("drive", "GuitarMuff", "Guitar Muff", ["Volume", "Tone", "Sustain"]),
  fx("drive", "MaestroBassmaster", "Bassmaster", ["Brass Volume", "Sensitivity", "Bass Volume"]),
  fx("drive", "SABDriver", "SAB Driver", ["Volume", "Tone", "Drive", sw("LP/HP")]),
  fx("amp", "RolandJC120", "Silver 120", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Twin", "Black Duo", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "ADClean", "AD Clean", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "94MatchDCV2", "Match DC", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "ODS50CN", "ODS 50", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "BluesJrTweed", "Blues Boy", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Bassman", "Tweed Bass", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "AC Boost", "AC Boost", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Checkmate", "Checkmate", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "TwoStoneSP50", "Two Stone SP50", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Deluxe65", "American Deluxe", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Plexi", "Plexiglas", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "OverDrivenJM45", "JM45", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "OverDrivenLuxVerb", "Lux Verb", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Bogner", "RB 101", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "OrangeAD30", "British 30", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "AmericanHighGain", "American High Gain", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "SLO100", "SLO 100", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "YJM100", "YJM100", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Rectifier", "Treadplate", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "EVH", "Insane", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "6505Plus", "Insane 6508", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "SwitchAxeLead", "SwitchAxe", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Invader", "Rocker V", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "BE101", "BE 101", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Acoustic", "Pure Acoustic", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "AcousticAmpV2", "Fishboy", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "FatAcousticV2", "Jumbo", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "FlatAcoustic", "Flat Acoustic", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "GK800", "RB-800", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Sunny3000", "Sunny 3000", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "W600", "W600", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "Hammer500", "Hammer 500", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("mod", "Tremolo", "Tremolo", ["Speed", "Depth", "Level"]),
  fx("mod", "ChorusAnalog", "Chorus", ["E.Level", "Rate", "Depth", "Tone"]),
  fx("mod", "Flanger", "Flanger", ["Rate", "Mix", "Depth"]),
  fx("mod", "Phaser", "Phaser", ["Speed", "Intensity"]),
  fx("mod", "Vibrato01", "Vibrato", ["Speed", "Depth"]),
  fx("mod", "UniVibe", "UniVibe", ["Speed", sw("Vibrato/Chorus"), "Intensity"]),
  fx("mod", "Cloner", "Cloner Chorus", ["Rate", sw("Depth")]),
  fx("mod", "MiniVibe", "Classic Vibe", ["Speed", "Intensity"]),
  fx("mod", "Tremolator", "Tremolator", ["Depth", "Speed", sw("BPM On/Off")]),
  fx("mod", "TremoloSquare", "Tremolo Square", ["Speed", "Depth", "Level"]),
  fx("mod", "GuitarEQ6", "Guitar EQ", ["Level", "100", "200", "400", "800", "1.6k", "3.2k"]),
  fx("mod", "BassEQ6", "Bass EQ", ["Level", "50", "120", "400", "800", "4.5k", "10k"]),
  fx("delay", "DelayMono", "Digital Delay", ["E.Level", "Feedback", "Delay Time", sel("Mode", DELAY_MODES), sw("BPM")]),
  fx("delay", "DelayEchoFilt", "Echo Filt", ["Delay", "Feedback", "Level", "Tone", sw("BPM")]),
  fx("delay", "VintageDelay", "Vintage Delay", ["Repeat Rate", "Intensity", "Echo", sw("BPM")]),
  fx("delay", "DelayReverse", "Reverse Delay", ["Mix", "Decay", "Filter", "Time", sw("BPM")]),
  fx("delay", "DelayMultiHead", "Multi Head", ["Repeat Rate", "Intensity", "Echo Volume", sel("Heads", MULTIHEAD_MODES), sw("BPM")]),
  fx("delay", "DelayRe201", "Echo Tape", ["Sustain", "Volume", "Tone", "Short/Long"]),
  fx("reverb", "bias.reverb", "Reverb", ["Level", "Damping", "Dwell", "Time", "Low Cut", "High Cut", sel("Type", REVERB_TYPES)]),
  // Jimi Hendrix pack and other models known by name only
  fx("comp", "JH.Vox846", "JH Legendary Wah", []),
  fx("drive", "JH.AxisFuzz", "JH Axle Fuzz", []),
  fx("drive", "JH.SupaFuzz", "JH Super Fuzz", []),
  fx("drive", "JH.Octavia", "JH Octave Fuzz", []),
  fx("drive", "JH.FuzzTone", "JH Fuzz Tone", []),
  fx("amp", "JH.DualShowman", "JH D-Show Master", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "JH.Sunn100", "JH Sun 100S", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "JH.JTM45", "JH 45/100", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "JH.Bassman50Silver", "JH Bass Master", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "JH.SuperLead100", "JH Super 100", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("amp", "JH.SoundCity100", "JH Tone City 100", ["Gain", "Treble", "Middle", "Bass", "Volume"]),
  fx("mod", "JH.VoodooVibeJr", "JH Legendary Vibe", []),
];

const byId = new Map(EFFECTS.map((e) => [e.id.toLowerCase(), e]));

/** Look up an effect by wire id (case-insensitive). Returns undefined if unknown. */
export function findEffect(id) {
  return byId.get(String(id).toLowerCase());
}

export function effectsForSlot(slotKey) {
  return EFFECTS.filter((e) => e.slot === slotKey);
}

// Every Spark amp model uses this parameter order. Used for amp models that
// aren't in the catalog yet (e.g. newer Spark 2 / NEO amps).
export const AMP_PARAMS = ['Gain', 'Treble', 'Middle', 'Bass', 'Volume'];
// Order of the knobs on the amp's top panel, as parameter indexes.
export const AMP_KNOB_ORDER = [0, 3, 2, 1, 4]; // gain, bass, middle, treble, volume

/**
 * Parameter descriptor. Falls back to the standard amp knobs when slotKey is
 * 'amp', otherwise to a generic "Param N" label.
 */
export function paramInfo(effectId, index, slotKey) {
  const e = findEffect(effectId);
  if (e?.params[index]) return e.params[index];
  if ((e?.slot ?? slotKey) === 'amp' && AMP_PARAMS[index]) return { name: AMP_PARAMS[index], kind: 'knob' };
  return { name: `Param ${index + 1}`, kind: 'knob' };
}

/** A neutral starting point for a new preset: clean amp, gate + reverb on, the rest off. */
export function blankPreset(name = 'New preset') {
  const p = (id, isOn, params) => ({ name: id, isOn, params });
  return {
    name,
    version: '0.7',
    description: '',
    icon: 'icon.png',
    bpm: 120,
    pedals: [
      p('bias.noisegate', true, [0.2, 0.3, 0]),
      p('LA2AComp', false, [0, 0.5, 0.3]),
      p('Booster', false, [0.5]),
      p('Twin', true, [0.4, 0.5, 0.5, 0.5, 0.6]),
      p('ChorusAnalog', false, [0.4, 0.3, 0.5, 0.5]),
      p('DelayMono', false, [0.2, 0.3, 0.4, 0.6, 0]),
      p('bias.reverb', true, [0.3, 0.5, 0.5, 0.5, 0.2, 0.6, 0.3]),
    ],
  };
}

// Real-world gear each model is based on. Only well-established mappings are
// listed, following Positive Grid's own model descriptions. Names are trademarks
// of their owners and are used only to describe the sound; this project is not
// affiliated with them.
export const BASED_ON = {
  LA2AComp: 'Teletronix LA-2A',
  BlueComp: 'BOSS CS-3',
  Compressor: 'MXR Dyna Comp',
  BassComp: 'EBS MultiComp',
  BBEOpticalComp: 'BBE Opto Stomp',
  Booster: 'MXR Micro Amp',
  KlonCentaurSilver: 'Klon Centaur',
  DistortionTS9: 'Ibanez TS9 Tube Screamer',
  Fuzz: 'Dallas Arbiter Fuzz Face',
  ProCoRat: 'ProCo RAT',
  BassBigMuff: 'Electro-Harmonix Bass Big Muff',
  GuitarMuff: 'Electro-Harmonix Big Muff',
  MaestroBassmaster: 'Maestro Bass Brassmaster',
  RolandJC120: 'Roland JC-120',
  Twin: 'Fender Twin Reverb',
  '94MatchDCV2': 'Matchless DC-30',
  ODS50CN: 'Dumble ODS 50',
  BluesJrTweed: 'Fender Blues Junior',
  Bassman: 'Fender Bassman',
  'AC Boost': 'Vox AC30',
  Checkmate: 'Teisco Checkmate',
  TwoStoneSP50: 'Two-Rock Studio Pro 50',
  Deluxe65: 'Fender Deluxe Reverb',
  Plexi: 'Marshall Super Lead',
  OverDrivenJM45: 'Marshall JTM45',
  Bogner: 'Bogner Ecstasy 101',
  OrangeAD30: 'Orange AD30',
  Rectifier: 'Mesa/Boogie Triple Rectifier',
  SLO100: 'Soldano SLO-100',
  YJM100: 'Marshall YJM100',
  EVH: 'EVH 5150 III',
  '6505Plus': 'Peavey 6505+',
  SwitchAxeLead: 'Hughes & Kettner Switchblade',
  Invader: 'Orange Rockerverb',
  BE101: 'Friedman BE-100',
  AcousticAmpV2: 'Fishman Loudbox',
  Cloner: 'Electro-Harmonix Small Clone',
  UniVibe: 'Shin-ei Uni-Vibe',
  MiniVibe: 'Voodoo Lab Micro Vibe',
  Phaser: 'MXR Phase 90',
  Flanger: 'Electro-Harmonix Electric Mistress',
  DelayMono: 'BOSS DD-3',
  DelayRe201: 'Roland RE-201 Space Echo',
  'JH.Vox846': 'Vox V846 wah',
  'JH.Octavia': 'Octavia',
  'JH.SupaFuzz': 'Supa Fuzz',
  'JH.FuzzTone': 'Maestro Fuzz-Tone',
  'JH.DualShowman': 'Fender Dual Showman',
  'JH.Sunn100': 'Sunn 100S',
  'JH.JTM45': 'Marshall JTM45/100',
  'JH.SuperLead100': 'Marshall Super Lead 100',
  'JH.SoundCity100': 'Sound City 100',
  'JH.VoodooVibeJr': 'Uni-Vibe',
};

export function basedOn(effectId) {
  const e = findEffect(effectId);
  return BASED_ON[e?.id ?? effectId];
}

/** The order of the 7 blocks in every factory preset, which the firmware treats as fixed slots. */
export const SLOT_ORDER = SLOTS.map((s) => s.key);

/** Which slot a block belongs to: from the catalog, or its position for unknown models. */
export function slotOf(effectId, index) {
  return findEffect(effectId)?.slot ?? SLOTS[index]?.key ?? 'unknown';
}

/** Rearrange pedals into the canonical gate -> comp -> drive -> amp -> mod -> delay -> reverb order. */
export function canonicalOrder(pedals) {
  return pedals
    .map((fx, i) => ({ fx, rank: SLOT_ORDER.indexOf(slotOf(fx.name, i)), i }))
    .sort((a, b) => (a.rank < 0 ? a.i : a.rank) - (b.rank < 0 ? b.i : b.rank))
    .map((x) => x.fx);
}
