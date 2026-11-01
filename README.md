<p align="center"><img src="src/icons/icon-192.png" width="112" height="112" alt="KindlingControl logo: a guitar pick holding a flame over kindling"></p>

# KindlingControl

*The kindling that controls your Spark:* an open controller for Positive Grid Spark amps.

> **Want to try the Android app early?** Join the [private Android testing group on Google Play](https://play.google.com/apps/internaltest/4700407217953087836).

[![CI](https://github.com/bluedog-consulting/kindling-control-spark-amps/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/bluedog-consulting/kindling-control-spark-amps/actions/workflows/ci.yml)
[![Release build](https://github.com/bluedog-consulting/kindling-control-spark-amps/actions/workflows/release.yml/badge.svg)](https://github.com/bluedog-consulting/kindling-control-spark-amps/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/bluedog-consulting/kindling-control-spark-amps?include_prereleases&sort=semver)](https://github.com/bluedog-consulting/kindling-control-spark-amps/releases)
[![Downloads](https://img.shields.io/github/downloads/bluedog-consulting/kindling-control-spark-amps/total)](https://github.com/bluedog-consulting/kindling-control-spark-amps/releases)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
[![Open issues](https://img.shields.io/github/issues/bluedog-consulting/kindling-control-spark-amps)](https://github.com/bluedog-consulting/kindling-control-spark-amps/issues)
[![Last commit](https://img.shields.io/github/last-commit/bluedog-consulting/kindling-control-spark-amps/main)](https://github.com/bluedog-consulting/kindling-control-spark-amps/commits/main)
![Platforms: web, Windows, macOS, Linux, Android](https://img.shields.io/badge/platforms-web%20%7C%20Windows%20%7C%20macOS%20%7C%20Linux%20%7C%20Android-informational)

<a href="https://www.buymeacoffee.com/jerdog"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="60" width="217"></a>

An open replacement for the Positive Grid Spark app. It's a JavaScript implementation of the amp's Bluetooth protocol, with one UI that runs in the browser (over **Web Bluetooth**), as a desktop app, and as an Android or iPad app. There's no account, and it doesn't phone home.

Works with Spark 40, Spark GO, Spark MINI, Spark 2 and Spark NEO. All of them use the same BLE service (`0xFFC0`).

| Where | How |
|---|---|
| Android | the Android app (`android/`) |
| iPad / iPhone | the native app (`ios/`, planned). iOS browsers have no Web Bluetooth. |
| Windows / macOS / Linux | the desktop app (`desktop/`, Electron) |
| Chrome / Edge | for development only: `npm run serve` runs the same UI over Web Bluetooth. The web app isn't published. |

Download the apps from [Releases](https://github.com/bluedog-consulting/kindling-control-spark-amps/releases). The website, [kindlingspark.app](https://kindlingspark.app), has the landing page, the user guide and the **presets hub**, where players share presets. It has [its own repository](https://github.com/bluedog-consulting/kindling-control-website).

Build instructions for each are in [docs/APPS.md](docs/APPS.md).

## What it does

* **Tone:** a rig view in the style of desktop amp sims.
  * A signal-chain strip runs along the top: IN → gate → comp → drive → amp → mod → delay → reverb → OUT.
  * The amp appears as an amp head, with chicken-head knobs for gain, bass, middle, treble and volume.
  * Every other effect is a stompbox with rotary knobs, a status LED and a footswitch, laid out in signal order: the three pedals *into the amp* on the first row, the three *after the amp* on the second. A badge between the rows marks where the amp sits. Swap any model from its nameplate, which also shows the real gear it's based on.
  * Switch hardware presets on both banks of the Spark 2. Changing bank keeps your position, so preset 3 in bank 1 goes to preset 3 in bank 2.
  * Turning a knob on the amp updates the UI live.
  * **Reorder chain** (experimental) lets you drag effects into a new order and try it on the amp. The Spark firmware is believed to use a fixed order, so the app reads the result back and tells you whether your amp kept it.
* **Presets:** **New** creates a preset, either from the current sound or blank, and puts it on the amp to shape. **Save…** keeps it in *My presets* on this device, stores it in one of the amp's preset slots, or both. The Presets tab lists saved presets to load, export or delete, and imports JSON files. The format is compatible with [Ignitron](https://github.com/stangreg/Ignitron)'s preset files.
* **Tuner** on models that support it.
* **Console:** every message in both directions, decoded, with the raw hex. You can also send arbitrary commands. On the web and desktop, **Pop out** moves it into its own window, so you can watch the traffic while you use the Tone screen.
* **Capture decoder:** load an Android `btsnoop_hci.log` and see exactly what the official app sends. This is how you reverse engineer the features that aren't covered yet. See [docs/CAPTURE.md](docs/CAPTURE.md).

## Use it

**New here? Read the [user guide](src/guide/index.html).** It's built into the app (the **Help** button, plus **?** links next to each feature), and on the website at [kindlingspark.app/guide/](https://kindlingspark.app/guide/).

To run the app from source in a browser, use **Chrome or Edge** (Web Bluetooth) on Android, Windows, macOS, Linux or ChromeOS. iOS browsers don't support it. The page has to be served over HTTPS or `localhost`.

```sh
npm run serve          # http://localhost:8787  (no dependencies)
                       # http://localhost:8787/?mock            simulated Spark 40
                       # http://localhost:8787/?mock=Spark%20GO  simulated GO (battery, tuner)
                       # http://localhost:8787/?mock=Spark%202   simulated Spark 2 (two banks, 8 presets)
                       # …&reorder=1                              simulated amp that accepts reordered chains
```

Close the official Spark app first; it may hold the BLE connection. Then tap **Connect** and pick your amp.

## Library

`src/spark/` has no dependencies and runs in the browser or in Node 20+:

```js
import { SparkClient, WebBluetoothTransport } from './src/spark/index.js';

const amp = new SparkClient(new WebBluetoothTransport());
await amp.connect();
const info = await amp.handshake();          // { name, serial, firmware, presetNumber, status }
const tone = await amp.getPreset('current'); // { name, pedals: [{ name, isOn, params }] }

await amp.selectPreset(2);                   // 0-3, or 0-7 on Spark 2 (4-7 = bank 2)
await amp.setParam('Twin', 0, 0.7);          // gain to 7
await amp.setEffectOnOff('ChorusAnalog', true);
await amp.changeEffect('Twin', 'Plexi');

await amp.loadPreset(tone);                  // play a preset via the temporary slot (nothing stored)
await amp.storePreset(tone, 1);              // overwrite hardware slot 1 and switch to it

amp.addEventListener('param', (e) => console.log('knob on amp', e.detail));
```

| file | |
|---|---|
| `codec.js` | msgpack-ish values, 7-bit packing, block/chunk framing, the streaming decoder |
| `messages.js` | builders for every known command, plus `decode()` for every known reply and event |
| `client.js` | request/response matching, acks, write queue, events |
| `transport-ble.js` | Web Bluetooth (browsers, Electron) |
| `transport-capacitor.js` | native BLE for the Android and iOS apps |
| `transport-mock.js` | a simulated amp that speaks the real wire protocol, for development and tests |
| `btsnoop.js` | Android HCI log parser (BLE ATT and Classic RFCOMM) |
| `effects.js` | effect and amp catalog with parameter names |

The protocol itself is documented in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Repository layout

| path | |
|---|---|
| `src/` | everything that ships: `index.html`, the UI in `app/`, the protocol library in `spark/`. No build step. |
| `desktop/` | Electron shell for Windows, macOS and Linux |
| `android/`, `ios/` | Capacitor projects for Android and iPad/iPhone |
| `tools/` | capture decoder CLI, dev server, docs check, release plan, icons, screenshots |
| `test/` | `node:test` suites and real-capture fixtures |
| `src/guide/` | the user guide, shown in the app's Help panel (the website also serves a copy at `/guide/`) |
| `docs/` | [PROTOCOL.md](docs/PROTOCOL.md), [APPS.md](docs/APPS.md), [CAPTURE.md](docs/CAPTURE.md), [RELEASING.md](docs/RELEASING.md) |
| `.github/workflows/` | CI (tests + docs check) and the tag-driven app releases |

## Development

```sh
npm test                                        # node:test, no install needed
node tools/btsnoop-decode.js btsnoop_hci.log    # decode a capture
npm install && npm run desktop:mock             # desktop app against the simulated amp
npm run check:docs                              # docs rule (also runs in CI)
```

The tests include a real Spark 40 preset dump. The decoder has to reproduce its checksums, and re-encoding has to give back the original bytes exactly.

## Releases

Push a version tag (`git tag v0.2.0 && git push origin v0.2.0`). GitHub Actions then rebuilds whichever of the web app, the Android app and the desktop apps changed since the last release, and publishes them on the [Releases](https://github.com/bluedog-consulting/kindling-control-spark-amps/releases) page. See [docs/RELEASING.md](docs/RELEASING.md) for details and the optional signing and deploy secrets.

## Contributing

Read [AGENTS.md](AGENTS.md) first. It describes how the system fits together, and it applies to people as well as AI agents. One rule is enforced in CI: **any change to how the system works must update the docs and `AGENTS.md` in the same change.** CI also runs the tests on every pull request and on every push to `main`.

Contributions are accepted under the project's licence, GPL-3.0-or-later.

## Credits

Model "based on" information follows Positive Grid's own model descriptions. Gear names are trademarks of their owners.

The protocol knowledge comes from Paul Hamshere's [Spark](https://github.com/paulhamsh/Spark) and [Spark-Parser](https://github.com/paulhamsh/Spark-Parser) (Apache-2.0), and from stangreg's [Ignitron](https://github.com/stangreg/Ignitron) (BSD-3-Clause). See [NOTICE](NOTICE).

## License

Copyright © 2026 blueDog Consulting and Jeremy Meiss. KindlingControl is designed, built and maintained by blueDog Consulting, and free software under the [GNU General Public License v3.0 or later](LICENSE) (GPL-3.0-or-later). If you distribute a modified version, you must share its source under the same licence, so improvements come back to everyone. Third-party notices are in [NOTICE](NOTICE). The licence covers the code; the name, logo and official store listings are covered by [TRADEMARKS.md](TRADEMARKS.md), so if you publish a fork, give it your own name and icon.

This is an independent interoperability project. It is not affiliated with or endorsed by Positive Grid. "Spark" and "Positive Grid" are their trademarks.
