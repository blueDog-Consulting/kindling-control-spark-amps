# AGENTS.md

Guidance for AI coding agents and human contributors working on this repository. `CLAUDE.md` imports this file.

## Documentation rule (required)

**Any material change to how the system works must, in the same change, update both:**

1. **The docs that describe it:** `README.md` and/or the relevant file in `docs/`.
2. **This file** (`AGENTS.md`), so the next agent has an accurate picture.

"Material" means anything that changes behaviour, interfaces or how to build and run things. Examples:

- the wire protocol or message handling
- a transport or the client API
- app features or UI flows
- the desktop or mobile shells
- permissions, build/deploy config, npm scripts, CI, or tools

Changes that aren't material and need no docs: pure styling, typo fixes, refactors with no behaviour change, test-only changes, and dependency bumps.

**Enforcement:** `tools/check-docs.js` (`npm run check:docs`) runs in CI on every PR and push to `main`. If any *material* path changes (see `MATERIAL` in that file), the change must also touch `AGENTS.md` **and** `README.md` or `docs/*.md`. To skip for a genuinely non-material change, add the commit trailer `Docs-Not-Needed: <reason>` or the PR label `docs-not-needed`. Don't use the opt-out to dodge real doc updates. If you add a new kind of material path, add it to `MATERIAL`.

## What this is

**KindlingControl** ("the kindling that controls your Spark"). App ID: `io.github.jerdog.kindlingcontrol`; slug: `kindling-control`. Describe it as "an open controller for Positive Grid Spark amps"; don't use "Spark" as part of the product name.

An open re-implementation of the Positive Grid Spark amp's Bluetooth protocol, with a control UI that runs everywhere from one codebase. Supported amps: Spark 40, MINI, GO, 2 and NEO.

It's an independent interoperability project. Never add Positive Grid's code, assets, logos or branding, and never present this as an official app.

| Platform | Shell | Bluetooth transport |
|---|---|---|
| Browser (Chrome/Edge) | none: static files in `src/`, deployed to Cloudflare | `src/spark/transport-ble.js` (Web Bluetooth) |
| Windows/macOS/Linux | Electron: `desktop/main.js`, `desktop/preload.cjs` | same Web Bluetooth transport, with an in-app device picker |
| Android | Capacitor: `android/` | `src/spark/transport-capacitor.js` (native plugin `@capacitor-community/bluetooth-le`) |
| iPad/iPhone | Capacitor: `ios/` (universal) | same Capacitor transport. iOS browsers have no Web Bluetooth. |

`src/app/app.js` picks the transport at runtime: the native plugin if present, then Web Bluetooth. `?mock` swaps in the simulated amp.

## Layout

```
src/                     everything that ships; served as-is, no bundler, no build step
  index.html             the app shell (tabs: Tone, Presets, Tuner, Console, Capture)
  app/app.js             app logic: connection, presets/banks, New/Save, library tab, console, capture, tabs
  app/rig.js             the rig view: chain strip (incl. reorder), amp head, pedalboard; param sync registry
  app/controls.js        reusable controls: rotary knob (native range + SVG dial), footswitch, toggle, selector
  app/library.js         "My presets" on-device library (localStorage, falls back to memory)
  app/styles.css         dark "stage" theme; colour tokens on :root, per-slot pedal colours
  spark/                 protocol library: no DOM, no dependencies, runs in Node 20+ too
    constants.js         UUIDs, command/sub-command ids, per-model settings (AMP_MODELS)
    codec.js             msgpack-ish writer/reader, 7-bit packing, block/chunk framing, StreamDecoder
    messages.js          builders for app->amp messages, decode() for everything, preset parse/serialise
    client.js            SparkClient: seq numbers, request/response + ack matching, write queue, events
    transport-*.js       ble (Web Bluetooth), capacitor (native), mock (simulated amp)
    btsnoop.js           Android HCI snoop log -> Spark messages (BLE ATT + RFCOMM)
    effects.js           effect/amp catalog, param labels, AMP_KNOB_ORDER, blankPreset(), BASED_ON, SLOT_ORDER
site/                    landing page (index.html, site.css, screenshots/); deployed at / with the app (src/) at /app/
desktop/                 Electron main + preload (serves src/ over the secure kindling:// scheme)
android/, ios/           Capacitor native projects (generated; web assets are synced in, not committed)
tools/                   btsnoop-decode CLI, zero-dep dev server, check-docs, release-plan, build-icons,
                         build-site (site-dist/ = site/ + src/ at /app/), screenshots (landing-page images via Playwright)
assets/logo/concepts/    logo source SVGs (kindling, knob, monogram, necks, amp, pick); `npm run icons` renders all platform icons
build/                   generated desktop icons for electron-builder (committed)
.github/workflows/       ci.yml (tests + docs rule), release.yml (tag -> build changed apps -> GitHub Release)
test/                    node:test suites; test/fixtures holds real captures
docs/                    PROTOCOL.md (wire format), APPS.md (building apps), CAPTURE.md (sniffing the official app), RELEASING.md
```

