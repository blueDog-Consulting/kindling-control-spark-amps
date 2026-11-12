// Anonymous error reports. When something goes wrong in a released app, a small
// report goes to a Cloudflare Worker (telemetry/worker.js) so we can see which
// errors happen in which build. Nothing identifying is sent:
//
//   sent:     app (desktop/android/ios/web), os (desktop only: windows/macos/linux),
//             app version, error name, scrubbed message and stack, where it happened,
//             and whether this install is reporting that error for the first time
//   not sent: no user/device/session ids, no amp serial or device names, no preset
//             names, no URLs or file paths with user names, no timestamps, no cookies
//
// Reports are only sent from released builds (src/version.js stamped by the release
// workflow), never with the simulated amp, and only after the user opts in (first-run
// question; changeable in Settings).
// The Worker re-validates and re-scrubs everything with sanitizeReport() below, and
// is configured so Cloudflare doesn't record IPs, user agents or locations either.
//
// This module has no DOM access at import time, so the Worker and the tests use it too.
// See docs/TELEMETRY.md.

/** Where reports go. Forks: point this at your own Worker, or set it to '' to send nothing. */
export const ENDPOINT = 'https://errors.kindlingcontrol.app/v1/report';

/** Where Console logs go (Settings → Send Console log…). Same Worker as error reports. */
export const LOG_ENDPOINT = ENDPOINT ? ENDPOINT.replace(/\/report$/, '/log') : '';

/** localStorage key for the user's answer: 'on' or 'off' (missing = not asked yet, send nothing). */
export const PREF_KEY = 'kindling-control.error-reports';
/** localStorage key for the fingerprints this install has reported (device only, never sent as a list). */
export const SEEN_KEY = 'kindling-control.error-reports.seen';

export const APPS = ['desktop', 'android', 'ios', 'web'];
export const OSES = ['windows', 'macos', 'linux'];
export const KINDS = ['error', 'unhandledrejection', 'caught'];

const LIMITS = { message: 300, stack: 1500, where: 32, name: 40 };
const MAX_PER_SESSION = 20;
const MAX_PENDING = 5; // held until the user answers the first-run question
const MAX_KNOWN = 200;
/** Console logs: the newest lines are kept, up to these caps. */
export const LOG_LIMITS = { lines: 300, chars: 24000, line: 400, note: 500 };
const MAX_LOGS_PER_SESSION = 3;

/**
 * Remove anything that could identify a person or their gear from free text:
 * URLs are cut to their path, home directories, e-mail addresses, quoted strings
 * (preset and device names), UUIDs, MAC addresses, Bluetooth device ids, serial-like
 * tokens, long hex dumps and long numbers.
 */
