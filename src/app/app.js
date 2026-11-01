import {
  SparkClient,
  WebBluetoothTransport,
  MockSparkTransport,
  SLOTS,
  EFFECTS,
  findEffect,
  effectsForSlot,
  paramInfo,
  decode,
  decodeBtsnoop,
  presetToJson,
  presetFromJson,
  toHex,
  fromHex,
  TEMP_SLOT,
} from '../spark/index.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const params = new URLSearchParams(location.search);
const useMock = params.has('mock');

const state = {
  client: null,
  connected: false,
  preset: null, // current live state
  slot: null,
  mock: null,
};

// ---------------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------------

function makeTransport() {
  if (useMock) {
    state.mock = new MockSparkTransport({ name: params.get('mock') || 'Spark 40', battery: params.get('mock') !== 'Spark 40' && !!params.get('mock') });
    window.mockAmp = state.mock; // play with it from devtools: mockAmp.turnKnob(3, 0, 0.9)
    return state.mock;
  }
  return new WebBluetoothTransport();
}

if (!useMock && !WebBluetoothTransport.isSupported()) $('#unsupported').hidden = false;

$('#connect').addEventListener('click', async () => {
  if (state.connected) {
    await state.client.disconnect();
    return;
  }
  setStatus('busy', 'Connecting…');
  const client = new SparkClient(makeTransport());
  state.client = client;
  wireClient(client);
  try {
    await client.connect();
    setStatus('busy', 'Handshake…');
    const info = await client.handshake();
    state.connected = true;
    showInfo(info);
    setStatus('connected', info.name);
    setConnectedUi(true);
    state.slot = info.presetNumber;
    highlightSlot();
    await refreshPreset();
  } catch (err) {
    console.error(err);
    setStatus('idle', err.name === 'NotFoundError' ? 'Not connected' : `Error: ${err.message}`);
    logLine('err', `connect failed: ${err.message}`);
    try {
      await client.disconnect();
    } catch {}
  }
});

function wireClient(c) {
  c.addEventListener('disconnected', () => {
    state.connected = false;
    setStatus('idle', 'Disconnected');
    setConnectedUi(false);
  });
  c.addEventListener('message', (e) => logMessage('rx', e.detail));
  c.addEventListener('sent', (e) => logMessage('tx', { ...decode(e.detail), seq: e.detail.seq, raw: e.detail.blocks }));
  c.addEventListener('sentRaw', (e) => logLine('tx', `raw ${toHex(e.detail.bytes)}`));
  c.addEventListener('error', (e) => logLine('err', e.detail.error.message));

  // amp-side events (knobs and buttons on the amp)
  c.addEventListener('param', (e) => {
    const { effect, index, value, solicited } = e.detail;
    if (solicited || !state.preset) return;
    const i = state.preset.pedals.findIndex((f) => f.name === effect);
    if (i < 0) return;
    state.preset.pedals[i].params[index] = value;
    updateParamUi(i, index, value);
    flash(i);
  });
  c.addEventListener('effectOnOff', (e) => {
    const { effect, on } = e.detail;
    const i = state.preset?.pedals.findIndex((f) => f.name === effect) ?? -1;
    if (i < 0) return;
    state.preset.pedals[i].isOn = on;
    $$('.fx')[i].querySelector('.onoff input').checked = on;
    flash(i);
  });
  c.addEventListener('effectChanged', () => refreshPreset());
  c.addEventListener('presetSelected', (e) => {
    if (e.detail.solicited) return;
    state.slot = e.detail.slot;
    highlightSlot();
    refreshPreset();
  });
  c.addEventListener('presetStored', (e) => logLine('rx', `amp stored current state to preset ${e.detail.slot + 1}`));
  c.addEventListener('tuner', (e) => showTuner(e.detail));
  c.addEventListener('tunerOnOff', (e) => ($('#tuner-on').checked = e.detail.on));
  c.addEventListener('ampStatus', (e) => showBattery(e.detail));
}

function setStatus(st, text) {
  const el = $('#status');
  el.dataset.state = st;
  el.textContent = text;
}

function setConnectedUi(on) {
  $('#connect').textContent = on ? 'Disconnect' : 'Connect';
  $('#connect').classList.toggle('primary', !on);
  for (const id of ['#refresh', '#export', '#raw-send', '#tuner-on']) $(id).disabled = !on;
  $('#info').hidden = !on;
}

