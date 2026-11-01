# Anonymous error reports

If the user agrees, released apps send a small, anonymous report when something goes wrong, so we can see which errors happen in which build. Reports go to a Cloudflare Worker (`telemetry/`) and land in **Workers Logs**. When the same error comes from 2 or more installs, the Worker opens a GitHub issue, and an auto-fix agent (Workers AI) can propose a draft PR. Nothing that identifies a person, a device or an amp is sent or stored.

```
app ──POST /v1/report──▶ kindling-errors Worker ──▶ Workers Logs (every report)
                                │
                                └─▶ D1: count installs per error ──(≥ 2)──▶ GitHub issue [error-report]
                                                                                   │
                         .github/workflows/autofix.yml ◀──────── label ────────────┘
                         Workers AI model → patch → npm test → draft PR (or a comment with its analysis)
```

## Consent: opt-in

- **First run:** released apps ask **"Help improve KindlingControl?"** (`#consent-dialog`), showing what is and isn't sent. *Send error reports* stores `on`, *No thanks* stores `off` (localStorage key `kindling-control.error-reports`). Closing it without choosing asks again next launch.
- **Nothing is sent before the user answers.** Up to 5 errors from before the answer are held in memory and sent only if they say yes.
- **Later:** the gear button in the top bar opens **Settings** (`#settings-dialog`): the *Send anonymous error reports* switch with the same explanation, and **About** (version, which app, licence, links). The switch is hidden where reports can't be sent (dev builds, the simulated amp, forks with no endpoint).
- The user guide explains it in **Settings and About** (`#settings`) and **Privacy and error reports** (`#privacy`).

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
  "stack": "at WebBluetoothTransport.write (/spark/transport-ble.js:88:13)\n…",
  "first": true                // first time this install reports this error
}
```

The Worker adds a `fingerprint` (a short hash of name + message with numbers normalised + first stack frame) so the same error groups together.

### Counting installs without an install id

To open an issue only when an error affects **several installs**, the Worker needs to count installs, but we don't want any id. So each app remembers, **on the device only** (`kindling-control.error-reports.seen`, up to 200 fingerprints), which errors it has already reported, and sends `first: true` only the first time. The Worker's count of `first: true` reports for a fingerprint is the number of installs that hit it. Nothing links two reports to the same install. (Clearing the app's data makes it count as a new install; that only means a slightly early issue.)

## What is never sent or kept

- No user, device, install or session ids. No cookies, no timestamps from the device.
- No amp serial number, amp or Bluetooth device names, Bluetooth ids, preset names or descriptions.
- `scrub()` in `src/app/telemetry.js` removes, from both message and stack: URLs (cut to their path), home-directory user names, e-mail addresses, anything in quotes, UUIDs, MAC addresses, base64/serial-like tokens, hex dumps and long numbers. Messages are capped at 300 characters and stacks at 15 frames / 1500 characters.
- The Worker never reads the client IP, headers, user agent or `request.cf` (location, ASN). It re-validates every field against an allow-list and scrubs the text again (`sanitizeReport()`), so a modified client can't push extra data into the logs, D1 or issues.
- `telemetry/wrangler.jsonc` turns **off invocation logs and traces for this Worker**. Cloudflare's automatic traces record the user agent, country/city and ASN on each fetch span, and invocation logs record request metadata; with both off, the only things stored are the Worker's own scrubbed log line and the D1 row. Observability settings are per Worker, so this doesn't change your other Workers: keep a separate Worker for error reports rather than adding the route to one that has tracing on.
- D1 stores one row per distinct error: counts, first/last version, the apps it was seen on, the sanitised name/message/stack, and the issue number. Dates are the server's date, at day resolution.

## When reports are sent

- Only from released builds: the release workflow stamps the version into `src/version.js` (`tools/stamp-version.js`). The committed value is `dev`, and `dev` builds send nothing.
- Never with the simulated amp (`?mock`), and only after the user said yes.
- At most 20 reports per app session, and each distinct error once per session.
- What is reported: uncaught errors, unhandled promise rejections, Bluetooth client errors, and failures of connect, reading/selecting/loading/saving presets, New, changing effects, parameter/on-off sends and chain reorder. A user closing the Bluetooth chooser (`NotFoundError`, `AbortError`) isn't reported. File imports and capture decoding aren't reported (their messages are about the user's files).

Requests are `POST text/plain` with `mode: 'no-cors'`, `credentials: 'omit'` and no referrer, so there's no CORS preflight from the `kindling://` (desktop) and `capacitor://`/`https://localhost` (mobile) origins.

