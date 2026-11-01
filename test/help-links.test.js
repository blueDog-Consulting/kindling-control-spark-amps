import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const guide = read('src/guide/index.html');
const ids = new Set([...guide.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test('every in-app help link points at a section of the user guide', () => {
  const sources = ['src/index.html', ...readdirSync(new URL('../src/app/', import.meta.url)).filter((f) => f.endsWith('.js')).map((f) => `src/app/${f}`)];
  const targets = new Set();
  for (const f of sources) {
    const s = read(f);
    for (const m of s.matchAll(/data-help="([^"]*)"/g)) targets.add(m[1]);
    for (const m of s.matchAll(/dataset\.help = '([^']*)'/g)) targets.add(m[1]);
    for (const m of s.matchAll(/openHelp\('([^']*)'\)/g)) targets.add(m[1]);
  }
  targets.delete(''); // "" opens the guide at the top
  assert.ok(targets.size >= 8, `found ${targets.size} help targets`);
  for (const t of targets) assert.ok(ids.has(t), `help target "#${t}" missing from src/guide/index.html`);
});

test("the guide's own table of contents has no broken anchors", () => {
  const anchors = [...guide.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(anchors.length > 10);
  for (const a of anchors) assert.ok(ids.has(a), `guide link "#${a}" has no target`);
});