## Commands

```sh
npm test                         # all tests; needs no npm install
npm run serve                    # http://localhost:8787 (Web Bluetooth works on localhost)
                                 #   ?mock  ?mock=Spark%20GO  ?mock=Spark%202  -> simulated amps
                                 #   add &reorder=1 for a simulated amp that accepts reordered chains
npm run check:docs               # the documentation rule, against origin/main
npm install                      # only needed for the desktop/mobile shells
npm run desktop:mock             # Electron against the simulated Spark GO
npm run desktop:dist             # installer for the current OS (dist/, git-ignored)
npx cap sync                     # copy src/ into android/ and ios/ after web changes
npm run android | npm run ios    # sync + open Android Studio / Xcode
node tools/btsnoop-decode.js btsnoop_hci.log [--raw|--json|--unknown]
npm run site                     # build site-dist/: landing page at /, web app at /app/
npm run serve -- 8788 site-dist  # preview the whole website
npm run deploy                   # build-site + wrangler deploy (wrangler.jsonc serves site-dist/)
npm run screenshots              # re-capture site/screenshots/*.jpg from the app + simulated Spark 2 (needs Playwright)
npm run release:plan -- v0.3.0 v0.2.0   # which apps a tag would rebuild
```

## How it works (things that are easy to get wrong)

**Wire format** (full detail in `docs/PROTOCOL.md`):
- Blocks have a 16-byte `01 FE …` header, and chunks are framed `F0 01 seq xor cmd sub <7-bit data> F7`. Chunks can span blocks, and BLE notifications split blocks arbitrarily, so always feed bytes through `StreamDecoder`; never assume one notification is one message.
- Presets (`01 01` / `03 01`) are multi-chunk with a `[total, index, length]` sub-header. Amp→app chunks carry at most 0x19 data bytes; app→amp chunks at most 0x80.
- Floats are float32 and must round-trip **bit-exactly**: presets are checksummed. Don't round values in the codec; format them for display in the UI only.
- `seq` runs 1..0x7F. `01 04` (set parameter) gets **no ack**; other `01 xx` writes get `04 xx`, and `02 xx` requests get `03 xx`.
- Effect names in `01 04`/`01 06`/`01 15` are "prefixed strings" (length byte + fixstr).

**Transports:**
- Prefer **write-without-response**. Write-with-response fails on Spark 2 + macOS with "GATT operation failed for unknown reason". Both transports fall back to the other mode once and log it.
- Until the amp reports its name, use `UNKNOWN_MODEL` (≤ 0x64-byte writes, 80 ms pause per block). After the handshake, `modelSettings(name)` applies the per-model limits.
- The transport interface is `connect()`, `disconnect()`, `write(block)`, `configure(model)`, plus the callbacks `onData`, `onDisconnect`, `onLog`. New transports must implement it, and should be testable against `MockSparkTransport` (see `test/transport-ble.test.js` and `test/capacitor.test.js` for fakes of each platform API).