## Setting up the Worker

wrangler is a devDependency of this repo, kept at `"latest"` on purpose, so run `npm install` once and use `npx wrangler` from `telemetry/`. The lockfile holds the version actually installed; `npm install wrangler@latest` (and committing `package-lock.json`) moves it forward.

```sh
cd telemetry
npx wrangler login                                   # once
npx wrangler d1 create kindling-errors               # once: paste the id into wrangler.jsonc
npx wrangler d1 execute kindling-errors --remote --file schema.sql
npx wrangler secret put GITHUB_TOKEN                 # optional: lets it open issues
npx wrangler deploy
```

- It deploys as `kindling-errors` on the custom domain `errors.kindlingcontrol.app`. The route names its zone (`"zone_name": "kindlingcontrol.app"`), because wrangler can't always infer it and fails with *Can't infer zone from route* (code 10082). The zone must be in the same Cloudflare account you deploy to (`npx wrangler whoami` shows which account that is). Remove any existing DNS record for `errors.kindlingcontrol.app` first: a custom domain creates its own. To use another host, change `routes` in `wrangler.jsonc` **and** `ENDPOINT` in `src/app/telemetry.js`.
- `GITHUB_TOKEN`: a fine-grained personal access token (or GitHub App token) for **this repository only**, with **Issues: read and write**. Issues opened with a personal token trigger the auto-fix workflow; ones opened with Actions' own token wouldn't.
- Vars in `wrangler.jsonc`: `GITHUB_REPO`, `ISSUE_THRESHOLD` (installs before an issue opens, default 2), `MAX_ISSUES_PER_DAY` (default 5; the endpoint is public, so this stops a flood of forged reports from flooding the tracker).
- Without the D1 binding the Worker only logs; without the token it counts but opens no issues.
- Forks: set `ENDPOINT` to your own Worker, or to `''` to send nothing (the Settings switch and first-run question then disappear).
- Check the bundle without deploying: `npx wrangler deploy --dry-run --outdir /tmp/kindling-errors`.

## Issues

