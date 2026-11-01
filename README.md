# Spark Control

An open replacement for the Positive Grid Spark app. It's a JavaScript implementation of the amp's Bluetooth protocol, with one UI that runs in the browser (over **Web Bluetooth**), as a desktop app, and as an Android or iPad app. There's no account, and it doesn't phone home.

Works with Spark 40, Spark GO, Spark MINI, Spark 2 and Spark NEO. All of them use the same BLE service (`0xFFC0`).

| Where | How |
|---|---|
| Android | the web app in Chrome, or the native app (`android/`) |
| iPad / iPhone | the native app (`ios/`). iOS browsers have no Web Bluetooth. |
| Windows / macOS / Linux | the desktop app (`desktop/`, Electron), or the web app in Chrome/Edge |

Build instructions for each are in [docs/APPS.md](docs/APPS.md).

## What it does

* **Tone:** a rig view in the style of desktop amp sims.
  * A signal-chain strip runs along the top: IN → gate → comp → drive → amp → mod → delay → reverb → OUT.
  * The amp appears as an amp head, with chicken-head knobs for gain, bass, middle, treble and volume.
  * Every other effect is a stompbox with rotary knobs, a status LED and a footswitch. Swap any model from its nameplate, which also shows the real gear it's based on.
  * Switch hardware presets on both banks of the Spark 2. Changing bank keeps your position, so preset 3 in bank 1 goes to preset 3 in bank 2.
  * Turning a knob on the amp updates the UI live.
  * **Reorder chain** (experimental) lets you drag effects into a new order and try it on the amp. The Spark firmware is believed to use a fixed order, so the app reads the result back and tells you whether your amp kept it.
* **Presets:** **New** creates a preset, either from the current sound or blank, and puts it on the amp to shape. **Save…** keeps it in *My presets* on this device, stores it in one of the amp's preset slots, or both. The Presets tab lists saved presets to load, export or delete, and imports JSON files. The format is compatible with [Ignitron](https://github.com/stangreg/Ignitron)'s preset files.
* **Tuner** on models that support it.
* **Console:** every message in both directions, decoded, with the raw hex. You can also send arbitrary commands.
* **Capture decoder:** load an Android `btsnoop_hci.log` and see exactly what the official app sends. This is how you reverse engineer the features that aren't covered yet. See [docs/CAPTURE.md](docs/CAPTURE.md).

## Use it

In a browser, Web Bluetooth needs **Chrome or Edge**: on Android, Windows, macOS, Linux or ChromeOS. iOS browsers don't support it, so iPad and iPhone need the native app. The page also has to be served over HTTPS (or `localhost`).

```sh
npm run serve          # http://localhost:8787  (no dependencies)
                       # http://localhost:8787/?mock            simulated Spark 40
                       # http://localhost:8787/?mock=Spark%20GO  simulated GO (battery, tuner)
                       # http://localhost:8787/?mock=Spark%202   simulated Spark 2 (two banks, 8 presets)
                       # …&reorder=1                              simulated amp that accepts reordered chains
```

Close the official Spark app first; it may hold the BLE connection. Then tap **Connect** and pick your amp.

### Deploy to Cloudflare

The whole app is static files in `src/`, deployed as Workers static assets:

```sh
npx wrangler deploy    # uses wrangler.jsonc
```

Open the resulting `https://spark-control.<you>.workers.dev` on your phone. Add it to your home screen and it runs like an app.

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
| `tools/` | capture decoder CLI, dev server, docs check |
| `test/` | `node:test` suites and real-capture fixtures |
| `docs/` | [PROTOCOL.md](docs/PROTOCOL.md), [APPS.md](docs/APPS.md), [CAPTURE.md](docs/CAPTURE.md), [RELEASING.md](docs/RELEASING.md) |
| `.github/workflows/` | CI (tests + docs check) and the tag-driven release pipeline |

## Development

```sh
npm test                                        # node:test, no install needed
node tools/btsnoop-decode.js btsnoop_hci.log    # decode a capture
npm install && npm run desktop:mock             # desktop app against the simulated amp
npm run check:docs                              # docs rule (also runs in CI)
```

The tests include a real Spark 40 preset dump. The decoder has to reproduce its checksums, and re-encoding has to give back the original bytes exactly.

## Releases

Push a version tag (`git tag v0.2.0 && git push origin v0.2.0`). GitHub Actions then rebuilds whichever of the web app, the Android app and the desktop apps changed since the last release, and publishes them on the [Releases](https://github.com/jerdog/positive-grid-spark/releases) page. See [docs/RELEASING.md](docs/RELEASING.md) for details and the optional signing and deploy secrets.

## Contributing

Read [AGENTS.md](AGENTS.md) first. It describes how the system fits together, and it applies to people as well as AI agents. One rule is enforced in CI: **any change to how the system works must update the docs and `AGENTS.md` in the same change.** CI also runs the tests on every pull request and on every push to `main`.

## Credits

Model "based on" information follows Positive Grid's own model descriptions. Gear names are trademarks of their owners.

The protocol knowledge comes from Paul Hamshere's [Spark](https://github.com/paulhamsh/Spark) and [Spark-Parser](https://github.com/paulhamsh/Spark-Parser) (Apache-2.0), and from stangreg's [Ignitron](https://github.com/stangreg/Ignitron) (BSD-3-Clause). See [NOTICE](NOTICE).

This is an independent interoperability project. It is not affiliated with or endorsed by Positive Grid. "Spark" and "Positive Grid" are their trademarks.