**Presets and banks:**
- Hardware slots are 0–3. The Spark 2 has 8 (two banks of four: slots 4–7 are bank 2), using the same `01 38` / `03 38` / `02 01` messages. `0x7F` is the temporary slot.
- Switching bank in the UI selects the same position in the new bank.
- **New** loads a preset into the temporary slot, so nothing stored changes. **Save…** may overwrite a hardware slot (`client.storePreset`) and must keep its overwrite warning. Never write to a hardware slot without explicit user action.

**Signal chain order:**
- Presets carry 7 blocks. The firmware is believed to treat them as fixed slots: gate → comp/wah → drive → amp → mod/EQ → delay → reverb (`SLOT_ORDER`). Community sources agree, but no official documentation exists.
- **Reorder chain** in the UI is **experimental**. You edit a draft (drag, or arrow keys), and **Apply** calls `client.tryChainOrder()`. That loads the new order into the temporary slot (nothing stored changes), reads it back, and reports whether the amp kept it or normalised it. "Kept" doesn't prove the DSP processes that order; that has to be confirmed by ear. Record real-amp results in `docs/PROTOCOL.md`.
- `MockSparkTransport` normalises uploads to canonical order by default (`fixedChain: true`); `fixedChain: false` (`?mock&reorder=1`) keeps them.

**UI (rig):**
- `rig.js` renders from `state.preset.pedals`: a chain strip (IN → blocks → OUT), the amp as an amp head (chicken-head knobs in `AMP_KNOB_ORDER`), and the other blocks as stompboxes on a pedalboard in two rows: "Into the amp" (the blocks before the amp) and "After the amp". An amp-link badge sits between them, showing the amp's chain position and jumping to the amp head. Each pedal shows its chain position number (1–7). Rows are 3 columns wide (1 below 720px), and pedals in a row stretch so their footswitches line up.
- Every parameter control registers a setter under `"fxIndex:param"`. The amp head, the pedals and knob moves reported by the amp (`rig.updateParam`) all sync through that registry; add new controls the same way instead of querying the DOM. Parameter sends are throttled per parameter (40 ms).
- The knob (`controls.js`) is a real `<input type="range">`, kept focusable but invisible, with an SVG dial on top. Keyboard and screen readers use the native slider. Pointer: drag up or right to turn, Shift for fine control, double-click to reset to 5.
- The theme is dark only (`color-scheme: dark`). Pedal colours come from `--pedal-<slot>` tokens. Check phone width (390px) for horizontal overflow after layout changes.
- `BASED_ON` in `effects.js` lists the real gear each model is modelled on. Only add well-established mappings. Never copy descriptive text from third-party guides.
- Amp models missing from the catalog get the standard labels `AMP_PARAMS` (Gain, Treble, Middle, Bass, Volume). Other unknown effects get "Param N".

**Desktop security:**
- Keep `contextIsolation: true`, `sandbox: true` and `nodeIntegration: false`.
- The preload only exposes the Bluetooth picker bridge (`window.kindlingDesktop`).
- External links open in the system browser.

## Website (landing page)

- `site/index.html` is the promotional landing page. It has no JS, uses the same palette as the app, and pulls its icons from `app/` (the built site). The deploy is `site-dist/`: `site/` at `/` and `src/` at `/app/`, from `tools/build-site.js`. The Electron and Capacitor shells still use `src/` directly.
- Screenshots come from `npm run screenshots` (real app + `MockSparkTransport` Spark 2). Re-run it after visible UI changes; don't hand-edit them.
- Keep the copy honest:
  - Say what has actually been tested (a Spark 2) versus what follows the documented protocol.
  - Mark plans as plans (e.g. the iPad app).
  - Don't disparage the official app.
  - Keep the credits section crediting Paul Hamshere's protocol work, Ignitron and the other sources in `NOTICE`.
- If you change the landing page, the app's URL or the deploy layout, update this section and the README.

