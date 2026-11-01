#!/usr/bin/env node
// Decode Spark traffic from an Android Bluetooth HCI snoop log.
//
//   node tools/btsnoop-decode.js btsnoop_hci.log            # human readable
//   node tools/btsnoop-decode.js btsnoop_hci.log --json     # one JSON object per line
//   node tools/btsnoop-decode.js btsnoop_hci.log --raw      # include chunk hex
//   node tools/btsnoop-decode.js btsnoop_hci.log --unknown  # only messages we can't interpret yet
//
// See docs/CAPTURE.md for how to get the log off your phone.

import { readFileSync } from 'node:fs';
import { decodeBtsnoop } from '../src/spark/btsnoop.js';
import { toHex } from '../src/spark/codec.js';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: btsnoop-decode <btsnoop_hci.log> [--json] [--raw] [--unknown]');
  process.exit(1);
}
const json = args.includes('--json');
const raw = args.includes('--raw');
const unknownOnly = args.includes('--unknown');

const { fragments, messages } = decodeBtsnoop(readFileSync(file));
if (!fragments.length) {
  console.error('No Spark traffic found. Was the official app connected while logging? See docs/CAPTURE.md.');
  process.exit(2);
}

const SKIP = new Set(['cmd', 'sub', 'key', 'type', 'raw', 'timeMs', 't', 'direction', 'seq', 'checksumOk']);
for (const m of messages) {
  if (unknownOnly && !['unknown', 'unparsed'].includes(m.type)) continue;
  if (json) {
    const { raw: r, ...rest } = m;
    console.log(JSON.stringify({ ...rest, raw: r?.map((c) => toHex(c, '')) }));
    continue;
  }
  const arrow = m.direction === 'toAmp' ? 'app → amp' : 'amp → app';
  const fields = Object.entries(m)
    .filter(([k]) => !SKIP.has(k))
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ');
  const t = m.t.toFixed(3).padStart(9);
  console.log(`${t}s  ${arrow}  [${m.key}] seq=${m.seq.toString(16).padStart(2, '0')} ${m.type}${m.checksumOk ? '' : ' (BAD CHECKSUM)'}  ${fields}`);
  if (raw) for (const c of m.raw ?? []) console.log(`             ${toHex(c)}`);
}
console.error(`\n${messages.length} messages from ${fragments.length} fragments (${[...new Set(fragments.map((f) => f.transport))].join(', ')})`);