function showInfo(info) {
  $('#i-name').textContent = info.name ?? '–';
  $('#i-fw').textContent = info.firmware ?? '–';
  $('#i-serial').textContent = info.serial ?? '–';
  showBattery(info.status);
}

function showBattery(s) {
  $('#i-batt-wrap').hidden = !s;
  if (!s) return;
  const raw = s.batteryRaw != null ? ` · raw ${s.batteryRaw}` : '';
  $('#i-batt').textContent = `${s.batteryPowered ? 'battery' : 'mains'}, ${s.charging}${raw}`;
}

// ---------------------------------------------------------------------------
// presets
// ---------------------------------------------------------------------------

async function refreshPreset() {
  if (!state.client) return;
  try {
    state.preset = await state.client.getPreset('current');
    renderPreset();
  } catch (err) {
    logLine('err', `could not read current preset: ${err.message}`);
  }
}

$('#refresh').addEventListener('click', refreshPreset);

for (const b of $$('.preset-buttons button')) {
  b.addEventListener('click', async () => {
    if (!state.connected) return;
    const slot = Number(b.dataset.slot);
    try {
      await state.client.selectPreset(slot);
      state.slot = slot;
      highlightSlot();
      await refreshPreset();
    } catch (err) {
      logLine('err', err.message);
    }
  });
}

function highlightSlot() {
  for (const b of $$('.preset-buttons button')) b.setAttribute('aria-pressed', String(Number(b.dataset.slot) === state.slot));
}

