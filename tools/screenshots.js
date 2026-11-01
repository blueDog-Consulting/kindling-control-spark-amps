#!/usr/bin/env node
// Captures the landing-page screenshots (site/screenshots/*.jpg) from the real
// app running against the simulated Spark 2, so they stay in sync with the UI.
//
//   npm run screenshots
//
// Needs Playwright with Chromium. It isn't a project dependency (it's large);
// if it's missing: npm i --no-save playwright && npx playwright install chromium

import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('screenshots: Playwright not found. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(1);
}

const root = fileURLToPath(new URL('../src/', import.meta.url));
const outDir = fileURLToPath(new URL('../site/screenshots/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

const server = createServer(async (req, res) => {
  try {
    let file = normalize(join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!file.startsWith(root)) throw new Error('forbidden');
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/?mock=Spark%202`;

const browser = await chromium.launch();
const shots = [];
const shoot = async (target, name, opts = {}) => {
  await target.screenshot({ path: join(outDir, `${name}.jpg`), type: 'jpeg', quality: 84, ...opts });
  shots.push(name);
};
const open = async (viewport, scale = 1) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: scale, colorScheme: 'dark' });
  page.on('dialog', (d) => d.accept());
  await page.goto(base);
  await page.click('#connect');
  await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'connected');
  await page.waitForSelector('.pedal');
  await page.evaluate(() => document.fonts.ready);
  return page;
};
const settle = (page) => page.waitForTimeout(350);

try {
  await mkdir(outDir, { recursive: true });

  // 1. desktop rig (hero)
  const desk = await open({ width: 1440, height: 900 });
  await desk.evaluate(() => mockAmp.turnKnob(3, 0, 0.62)); // a knob moved on the amp shows up live
  await settle(desk);
  await shoot(desk, 'rig-desktop');

  // 2. pedalboard: two rows around the amp (un-stick the header so it can't overlap element shots)
  await desk.addStyleTag({ content: '.topbar { position: relative !important; }' });
  await desk.locator('.pedalboard').scrollIntoViewIfNeeded();
  await shoot(desk.locator('.pedalboard'), 'pedalboard');

  await desk.evaluate(() => window.scrollTo(0, 0));

  // 3. presets: create two, then the save dialog targeting bank 2
  for (const [name, from] of [['Glassy Clean', 'blank'], ['Crunch Lead', 'current']]) {
    await desk.click('#new-preset');
    await desk.fill('#new-name', name);
    await desk.check(`input[name="new-from"][value="${from}"]`);
    await desk.click('#new-dialog button[value="ok"]');
    await desk.waitForFunction((n) => document.querySelector('#preset-name').textContent.startsWith(n), name);
    await desk.click('#save-preset');
    await desk.fill('#save-desc', from === 'blank' ? 'Clean and bright' : 'Pushed amp, short delay');
    if (name === 'Crunch Lead') {
      await desk.selectOption('#save-slot', '5');
      await settle(desk);
      await shoot(desk, 'save-dialog');
    }
    await desk.click('#save-dialog button[value="ok"]');
    await desk.waitForFunction(() => !document.querySelector('#preset-name .unsaved'));
  }
  await desk.click('#tab-library');
  await settle(desk);
  await shoot(desk, 'presets', { clip: { x: 0, y: 0, width: 1440, height: 560 } });

  // 4. console
  await desk.click('#tab-console');
  await settle(desk);
  await shoot(desk, 'console', { clip: { x: 0, y: 0, width: 1440, height: 700 } });

  // 5. phone rig + tuner
  const phone = await open({ width: 390, height: 844 }, 2);
  await settle(phone);
  await shoot(phone, 'rig-phone');
  await phone.click('#tab-tuner');
  await phone.click('#tuner-on');
  await phone.waitForTimeout(900);
  await shoot(phone, 'tuner-phone');

  console.log(`screenshots: wrote ${shots.length} images to site/screenshots/: ${shots.join(', ')}`);
} finally {
  await browser.close();
  server.close();
}
