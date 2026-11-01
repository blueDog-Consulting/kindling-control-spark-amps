// Reusable rig controls: rotary knob, footswitch, toggle and selector.
//
// The knob is a native <input type="range"> (kept focusable but invisible, so
// keyboard, screen readers and form semantics come from the platform) with an
// SVG dial drawn on top. Pointer drags on the dial set the input's value.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SWEEP = 270; // degrees, from 7:30 to 4:30 like a real pot
const START = -135;

let uid = 0;

// let long labels like "Limit/Compress" wrap at the slash rather than mid-word
const wrapAtSlash = (text) => String(text).replace(/\//g, '/\u200b');

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Arc path on a circle of radius r centred at 50,50, angles in degrees (0 = 12 o'clock). */
function arc(r, from, to) {
  const pt = (a) => {
    const rad = ((a - 90) * Math.PI) / 180;
    return [50 + r * Math.cos(rad), 50 + r * Math.sin(rad)];
  };
  const [x1, y1] = pt(from);
  const [x2, y2] = pt(to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

/**
 * @param {object} o
 * @param {string} o.label     visible label
 * @param {number} o.value     0..1
 * @param {'pedal'|'chicken'} [o.variant]
 * @param {(v:number)=>void} o.onInput  called while the user turns it
 * @returns {{ el: HTMLElement, set: (v:number)=>void }}
 */
export function createKnob({ label, value = 0, variant = 'pedal', onInput }) {
  const id = `knob-${++uid}`;
  const wrap = document.createElement('div');
  wrap.className = `knob-ctl knob-${variant}`;

  const lab = Object.assign(document.createElement('label'), { htmlFor: id, className: 'knob-label', textContent: wrapAtSlash(label), title: label });

  const dial = document.createElement('div');
  dial.className = 'knob';
  const s = svg('svg', { viewBox: '0 0 100 100', 'aria-hidden': 'true' });
  s.append(
    svg('path', { d: arc(44, START, START + SWEEP), class: 'knob-track' }),
    svg('path', { d: arc(44, START, START + SWEEP), class: 'knob-fill', pathLength: '100' }),
  );
  // ticks around the dial
  for (let i = 0; i <= 10; i++) {
    const a = START + (SWEEP * i) / 10;
    const g = svg('line', { x1: 50, y1: 3, x2: 50, y2: i % 5 === 0 ? 9 : 7, class: 'knob-tick', transform: `rotate(${a} 50 50)` });
    s.append(g);
  }
  const body = svg('g', { class: 'knob-body' });
  if (variant === 'chicken') {
    // round skirt + chicken-head pointer
    body.append(
      svg('circle', { cx: 50, cy: 50, r: 30, class: 'knob-skirt' }),
      svg('path', { d: 'M50 16 L60 50 Q50 66 40 50 Z', class: 'knob-cap' }),
      svg('line', { x1: 50, y1: 20, x2: 50, y2: 40, class: 'knob-pointer' }),
    );
  } else {
    body.append(
      svg('circle', { cx: 50, cy: 50, r: 31, class: 'knob-skirt' }),
      svg('circle', { cx: 50, cy: 50, r: 24, class: 'knob-cap' }),
      svg('line', { x1: 50, y1: 22, x2: 50, y2: 36, class: 'knob-pointer' }),
    );
  }
  s.append(body);

  const input = Object.assign(document.createElement('input'), { type: 'range', id, min: '0', max: '1', step: '0.01', className: 'knob-input' });
  const out = Object.assign(document.createElement('output'), { htmlFor: id, className: 'knob-value' });
  dial.append(s, input);
  wrap.append(lab, dial, out);

  const fill = s.querySelector('.knob-fill');
  const render = (v) => {
    body.setAttribute('transform', `rotate(${START + SWEEP * v} 50 50)`);
    fill.setAttribute('stroke-dasharray', `${(v * 100).toFixed(2)} 100`);
    const text = (v * 10).toFixed(1);
    out.textContent = text;
    input.setAttribute('aria-valuetext', `${text} of 10`);
  };
  const set = (v) => {
    const c = Math.min(1, Math.max(0, Number(v) || 0));
    input.value = String(c);
    render(c);
  };
  set(value);

  input.addEventListener('input', () => {
    render(Number(input.value));
    onInput(Number(input.value));
  });

  // Pointer: drag up/right to turn clockwise. Fine control with Shift.
  let start = null;
  dial.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dial.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY, v: Number(input.value) };
    input.focus({ preventScroll: true });
    dial.classList.add('turning');
  });
  dial.addEventListener('pointermove', (e) => {
    if (!start || !dial.hasPointerCapture(e.pointerId)) return;
    const delta = (start.y - e.clientY + (e.clientX - start.x)) / (e.shiftKey ? 600 : 160);
    const v = Math.round(Math.min(1, Math.max(0, start.v + delta)) * 200) / 200;
    if (v !== Number(input.value)) {
      set(v);
      onInput(v);
    }
  });
  dial.addEventListener('lostpointercapture', () => {
    start = null;
    dial.classList.remove('turning');
  });
  // double-click / double-tap returns to the middle, like many plug-ins
  dial.addEventListener('dblclick', () => {
    set(0.5);
    onInput(0.5);
  });

  return { el: wrap, set };
}

/** Big stompbox footswitch. aria-pressed reflects on/off. */
export function createFootswitch({ label, on, onToggle }) {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'footswitch' });
  b.setAttribute('aria-label', label);
  const set = (v) => b.setAttribute('aria-pressed', String(!!v));
  set(on);
  b.addEventListener('click', () => {
    const v = b.getAttribute('aria-pressed') !== 'true';
    set(v);
    onToggle(v);
  });
  return { el: b, set };
}

/** Small two-position toggle for "(Switch)" parameters. */
export function createToggle({ label, value, onInput }) {
  const id = `tgl-${++uid}`;
  const wrap = document.createElement('div');
  wrap.className = 'toggle-ctl';
  const input = Object.assign(document.createElement('input'), { type: 'checkbox', id, className: 'switch', checked: value >= 0.5 });
  input.setAttribute('role', 'switch');
  const lab = Object.assign(document.createElement('label'), { htmlFor: id, className: 'knob-label', textContent: wrapAtSlash(label), title: label });
  input.addEventListener('change', () => onInput(input.checked ? 1 : 0));
  wrap.append(lab, input);
  return { el: wrap, set: (v) => (input.checked = v >= 0.5) };
}

/** Selector for parameters with named positions (delay mode, reverb type). */
export function createSelector({ label, value, options, onInput }) {
  const id = `sel-${++uid}`;
  const wrap = document.createElement('div');
  wrap.className = 'selector-ctl';
  const lab = Object.assign(document.createElement('label'), { htmlFor: id, className: 'knob-label', textContent: label });
  const sel = Object.assign(document.createElement('select'), { id });
  options.forEach((o, k) => sel.append(new Option(o.label, String(k))));
  const set = (v) => (sel.value = String(nearest(options, v)));
  set(value);
  sel.addEventListener('change', () => onInput(options[Number(sel.value)].value));
  wrap.append(lab, sel);
  return { el: wrap, set };
}

export function nearest(options, v) {
  let best = 0;
  options.forEach((o, k) => {
    if (Math.abs(o.value - v) < Math.abs(options[best].value - v)) best = k;
  });
  return best;
}
