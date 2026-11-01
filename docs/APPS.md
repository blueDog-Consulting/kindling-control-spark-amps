# Building the apps

Every platform runs the same UI and protocol code from `src/`. Only the Bluetooth transport changes:

| Platform | Shell | Bluetooth |
|---|---|---|
| Web (Chrome / Edge) | none (`npm run serve` or Cloudflare) | Web Bluetooth (`transport-ble.js`) |
| Windows / macOS / Linux | Electron (`desktop/`) | Chromium's Web Bluetooth, with our own device picker |
| Android | Capacitor (`android/`) | native, via `@capacitor-community/bluetooth-le` (`transport-capacitor.js`) |
| iPad / iPhone | Capacitor (`ios/`) | native CoreBluetooth, same plugin |

The app picks the transport at runtime: native plugin if present, otherwise Web Bluetooth.

iPad is the reason the native apps exist. Every browser on iOS/iPadOS uses WebKit, which has no Web Bluetooth, so a web page can't reach the amp there.

Tagged releases are built by CI (web, Android, desktop). See [RELEASING.md](RELEASING.md). The steps below are for building on your own machine.

First, once:

```sh
npm install
```

`npm install` prints deprecation warnings and around 18 *moderate* audit findings. They all come from inside the build tools (electron-builder and the Capacitor CLI) and aren't fixable from this project. None of that code ships in any app, and none of them can be triggered by building your own project. `npm audit --omit=dev` covers what actually ships and reports 0. Don't run `npm audit fix --force`: it downgrades both tools several major versions and breaks the builds. **High** or **critical** findings are a different matter, especially in `electron`, because Electron ships inside the desktop app. Bump it when one appears.

## Desktop (Electron)

```sh
npm run desktop          # run against a real amp
npm run desktop:mock     # run against the simulated amp
npm run desktop:dist     # build an installer for the current OS into dist/
```

`desktop:dist` produces a `.dmg` on macOS, an NSIS `.exe` installer on Windows, and an `AppImage` plus `.deb` on Linux. Build each OS on that OS. Each platform's notes:

* **macOS:** the app declares `NSBluetoothAlwaysUsageDescription`, and macOS asks for Bluetooth permission on the first connect. To give the app to anyone else you'll need to sign and notarize it with an Apple Developer ID (see electron-builder's `mac.identity` and `notarize` options). Unsigned builds only run on your own Mac after right-click → Open.
* **Windows:** works with the built-in Bluetooth stack on Windows 10 and 11. Unsigned installers trigger a SmartScreen warning.
* **Linux:** needs BlueZ. The app turns on Chromium's experimental Web Bluetooth flag automatically.

The zero-effort alternative on desktop is the web version in Chrome or Edge, using *Install app* from the address bar. It gets its own window and Dock/Start-menu icon, and needs no Electron.

## Android (Capacitor)

Needs [Android Studio](https://developer.android.com/studio). It provides the SDK and the JDK.

```sh
npm run android          # copies src/ into the project and opens Android Studio
```

In Android Studio, press **Run** with your phone or tablet plugged in (USB debugging on). To share an APK: *Build → Build App Bundle(s) / APK(s) → Build APK(s)*.

Permissions: on Android 12+ the app asks only for *Nearby devices*. It declares `neverForLocation`, so there's no location prompt. Android 11 and older ask for location, because the OS requires it for BLE scans.

## iPad / iPhone (Capacitor)

Needs a Mac with Xcode. No CocoaPods: Capacitor 8 uses Swift Package Manager.

```sh
npm run ios              # copies src/ into the project and opens Xcode
```

In Xcode:

1. Select the **App** target → *Signing & Capabilities* → choose your **Team**. A free Apple ID works for installing on your own devices; those builds expire after 7 days.
2. Plug in the iPad, select it as the run destination, and press **Run**.
3. The first time, approve the developer certificate on the iPad: *Settings → General → VPN & Device Management*.

The project is already universal (iPhone + iPad, all orientations). Getting it to friends via TestFlight or the App Store needs a paid Apple Developer account.

## After changing the web code

`src/` is copied into the native projects, so after edits run:

```sh
npx cap sync             # or npm run android / npm run ios, which sync first
```

Electron and the web version read `src/` directly; just reload.

## App icons and splash screens

Every platform's icons are generated from the logo SVGs in `assets/logo/concepts/<concept>/`. Each concept has an `icon.svg` (full-bleed 1024 tile) and a `foreground.svg` (transparent, for Android adaptive icons). The current concept is `CONCEPT` in `tools/build-icons.js` ("pick", the Pick Flame: a guitar pick holding a flame over kindling).

```sh
npm run icons              # regenerate everything from the current concept
npm run icons -- kindling  # try another concept: kindling, knob, monogram, necks, amp, pick
```

The script writes, and you commit:

| Platform | Files |
|---|---|
| Web | `src/icon.svg` (favicon), `src/icons/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` |
| Desktop | `build/icon.png` (Windows/Linux), `build/icon-mac.png` (macOS template with margin and shadow) |
| Android | `mipmap-*/ic_launcher*.png` (legacy, round, adaptive foreground), the `ic_launcher_background` colour, `drawable*/splash.png` |
| iOS | `AppIcon-512@2x.png` (opaque, 1024), `Splash.imageset/*.png` |

Run `npx cap sync` afterwards so the native projects pick up the new web icons.

## Troubleshooting the connection

Every Bluetooth step is logged in the **Console** tab (lines starting `bluetooth:`), and errors name the step that failed. That makes it easy to tell whether it was the GATT connect, finding the service, starting notifications, or a write.

* **"GATT operation failed for unknown reason"** (`NotSupportedError`, common on macOS): the app now writes without response, like Ignitron does. It falls back to the other write mode by itself, and it retries starting notifications once. If it still fails, note which step the Console names.
* **The amp only accepts one app at a time.** Close the official Spark app on your phone, or turn off Bluetooth on the phone, before connecting.
* **"Paired" in the chooser** just means the OS already knows the amp, for example from Bluetooth audio. That's fine. If connecting keeps failing on a Mac, try disconnecting the Spark as an *audio* device in System Settings → Bluetooth (don't forget it) and connect again.
* **macOS:** Chrome needs Bluetooth permission under System Settings → Privacy & Security → Bluetooth.
* `chrome://bluetooth-internals` shows what Chrome sees: services, characteristics and their properties.