$('#export').addEventListener('click', () => {
  if (!state.preset) return;
  const json = JSON.stringify(presetToJson(state.preset), null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `${(state.preset.name || 'preset').replace(/[^\w.-]+/g, '_')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('#import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const preset = presetFromJson(JSON.parse(await file.text()));
    if (!state.connected) {
      state.preset = preset;
      renderPreset();
      return;
    }
    await state.client.loadPreset(preset, TEMP_SLOT);
    state.slot = TEMP_SLOT;
    highlightSlot();
    await refreshPreset();
  } catch (err) {
    logLine('err', `import failed: ${err.message}`);
    alert(`Import failed: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// signal chain UI
// ---------------------------------------------------------------------------

function renderPreset() {
  const p = state.preset;
  $('#preset-name').textContent = p?.name || 'Untitled';
  $('#preset-desc').textContent = p ? [p.description, p.bpm ? `${Math.round(p.bpm)} BPM` : ''].filter(Boolean).join(' · ') : '';
  const chain = $('#chain');
  chain.replaceChildren();
  if (!p) return;
  p.pedals.forEach((fx, i) => chain.append(renderFx(fx, i)));
}

function renderFx(fx, i) {
  const card = $('#fx-card').content.firstElementChild.cloneNode(true);
  const known = findEffect(fx.name);
  const slotKey = known?.slot ?? SLOTS[i]?.key;
  card.querySelector('.slot').textContent = SLOTS.find((s) => s.key === slotKey)?.label ?? `Slot ${i + 1}`;

  const onoff = card.querySelector('.onoff input');
  onoff.checked = fx.isOn;
  onoff.setAttribute('aria-label', `${known?.name ?? fx.name} enabled`);
  onoff.addEventListener('change', () => {
    fx.isOn = onoff.checked;
    state.client?.setEffectOnOff(fx.name, onoff.checked).catch((e) => logLine('err', e.message));
  });

  const sel = card.querySelector('.model');
  const options = effectsForSlot(slotKey);
  if (!known) options.unshift({ id: fx.name, name: `${fx.name} (unknown)` });
  for (const e of options) sel.append(new Option(e.name, e.id, false, e.id.toLowerCase() === fx.name.toLowerCase()));
  sel.addEventListener('change', async () => {
    const from = fx.name;
    const to = sel.value;
    try {
      await state.client.changeEffect(from, to);
      await refreshPreset();
    } catch (err) {
      logLine('err', err.message);
      sel.value = from;
    }
  });

  const box = card.querySelector('.params');
  const count = Math.max(fx.params.length, known?.params.length ?? 0);
  for (let p = 0; p < count; p++) box.append(renderParam(fx, i, p, fx.params[p] ?? 0));
  return card;
}

function renderParam(fx, fxIndex, p, value) {
  const info = paramInfo(fx.name, p);
  const row = document.createElement('div');
  row.className = `param kind-${info.kind}`;
  row.dataset.index = p;
  const id = `p-${fxIndex}-${p}`;
  const label = document.createElement('label');
  label.className = 'name';
  label.htmlFor = id;
  label.textContent = info.name;
  label.title = info.name;
  row.append(label);

  const send = throttle((v) => state.client?.setParam(fx.name, p, v).catch((e) => logLine('err', e.message)), 40);

  if (info.kind === 'switch') {
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', id, className: 'switch', checked: value >= 0.5 });
    input.setAttribute('role', 'switch');
    input.addEventListener('change', () => {
      fx.params[p] = input.checked ? 1 : 0;
      send(fx.params[p]);
    });
    row.append(input);
  } else if (info.kind === 'select') {
    const input = Object.assign(document.createElement('select'), { id });
    info.options.forEach((o, k) => input.append(new Option(o.label, String(k))));
    input.value = String(nearest(info.options, value));
    input.addEventListener('change', () => {
      fx.params[p] = info.options[Number(input.value)].value;
      send(fx.params[p]);
    });
    row.append(input);
  } else {
    const input = Object.assign(document.createElement('input'), { type: 'range', id, min: '0', max: '1', step: '0.005', value: String(value) });
    const out = document.createElement('output');
    out.htmlFor = id;
    const sync = () => {
      const v = Number(input.value);
      input.style.setProperty('--control-value', input.value);
      out.textContent = (v * 10).toFixed(1);
      input.setAttribute('aria-valuetext', `${(v * 10).toFixed(1)} of 10`);
    };
    sync();
    input.addEventListener('input', () => {
      fx.params[p] = Number(input.value);
      sync();
      send(fx.params[p]);
    });
    row.append(input, out);
  }
  return row;
}

function updateParamUi(fxIndex, p, value) {
  const row = $$('.fx')[fxIndex]?.querySelector(`.param[data-index="${p}"]`);
  if (!row) return;
  const input = row.querySelector('input, select');
  if (input.type === 'range') {
    input.value = String(value);
    input.style.setProperty('--control-value', input.value);
    row.querySelector('output').textContent = (value * 10).toFixed(1);
  } else if (input.type === 'checkbox') input.checked = value >= 0.5;
  else {
    const info = paramInfo(state.preset.pedals[fxIndex].name, p);
    input.value = String(nearest(info.options, value));
  }
}

function flash(i) {
  const card = $$('.fx')[i];
  if (!card) return;
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 400);
}

function nearest(options, v) {
  let best = 0;
  options.forEach((o, k) => {
    if (Math.abs(o.value - v) < Math.abs(options[best].value - v)) best = k;
  });
  return best;
}

/** Leading + trailing throttle: knob drags send at most one 01 04 per `ms`. */
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending;
  return (v) => {
    pending = v;
    const now = performance.now();
    if (now - last >= ms) {
      last = now;
      fn(v);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = performance.now();
        fn(pending);
      }, ms - (now - last));
    }
  };
}

// ---------------------------------------------------------------------------
// tuner
// ---------------------------------------------------------------------------

$('#tuner-on').addEventListener('change', (e) => {
  state.client?.setTuner(e.target.checked).catch((err) => logLine('err', err.message));
  if (!e.target.checked) showTuner(null);
});

function showTuner(t) {
  const needle = $('#tuner-needle');
  if (!t) {
    $('#tuner-note').textContent = '–';
    $('#tuner-cents').textContent = '';
    needle.style.insetInlineStart = '';
    return;
  }
  // offset is 0..1 with 0.5 = in tune (≈ ±50 cents range)
  const cents = Math.round((t.offset - 0.5) * 100);
  $('#tuner-note').textContent = t.noteName;
  $('#tuner-cents').textContent = `${cents > 0 ? '+' : ''}${cents} cents`;
  needle.style.insetInlineStart = `calc(${Math.min(1, Math.max(0, t.offset)) * 100}% - 0.175rem)`;
  needle.classList.toggle('in-tune', Math.abs(cents) <= 3);
}

// ---------------------------------------------------------------------------
// console
// ---------------------------------------------------------------------------

const NOISY = new Set(['param', 'tuner']);