export function scrub(text, max = LIMITS.message) {
  let s = String(text ?? '');
  s = s
    // scheme://host/path?query#hash -> /path (our stack frames are kindling://app/..., https://localhost/..., capacitor://localhost/...)
    .replace(/\b[a-z][\w+.-]*:\/\/[^\s/()'"`]*(\/[^\s?#()'"`]*)?(?:[?#][^\s()'"`]*)?/gi, (_m, path) => path || '/')
    .replace(/\bfile:\/*/gi, '')
    // home directories
    .replace(/(\/(?:Users|home)\/)[^/\s:)]+/g, '$1~')
    .replace(/([A-Za-z]:\\(?:Users|Documents and Settings)\\)[^\\\s:)]+/gi, '$1~')
    // e-mail addresses
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>')
    // quoted text: preset names, amp names, file names
    .replace(/"[^"\n]*"/g, '"…"')
    .replace(/(^|[^\w])'[^'\n]*'/g, "$1'…'") // not apostrophes: "doesn't … isn't"
    .replace(/“[^”\n]*”|‘[^’\n]*’/g, '"…"')
    .replace(/`[^`\n]*`/g, '`…`')
    // identifiers
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '<id>')
    .replace(/(?:\b0x)?\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/(?:[0-9a-f]{2}\s){8,}[0-9a-f]{2}\b/gi, '<hex>')
    // Web Bluetooth device ids (base64) and serial-numbers: long tokens with digits in them
    .replace(/[A-Za-z0-9+/_=-]{12,}/g, (t) => ((t.match(/\d/g)?.length ?? 0) >= 3 ? '<id>' : t))
    .replace(/\b\d{6,}\b/g, '<n>');
  s = s.replace(/[^\S\n]+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Runs of at least 4 hex bytes ("01 fe 00 00 …"): kept as they are in Console logs.
const HEX_RUN = /((?:\b[0-9a-f]{2}\b[ ]?){4,})/gi;

/**
 * Clean a Console log (the text of Settings → Send Console log…) before it is sent, and
 * again in the Worker. Raw protocol bytes are kept as they are, because they are what makes
 * a log useful (the maintainer agreed to that; they can contain preset names and the amp's
 * serial number). Everything else on a line goes through scrub(), and the decoded amp name
 * and serial number are removed. Only the newest LOG_LIMITS.lines lines / LOG_LIMITS.chars
 * characters are kept.
 */
export function scrubLog(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => scrubLogLine(line))
    .filter((line) => line.trim());
  const out = [];
  let chars = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < LOG_LIMITS.lines; i--) {
    chars += lines[i].length + 1;
    if (chars > LOG_LIMITS.chars) break;
    out.push(lines[i]);
  }
  return out.reverse().join('\n');
}

function scrubLogLine(line) {
  const indent = /^\s*/.exec(line)[0].slice(0, 4);
  const parts = line
    .trim()
    // decoded amp name and serial number: drop the value
    .replace(/(\b(?:ampName|serial)\b).*$/, '$1 …')
    .split(HEX_RUN);
  // scrub() trims; keep the spaces around each text part so "raw 01 fe …" stays readable
  const s = parts
    .map((part, i) => (i % 2 ? part : part.trim() ? `${/^\s*/.exec(part)[0] ? ' ' : ''}${scrubLogText(part)}${/\s$/.test(part) ? ' ' : ''}` : part))
    .join('')
    .trim();
  const capped = s.length > LOG_LIMITS.line * 2 ? `${s.slice(0, LOG_LIMITS.line * 2 - 1)}…` : s;
  return indent + capped;
}

// Logs say more than error messages, so shorter serial-like tokens go too: 8+ letters and
// digits with at least 4 digits and a letter (e.g. S999C123456).
function scrubLogText(text) {
  return scrub(text, LOG_LIMITS.line).replace(/\b(?=[A-Za-z0-9]*\d{4})(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{8,}\b/g, '<id>');
}

/** Which app this is, from the runtime. Pass `window` (or a stand-in in tests). */
export function detectApp(win = globalThis) {
  const cap = win.Capacitor;
  const platform = typeof cap?.getPlatform === 'function' ? cap.getPlatform() : null;
  if (platform === 'android' || platform === 'ios') return { app: platform };
  if (win.kindlingDesktop) {
    const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[win.kindlingDesktop.platform];
    return os ? { app: 'desktop', os } : { app: 'desktop' };
  }
  return { app: 'web' };
}

/** Build the report object for an error. Everything in it has been scrubbed. */
export function buildReport(err, { kind = 'caught', where = '', app = 'web', os, version = 'dev' } = {}) {
  const e = err instanceof Error ? err : null;
  const report = {
    v: 1,
    app,
    version,
    kind,
    name: scrub(e?.name || (err && typeof err === 'object' && err.name) || typeof err, LIMITS.name),
    message: scrub(e ? e.message : typeof err === 'string' ? err : safeString(err)),
  };
  if (os) report.os = os;
  if (where) report.where = where;
  const stack = e?.stack ? scrub(stripMessageFromStack(e), LIMITS.stack) : '';
  if (stack) report.stack = stack;
  return report;
}

/**
 * The Worker's check: keep only known fields with valid values, scrub the text
 * again (never trust the client), and return null for anything malformed.
 */
export function sanitizeReport(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { app, os, version, kind, name, message, stack, where, first } = input;
  if (!APPS.includes(app) || !KINDS.includes(kind)) return null;
  if (typeof version !== 'string' || !/^(?:dev|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?)$/.test(version)) return null;
  if (typeof message !== 'string' || typeof name !== 'string') return null;
  const out = {
    app,
    version,
    kind,
    name: /^[A-Za-z][\w$]{0,39}$/.test(name) ? name : 'Error',
    message: scrub(message, LIMITS.message),
  };
  if (app === 'desktop' && OSES.includes(os)) out.os = os;
  if (typeof where === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(where)) out.where = where;
  if (typeof stack === 'string' && stack) out.stack = scrub(stack, LIMITS.stack);
  out.first = first === true;
  return out;
}

/** Build a Console log report (Settings → Send Console log…). `issue` is an optional GitHub issue number. */
export function buildLog(text, { app = 'web', os, version = 'dev', note = '', issue } = {}) {
  const log = scrubLog(text);
  const report = { v: 1, app, version, kind: 'log', lines: log ? log.split('\n').length : 0, log };
  if (os) report.os = os;
  const n = scrub(note, LOG_LIMITS.note);
  if (n) report.note = n;
  if (Number.isInteger(issue) && issue > 0 && issue < 1e6) report.issue = issue;
  return report;
}

/** The Worker's check for a Console log: like sanitizeReport(), and scrubs the log again. */
export function sanitizeLog(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { app, os, version, kind, log, note, issue } = input;
  if (kind !== 'log' || !APPS.includes(app)) return null;
  if (typeof version !== 'string' || !/^(?:dev|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,32})?)$/.test(version)) return null;
  if (typeof log !== 'string' || log.length > LOG_LIMITS.chars * 2) return null;
  const clean = scrubLog(log);
  if (!clean) return null;
  const out = { app, version, kind: 'log', lines: clean.split('\n').length, log: clean };
  if (app === 'desktop' && OSES.includes(os)) out.os = os;
  if (typeof note === 'string' && note) {
    const n = scrub(note, LOG_LIMITS.note);
    if (n) out.note = n;
  }
  if (Number.isInteger(issue) && issue > 0 && issue < 1e6) out.issue = issue;
  return out;
}

