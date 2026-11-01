# Spark Control

An open replacement for the Positive Grid Spark app. It's a JavaScript implementation of the amp's Bluetooth protocol, with a web UI that talks straight to the amp from your phone's browser over **Web Bluetooth**. You don't need to install anything, there's no account, and it doesn't phone home.

Works with Spark 40, Spark GO, Spark MINI, Spark 2 and Spark NEO. All of them use the same BLE service (`0xFFC0`).

| Where | How |
|---|---|
| Android | the web app in Chrome, or the native app (`android/`) |
| iPad / iPhone | the native app (`ios/`). iOS browsers have no Web Bluetooth. |
| Windows / macOS / Linux | the desktop app (`desktop/`, Electron), or the web app in Chrome/Edge |

Build instructions for each are in [docs/APPS.md](docs/APPS.md).

## What it does

* **Tone:** switch hardware presets 1–4; turn every effect on or off; swap amp and effect models; edit every parameter. Turning a knob on the amp updates the UI live.
* **Presets:** export the live tone as JSON, or import one. Imports go to the amp's temporary slot, so your stored presets are left alone. The JSON format is compatible with [Ignitron](https://github.com/stangreg/Ignitron)'s preset files.
* **Tuner** on models that support it.
* **Console:** every message in both directions, decoded, with the raw hex. You can also send arbitrary commands.
* **Capture decoder:** load an Android `btsnoop_hci.log` and see exactly what the official app sends. This is how you reverse engineer the features that aren't covered yet. See [docs/CAPTURE.md](docs/CAPTURE.md).

## Use it

In a browser, Web Bluetooth needs **Chrome or Edge**: on Android, Windows, macOS, Linux or ChromeOS. iOS browsers don't support it, so iPad and iPhone need the native app. The page also has to be served over HTTPS (or `localhost`).

```sh
npm run serve          # http://localhost:8787  (no dependencies)
                       # http://localhost:8787/?mock            simulated Spark 40
                       # http://localhost:8787/?mock=Spark%20GO  simulated GO (battery, tuner)
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

await amp.selectPreset(2);
await amp.setParam('Twin', 0, 0.7);          // gain to 7
await amp.setEffectOnOff('ChorusAnalog', true);
await amp.changeEffect('Twin', 'Plexi');

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

## Development

```sh
npm test                                        # node:test, no install needed
node tools/btsnoop-decode.js btsnoop_hci.log    # decode a capture
npm install && npm run desktop:mock             # desktop app against the simulated amp
```

The tests include a real Spark 40 preset dump. The decoder has to reproduce its checksums, and re-encoding has to give back the original bytes exactly.

## Credits

The protocol knowledge comes from Paul Hamshere's [Spark](https://github.com/paulhamsh/Spark) and [Spark-Parser](https://github.com/paulhamsh/Spark-Parser) (Apache-2.0), and from stangreg's [Ignitron](https://github.com/stangreg/Ignitron) (BSD-3-Clause). See [NOTICE](NOTICE).

This is an independent interoperability project. It is not affiliated with or endorsed by Positive Grid. "Spark" and "Positive Grid" are their trademarks.
