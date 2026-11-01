# Anonymous error reports

Released apps send a small, anonymous report when something goes wrong, so we can see which errors happen in which build. Reports go to a Cloudflare Worker (`telemetry/`) and land in **Workers Logs**. Nothing that identifies a person, a device or an amp is sent or stored.

## What a report contains

```json
{
  "v": 1,
  "app": "desktop",            // desktop | android | ios | web
  "os": "windows",             // desktop only: windows | macos | linux
  "version": "0.3.0",          // from the release tag (src/version.js)
  "kind": "caught",            // error (uncaught) | unhandledrejection | caught
  "where": "connect",          // which action failed, e.g. connect, save-preset, reorder
  "name": "NetworkError",
  "message": "GATT operation failed for unknown reason",
  "stack": "at WebBluetoothTransport.write (/spark/transport-ble.js:88:13)\n…"
}
```

The Worker adds a `fingerprint` (a short hash of name + message + first stack frame) so the same error groups together.

## What is never sent or kept

- No user, device, install or session ids. No cookies, no timestamps from the device.
- No amp serial number, amp or Bluetooth device names, Bluetooth ids, preset names or descriptions.
- `scrub()` in `src/app/telemetry.js` removes, from both message and stack: URLs (cut to their path), home-directory user names, e-mail addresses, anything in quotes, UUIDs, MAC addresses, base64/serial-like tokens, hex dumps and long numbers. Messages are capped at 300 characters and stacks at 15 frames / 1500 characters.
- The Worker never reads the client IP, headers, user agent or `request.cf` (location, ASN). It re-validates every field against an allow-list and scrubs the text again (`sanitizeReport()`), so a modified client can't push extra data into the logs.
- `telemetry/wrangler.jsonc` turns **off invocation logs and traces for this Worker**. Cloudflare's automatic traces record the user agent, country/city and ASN on each fetch span, and invocation logs record request metadata; with both off, the only thing stored is the Worker's own scrubbed log line. Leave them off even if observability/tracing is on for other Workers in the account.

## When reports are sent

- Only from released builds: the release workflow stamps the version into `src/version.js` (`tools/stamp-version.js`). The committed value is `dev`, and `dev` builds send nothing.
- Never with the simulated amp (`?mock`).
- At most 20 reports per app session, and each distinct error once.
- Users can switch them off in the **Help** panel ("Send anonymous error reports"); the choice is stored in `localStorage` under `kindling-control.error-reports`. The switch is hidden where reports can't be sent. The user guide explains it in the **Privacy** section (`#privacy`).
- What is reported: uncaught errors, unhandled promise rejections, Bluetooth client errors, and failures of connect, reading/selecting/loading/saving presets, New, changing effects, parameter/on-off sends and chain reorder. A user closing the Bluetooth chooser (`NotFoundError`, `AbortError`) isn't reported. File imports and capture decoding aren't reported (their messages are about the user's files).

Requests are `POST text/plain` with `mode: 'no-cors'`, `credentials: 'omit'` and no referrer, so there's no CORS preflight from the `kindling://` (desktop) and `capacitor://`/`https://localhost` (mobile) origins.

## Deploying the Worker

```sh
cd telemetry
npx wrangler@4.151.1 login     # once
npx wrangler@4.151.1 deploy
```

- It deploys as `kindling-errors` on the custom domain `errors.kindlingspark.app` (needs the `kindlingspark.app` zone in the same Cloudflare account). To use another host, change `routes` in `wrangler.jsonc` **and** `ENDPOINT` in `src/app/telemetry.js`.
- Forks: set `ENDPOINT` to your own Worker, or to `''` to send nothing (the Help switch then disappears).
- Check the bundle without deploying: `npx wrangler@4.151.1 deploy --dry-run --outdir /tmp/kindling-errors`.

## Reading the reports

Cloudflare dashboard → **Workers & Pages → kindling-errors → Observability** (or the account-wide Observability page). Each report is one log line with `event = client_error` and these fields indexed: `fingerprint`, `app`, `os`, `version`, `kind`, `where`, `name`, `message`, `stack`. Useful queries:

- errors by version: filter `event = client_error`, group by `version`
- one platform: `app = android`
- top problems: group by `fingerprint` (then by `message` to read them)
- a new release: `version = 0.3.0`, group by `where`

## Testing locally

`npm run serve` and open `http://localhost:8787/?errors=on`: `?errors=on` lets a `dev` build send, with `app: "web"` and `version: "dev"`, so you can see reports arrive (or point `ENDPOINT` at `npx wrangler@4.151.1 dev` while testing). `test/telemetry.test.js` covers the scrubbing, the allow-list, the reporter's limits and opt-out, and the Worker.

## App stores

Declare this as anonymous **diagnostics / crash data, not linked to the user and not used for tracking** (Apple's privacy label; Google Play's Data safety form: "Crash logs" / "Diagnostics", collected, not shared, optional to the user via the Help switch).
