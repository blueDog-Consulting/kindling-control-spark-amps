#!/usr/bin/env node
// Turns the "App" answer of an issue form (.github/ISSUE_TEMPLATE/*.yml) into
// platform:* labels. Used by .github/workflows/issue-platforms.yml.
//
//   ISSUE_BODY="..." node tools/issue-platforms.js   # prints one label per line
//
// The issue body is untrusted: only exact matches of the options below count, so
// nothing in it can choose a label name.

import { pathToFileURL } from 'node:url';

/** Form option -> label. Keep the option text in step with the "App" dropdown in the forms. */
export const PLATFORMS = [
  { option: 'Desktop app (Windows/macOS/Linux)', label: 'platform:desktop', color: '5319e7', description: 'Electron desktop app' },
  { option: 'Android app', label: 'platform:android', color: '3ddc84', description: 'Capacitor Android app' },
  { option: 'iPhone or iPad app', label: 'platform:ios', color: '0e8a16', description: 'Capacitor iOS app (planned)' },
  { option: 'Browser (development build)', label: 'platform:web', color: '1d76db', description: 'Web Bluetooth in Chrome/Edge (dev only)' },
];

/** The heading of the form field the answer is read from. */
export const HEADING = 'App';

/**
 * @param {string} body issue body as rendered from an issue form
 * @returns {string[]} platform labels, in PLATFORMS order, no duplicates
 */
export function platformLabels(body) {
  if (typeof body !== 'string') return [];
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === `### ${HEADING}`);
  if (start < 0) return [];
  let end = lines.findIndex((l, i) => i > start && /^###\s/.test(l));
  if (end < 0) end = lines.length;
  const answers = new Set(
    lines
      .slice(start + 1, end)
      .flatMap((l) => l.split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return PLATFORMS.filter((p) => answers.has(p.option)).map((p) => p.label);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  for (const label of platformLabels(process.env.ISSUE_BODY ?? '')) console.log(label);
}
