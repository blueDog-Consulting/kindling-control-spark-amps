#!/usr/bin/env node
// Generates every platform's app icons and splash screens from the logo SVGs.
//
//   npm run icons                 # uses the current concept (CONCEPT below)
//   npm run icons -- kindling     # or pick another one from assets/logo/concepts/
//
// Inputs: assets/logo/concepts/<concept>/icon.svg        full-bleed 1024 tile (artwork in the centre ~76%)
//         assets/logo/concepts/<concept>/foreground.svg  transparent, scaled for Android's adaptive safe zone
// The outputs are committed; re-run this after changing the logo.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

export const CONCEPT = 'knob';
const BG = '#0d0e10'; // splash / adaptive background, matches the app's --bg
const ADAPTIVE_BG = '#15161a';

const root = fileURLToPath(new URL('..', import.meta.url));
const concept = process.argv[2] || CONCEPT;
const iconSvg = readFileSync(join(root, `assets/logo/concepts/${concept}/icon.svg`), 'utf8');
const fgSvg = readFileSync(join(root, `assets/logo/concepts/${concept}/foreground.svg`), 'utf8');

const written = [];
function out(rel, data) {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
  written.push(rel);
}

function render(svg, width, height = width) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render();
}
const png = (svg, w) => render(svg, w).asPng();
const dataUri = (svg, w) => `data:image/png;base64,${png(svg, w).toString('base64')}`;

/** Wrap a rendered image in an SVG canvas (for masks, padding, splash screens). */
function canvas(w, h, body, bg = null) {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`;
}
function image(svg, x, y, size, clip = '') {
  return `<image x="${x}" y="${y}" width="${size}" height="${size}" xlink:href="${dataUri(svg, size)}" ${clip}/>`;
}

/** Rounded-square icon (web "any", Android legacy). r = corner radius as a fraction of size. */
function rounded(size, r = 0.22) {
  return canvas(size, size, `<defs><clipPath id="c"><rect width="${size}" height="${size}" rx="${size * r}"/></clipPath></defs>${image(iconSvg, 0, 0, size, 'clip-path="url(#c)"')}`);
}
function circle(size) {
  return canvas(size, size, `<defs><clipPath id="c"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}"/></clipPath></defs>${image(iconSvg, 0, 0, size, 'clip-path="url(#c)"')}`);
}
/** macOS icon template: 824px rounded square centred on a 1024 canvas, with a soft shadow. */
function macIcon() {
  const s = 824;
  const o = (1024 - s) / 2;
  return canvas(
    1024,
    1024,
    `<defs><clipPath id="c"><rect x="${o}" y="${o}" width="${s}" height="${s}" rx="185"/></clipPath>
      <filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="14" flood-opacity="0.35"/></filter></defs>
     <rect x="${o}" y="${o}" width="${s}" height="${s}" rx="185" fill="#000" filter="url(#sh)"/>
     ${image(iconSvg, o, o, s, 'clip-path="url(#c)"')}`,
  );
}
/** Splash: app background with the rounded icon centred. */
function splash(w, h) {
  const size = Math.round(Math.min(w, h) * 0.3);
  const x = Math.round((w - size) / 2);
  const y = Math.round((h - size) / 2);
  return canvas(w, h, `<defs><clipPath id="c"><rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${size * 0.22}"/></clipPath></defs>${image(iconSvg, x, y, size, 'clip-path="url(#c)"')}`, BG);
}

/** Encode an opaque RGB PNG (iOS rejects app icons with an alpha channel). */
function pngRgb(rendered) {
  const { width, height } = rendered;
  const rgba = rendered.pixels;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (width * 3 + 1) + 1 + x * 3;
      const a = rgba[s + 3] / 255; // composite onto black (icons are opaque anyway)
      raw[d] = Math.round(rgba[s] * a);
      raw[d + 1] = Math.round(rgba[s + 1] * a);
      raw[d + 2] = Math.round(rgba[s + 2] * a);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---- web (PWA, favicon, Apple touch icon) ------------------------------------------
out('src/icon.svg', iconSvg.replace('<rect width="1024" height="1024" fill="url(#bg)"/>', '<rect width="1024" height="1024" rx="225" fill="url(#bg)"/>'));
out('src/icons/icon-192.png', png(rounded(192), 192));
out('src/icons/icon-512.png', png(rounded(512), 512));
out('src/icons/icon-maskable-512.png', png(iconSvg, 512)); // full bleed; the OS applies its own mask
out('src/icons/apple-touch-icon.png', pngRgb(render(iconSvg, 180))); // iOS rounds it itself

// ---- desktop (electron-builder reads build/) -----------------------------------------
out('build/icon.png', png(rounded(1024, 0.18), 1024)); // Windows (.ico) + Linux
out('build/icon-mac.png', png(macIcon(), 1024)); // macOS (.icns)

// ---- Android ----------------------------------------------------------------------------
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const res = 'android/app/src/main/res';
for (const [d, k] of Object.entries(densities)) {
  out(`${res}/mipmap-${d}/ic_launcher.png`, png(rounded(48 * k, 0.2), 48 * k));
  out(`${res}/mipmap-${d}/ic_launcher_round.png`, png(circle(48 * k), 48 * k));
  out(`${res}/mipmap-${d}/ic_launcher_foreground.png`, png(fgSvg, 108 * k));
  out(`${res}/drawable-port-${d}/splash.png`, png(splash(320 * k, 480 * k), 320 * k));
  out(`${res}/drawable-land-${d}/splash.png`, png(splash(480 * k, 320 * k), 480 * k));
}
out(`${res}/drawable/splash.png`, png(splash(480, 320), 480));
out(
  `${res}/values/ic_launcher_background.xml`,
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${ADAPTIVE_BG}</color>\n</resources>\n`,
);

// ---- iOS ------------------------------------------------------------------------------------
out('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', pngRgb(render(iconSvg, 1024)));
const iosSplash = png(splash(2732, 2732), 2732);
for (const f of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) {
  out(`ios/App/App/Assets.xcassets/Splash.imageset/${f}`, iosSplash);
}

console.log(`build-icons: concept "${concept}", wrote ${written.length} files`);