/** Short stable id for grouping the same error (name + message + first stack frame). */
export async function fingerprint(report) {
  const frame = report.stack?.split('\n').find((l) => /\.js|:\d+/.test(l)) ?? '';
  const text = `${report.name}|${report.message.replace(/\d+/g, 'N')}|${frame.trim()}`;
  const hash = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The reporter used by the app. Reports are **opt-in**: nothing is sent until the user
 * says yes (first-run prompt or Settings). Errors that happen before they answer are
 * held in memory (a few) and sent if they say yes, dropped if they say no.
 *
 * Each report carries `first: true` the first time this install reports that error
 * (fingerprints are remembered on the device only). The Worker counts those to know
 * how many installs hit an error without any install id being sent.
 *
 * @param {{ endpoint?: string, version: string, app: string, os?: string, storage?: Storage|null,
 *           send?: (url: string, body: string) => void, force?: boolean }} opts
 *   `force` sends from 'dev' builds too (?errors=on, for testing the Worker).
 */
export function createReporter({ endpoint = ENDPOINT, logEndpoint, version, app, os, storage = null, send = defaultSend, force = false }) {
  const seenThisSession = new Set();
  const pending = [];
  let sent = 0;
  let logsSent = 0;
  if (logEndpoint === undefined) logEndpoint = endpoint ? endpoint.replace(/\/report$/, '/log') : '';
  const available = !!endpoint && (version !== 'dev' || force);

  const read = (key) => {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };
  const write = (key, value) => {
    try {
      storage?.setItem(key, value);
    } catch {}
  };

  /** Fingerprints this install has already reported (kept on the device only). */
  const known = () => {
    try {
      const list = JSON.parse(read(SEEN_KEY) ?? '[]');
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  async function deliver(report) {
    const fp = await fingerprint(report);
    const list = known();
    const first = !list.includes(fp);
    if (first) write(SEEN_KEY, JSON.stringify([...list, fp].slice(-MAX_KNOWN)));
    send(endpoint, JSON.stringify({ ...report, first }));
    return { ...report, first };
  }

  const reporter = {
    /** Could reports be sent from this build at all? (false in dev builds and forks without an endpoint) */
    available,
    /** The user's answer: 'on', 'off', or null if they haven't been asked yet. */
    get consent() {
      const v = read(PREF_KEY);
      return v === 'on' || v === 'off' ? v : null;
    },
    /** Should the first-run question be shown? */
    get needsConsent() {
      return available && reporter.consent === null;
    },
    get enabled() {
      return reporter.consent === 'on';
    },
    set enabled(on) {
      write(PREF_KEY, on ? 'on' : 'off');
      const queued = pending.splice(0);
      if (on) for (const r of queued) deliver(r).catch(() => {});
    },
    /**
     * Report an error. Never throws. Resolves to the report it sent (or queued until the
     * user answers the first-run question), or null.
     */
    async report(err, { where = '', kind = 'caught' } = {}) {
      try {
        if (!available || reporter.consent === 'off' || sent >= MAX_PER_SESSION || ignorable(err)) return null;
        const report = buildReport(err, { kind, where, app, os, version });
        const key = `${report.name}|${report.message}|${report.where ?? ''}`;
        if (seenThisSession.has(key)) return null; // once per session is enough
        seenThisSession.add(key);
        sent++;
        if (reporter.consent === null) {
          if (pending.length < MAX_PENDING) pending.push(report);
          return report;
        }
        return await deliver(report);
      } catch {
        return null;
      }
    },
    /** Can a Console log be sent from this build? (independent of the error-report switch) */
    get canSendLog() {
      return available && !!logEndpoint && logsSent < MAX_LOGS_PER_SESSION;
    },
    /**
     * Send a Console log. Only ever called when the user presses Send in the preview, so it
     * doesn't depend on the error-report switch. Resolves to the report sent, or null.
     */
    async sendLog(text, { note = '', issue } = {}) {
      try {
        if (!reporter.canSendLog) return null;
        const report = buildLog(text, { app, os, version, note, issue });
        if (!report.log) return null;
        logsSent++;
        send(logEndpoint, JSON.stringify(report));
        return report;
      } catch {
        return null;
      }
    },
    /** Catch uncaught errors and unhandled promise rejections on a window. */
    install(win) {
      win.addEventListener('error', (e) => reporter.report(e.error ?? e.message, { kind: 'error' }));
      win.addEventListener('unhandledrejection', (e) => reporter.report(e.reason, { kind: 'unhandledrejection' }));
      return reporter;
    },
  };
  return reporter;
}

// The user closing the Bluetooth chooser isn't an error worth reporting.
function ignorable(err) {
  return err?.name === 'NotFoundError' || err?.name === 'AbortError';
}

// text/plain + no-cors: a "simple" request, so no CORS preflight from kindling:// or capacitor:// origins.
// No credentials, no referrer.
function defaultSend(url, body) {
  globalThis
    .fetch(url, { method: 'POST', body, mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer', keepalive: true, headers: { 'Content-Type': 'text/plain' } })
    .catch(() => {});
}

function stripMessageFromStack(e) {
  // V8 stacks start with "Name: message"; the message is reported (scrubbed) separately.
  const lines = String(e.stack).split('\n');
  if (lines[0].startsWith(`${e.name}`)) lines.shift();
  return lines.map((l) => l.trim()).filter(Boolean).slice(0, 15).join('\n');
}

function safeString(v) {
  try {
    return typeof v === 'object' ? JSON.stringify(v)?.slice(0, 200) ?? String(v) : String(v);
  } catch {
    return 'unserialisable value';
  }
}