## Branding and icons

- The logo is the "Pick Flame" concept (`pick`): a guitar pick holding a flame over crossed kindling. The other concepts are kept as alternatives. All app icons and splash screens are generated by `npm run icons` (`tools/build-icons.js`, using `@resvg/resvg-js`) from `assets/logo/concepts/<concept>/{icon,foreground}.svg`. Never hand-edit the generated PNGs; change the SVG and re-run. The current concept is the `CONCEPT` constant.
- The iOS app icon must be opaque (no alpha channel). `build-icons.js` writes it with its own RGB PNG encoder; keep it that way.
- Logo SVGs keep their artwork inside the central circle (radius ≈ 38% of the size), so Android and maskable-icon crops never cut it. Gradients on purely vertical or horizontal strokes need `gradientUnits="userSpaceOnUse"`: an `objectBoundingBox` gradient on a zero-width box doesn't paint.
- Saved presets live under the localStorage key `kindling-control.presets.v1`. `library.js` migrates the pre-rename key `spark-control.presets.v1` on first load.

## Releases

- Pushing a `v*` tag runs `.github/workflows/release.yml`. `tools/release-plan.js` diffs against the previous `v*` tag and builds only the apps whose paths changed (`APP_PATHS`: `src/` is shared by all of them). It then publishes one GitHub Release. Full details are in `docs/RELEASING.md`.
- If you add a file or folder that affects an app's build, add its path to `APP_PATHS`, and update `docs/RELEASING.md`.
- Versions come from the tag; don't hand-edit versions in `package.json` or `android/app/build.gradle`. The Android `versionCode` scheme is `versionFromTag()`, and it must stay strictly increasing (tested).
- Secrets are optional: without them, CI ships a debug APK, unsigned desktop builds and no Cloudflare deploy. In workflows, never interpolate `${{ }}` values derived from repo content (e.g. file names) into `run:` scripts; pass them through `env:`.
- iOS isn't built in CI yet (it needs macOS signing).

## Verifying changes

- `npm test` must pass. Add tests next to the area you change. Protocol changes should come with byte-level tests, ideally from a real capture in `test/fixtures/` (credit the source in `NOTICE`).
- For UI changes, run `npm run serve` and exercise the flow with `?mock=Spark%202` (8 presets, battery, tuner) and `?mock` (Spark 40: no banks, no battery). Use `&reorder=1` to see the "amp kept the order" path. Check phone width (~390px) for horizontal overflow. In devtools, `mockAmp.turnKnob(fxIndex, param, value)` and `mockAmp.pressPreset(slot)` simulate the amp's physical controls.
- Nothing here has a real amp in CI. Say clearly what was tested only against the simulator, and mark protocol behaviour that hasn't been seen on real hardware as **(unverified)** in `docs/PROTOCOL.md`.

## Conventions

- **Dependencies:**
  - `src/` has zero runtime dependencies and no build step. Keep it that way: ES modules, plain DOM, no frameworks.
  - All npm packages are devDependencies (Capacitor's CLI also scans devDependencies), pinned to **exact** versions that are at least two weeks old. The one exception is a security fix for something that ships, e.g. Electron.
  - `npm audit --omit=dev` must stay at 0. Moderate findings inside electron-builder or `@capacitor/cli` are build-only (see `docs/APPS.md`). Never run `npm audit fix --force`.
- **Formatting:** 2-space indent, single quotes, semicolons, trailing commas, lines up to about 120 characters.
- **Git:**
  - `main` is the primary branch.
  - Keep commits focused, and explain *why* in the message.
  - Don't commit `dist/`, `node_modules/`, or the synced copies of web assets inside `android/` and `ios/`; their `.gitignore` files already cover them.
- **Attribution:** protocol knowledge comes from paulhamsh/Spark, paulhamsh/Spark-Parser (Apache-2.0) and stangreg/Ignitron (BSD-3-Clause). Keep `NOTICE` up to date when you borrow data or fixtures.