An issue is titled `[error] <name>: <message>`, labelled `error-report`, and contains a table (installs, reports, apps, versions, where, fingerprint) and a machine-readable block (`<!-- error-report -->` + JSON) that the auto-fix agent reads. **The repository is public, so issues are public**; they only contain the sanitised report. The Worker opens one issue per fingerprint, ever: after you close it, a regression of the same error is visible in the logs (and in D1's `last_version`) but doesn't reopen it. To get a fresh issue, set the row's `issue_state` and `issue_number` to NULL in D1.

## Auto-fix agent

`.github/workflows/autofix.yml` runs when an issue gets the `error-report` label, using `tools/autofix.js`:

1. **propose** (read-only): reads only the issue's report block; picks up to 4 source files (from the stack frames, the file that reports that `where`, and files containing the message text); asks a Workers AI model via the OpenAI-compatible endpoint for a JSON answer with an analysis and exact search/replace edits; applies them.
2. **test** (read-only, no secrets): checks the patch paths and runs `npm test` with the patch applied.
3. **publish**: if the tests pass, pushes `autofix/issue-<n>` and opens a **draft** PR (`Fixes #n`, with the model's analysis); otherwise comments on the issue with the analysis and why there's no PR. It never runs the patched code and never merges.

Setup (repository Settings → Secrets and variables → Actions):

| | Name | |
|---|---|---|
| variable | `AUTOFIX_ENABLED` | `true` to turn it on (off by default) |
| secret | `CLOUDFLARE_ACCOUNT_ID` | your account id |
| secret | `CLOUDFLARE_API_TOKEN` | a token with **Workers AI: Read** and **Workers AI: Edit** |
| variable | `AUTOFIX_MODEL` | optional, default `@cf/openai/gpt-oss-120b` |
| secret | `AUTOFIX_PR_TOKEN` | optional fine-grained token (Contents + Pull requests: write). PRs opened with Actions' own token don't trigger CI; with this they do. Without it, also enable *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*. |

**Model choice.** The default is `@cf/openai/gpt-oss-120b`: 128k context, about $0.35 / $0.75 per million input/output tokens, and usable within the 10,000 free neurons a day on Workers AI (a typical issue here is roughly 30k tokens in and a few thousand out, about $0.01–0.02, or a few issues a day within the free allowance). `@cf/zai-org/glm-5.3` is the strongest coding model on Workers AI (1M context) if the fixes aren't good enough, but it needs Workers Paid and costs about $1.40 / $4.40: roughly $0.10–0.15 per issue. `@cf/qwen/qwen2.5-coder-32b-instruct` (a code-specialised model, about $0.66 / $1.00, also within the free allowance) works too, but its context window is only 32,768 tokens for prompt and answer together, so the agent sends it less source (about 60,000 characters, usually `app.js` plus one smaller file) and caps its answer at 4,096 tokens (`MODEL_LIMITS` in `tools/autofix.js`). It's a 2024 model: fine for small, local fixes like a missing null check, weaker at bugs that span files. Prices as listed by Cloudflare in October 2026. Set the model with the `AUTOFIX_MODEL` variable; add an entry to `MODEL_LIMITS` for any other model with a context window under 128k.

**Safety.** Anyone can post a report, so treat every auto-fix PR as untrusted code:

- Only the sanitised report block reaches the model, as data, and its text is scrubbed and length-capped.
- The agent may only change `src/app/*.js` and `src/spark/*.js`, never `src/app/telemetry.js`, `src/version.js`, tests, tools, workflows or package files (`ALLOWED_PATH`, checked when applying and again before pushing).
- The model call and the tests run with read-only permissions; the job that can write never executes the patched code.
- PRs are drafts. Review them like any outside contribution, and test on a real amp: CI has none. Commits carry `Docs-Not-Needed`; add docs in review if the fix changes behaviour.
- To re-run for an issue, remove and re-add the `error-report` label (only people with triage access can).

## Reading the reports

Cloudflare dashboard → **Workers & Pages → kindling-errors → Observability** (or the account-wide Observability page). Each report is one log line with `event = client_error` and these fields indexed: `fingerprint`, `app`, `os`, `version`, `kind`, `where`, `name`, `message`, `stack`, `first`. Useful queries:

- errors by version: filter `event = client_error`, group by `version`
- one platform: `app = android`
- top problems: group by `fingerprint` (then by `message` to read them)
- installs affected: filter `first = true`, group by `fingerprint`
- a new release: `version = 0.3.0`, group by `where`

The Worker also logs `event = issue_created` and `event = track_failed`. For totals per error: `npx wrangler d1 execute kindling-errors --remote --command "SELECT fingerprint, installs, reports, last_version, issue_number, message FROM errors ORDER BY installs DESC LIMIT 20"`.

## Testing locally

`npm run serve` and open `http://localhost:8787/?errors=on`: `?errors=on` lets a `dev` build ask and send, with `app: "web"` and `version: "dev"`, so you can see reports arrive (or point `ENDPOINT` at `npx wrangler dev` while testing). Clear the site's localStorage to see the first-run question again. Tests: `test/telemetry.test.js` (scrubbing, allow-list, consent, the `first` flag, the Worker), `test/telemetry-issues.test.js` (D1 counting and issues, against `node:sqlite`; skipped on Node versions without it), `test/autofix.test.js` (the agent's parsing, file picking, edits and path checks).

## App stores

Declare this as anonymous **diagnostics / crash data, not linked to the user, not used for tracking, optional** (Apple's privacy label; Google Play's Data safety form: "Crash logs" / "Diagnostics", collected, not shared, optional via the first-run question and Settings).