function logMessage(dir, m) {
  if ($('#hide-params').checked && NOISY.has(m.type)) return;
  const li = document.createElement('li');
  li.className = `${dir}${m.type === 'unknown' || m.type === 'unparsed' ? ' unknown' : ''}`;
  li.append(formatMessage(dir, m));
  appendLog($('#log'), li);
}

function formatMessage(dir, m) {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const arrow = dir === 'tx' ? '→' : '←';
  const fields = { ...m };
  for (const k of ['cmd', 'sub', 'key', 'type', 'raw', 'seq', 'checksumOk', 'direction', 'timeMs', 't', 'solicited']) delete fields[k];
  const meta = document.createElement('span');
  meta.className = 'meta';
  meta.textContent = `${m.t != null ? `${m.t.toFixed(3)}s ` : ''}${arrow} [${m.key}] #${(m.seq ?? 0).toString(16)} `;
  summary.append(meta, `${m.type}${m.checksumOk === false ? ' (BAD CHECKSUM)' : ''} ${summarize(fields)}`);
  details.append(summary);
  const pre = document.createElement('code');
  pre.className = 'hex';
  pre.textContent = (m.raw ?? []).map((b) => toHex(b)).join('\n');
  details.append(pre);
  return details;
}

function summarize(fields) {
  if (fields.preset) {
    const p = fields.preset;
    return `"${p.name}" slot=${p.current ? 'current' : p.slot} ${p.pedals.map((f) => (f.isOn ? f.name : `(${f.name})`)).join(' → ')}`;
  }
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : v}`)
    .join(' ');
}

function logLine(cls, text) {
  const li = document.createElement('li');
  li.className = cls;
  li.textContent = text;
  appendLog($('#log'), li);
}

function appendLog(list, li) {
  list.prepend(li);
  while (list.children.length > 500) list.lastElementChild.remove();
}

$('#clear-log').addEventListener('click', () => $('#log').replaceChildren());

$('#raw-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.connected) return;
  const text = $('#raw-input').value.trim();
  try {
    const bytes = fromHex(text);
    if (bytes[0] === 0x01 && bytes[1] === 0xfe) await state.client.sendRaw(bytes);
    else if (bytes.length >= 2) await state.client.send({ cmd: bytes[0], sub: bytes[1], data: bytes.subarray(2) });
    else throw new Error('need at least cmd and sub bytes');
  } catch (err) {
    logLine('err', err.message);
  }
});

// ---------------------------------------------------------------------------
// capture decoder
// ---------------------------------------------------------------------------

let captureMessages = [];

$('#capture-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const { fragments, messages } = decodeBtsnoop(new Uint8Array(await file.arrayBuffer()));
    captureMessages = messages;
    const kinds = [...new Set(fragments.map((f) => f.transport))].join(', ') || 'none';
    const unknown = messages.filter((m) => m.type === 'unknown' || m.type === 'unparsed').length;
    $('#capture-summary').textContent = fragments.length
      ? `${messages.length} Spark messages (${unknown} not yet understood) from ${fragments.length} fragments over ${kinds}.`
      : 'No Spark traffic found in this capture. Was the official app connected while logging?';
    renderCapture();
  } catch (err) {
    $('#capture-summary').textContent = `Could not read capture: ${err.message}`;
  }
});
$('#capture-unknown').addEventListener('change', renderCapture);

function renderCapture() {
  const only = $('#capture-unknown').checked;
  const list = $('#capture-log');
  list.replaceChildren();
  for (const m of captureMessages) {
    if (only && m.type !== 'unknown' && m.type !== 'unparsed') continue;
    const li = document.createElement('li');
    const dir = m.direction === 'toAmp' ? 'tx' : 'rx';
    li.className = `${dir}${m.type === 'unknown' || m.type === 'unparsed' ? ' unknown' : ''}`;
    li.append(formatMessage(dir, m));
    list.append(li);
  }
}

// ---------------------------------------------------------------------------
// tabs (roving tabindex, arrow-key navigation)
// ---------------------------------------------------------------------------

const tabs = $$('[role="tab"]');
function selectTab(tab) {
  for (const t of tabs) {
    const on = t === tab;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
}
tabs.forEach((t, i) => {
  t.addEventListener('click', () => selectTab(t));
  t.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    const next = tabs[(i + d + tabs.length) % tabs.length];
    selectTab(next);
    next.focus();
  });
});

if (useMock) setStatus('idle', 'Simulated amp');
// expose for poking around in devtools
window.spark = { state, EFFECTS };
