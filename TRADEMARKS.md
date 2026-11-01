# Name, logo and branding

The **code** in this repository is free software under the [GPL-3.0-or-later](LICENSE). Use it, study it, change it, build it, and share it, as that licence says.

The licence covers the code. It does **not** give anyone the right to use our name, logo or store presence as if their build were ours. This page says what that means. It's the same approach many open-source projects take, and it's meant to be friendly: build and fork freely, just don't pass your fork off as the official app.

## What belongs to blueDog Consulting and Jeremy Meiss

- The name **KindlingControl** (and "the kindling that controls your Spark"), and **blueDog Consulting**.
- The **logo**: the "Pick Flame" guitar pick holding a flame over crossed kindling, and the app icons made from it. The logo files are in `assets/logo/` so the project builds. They are there for building and using *this* project, and using them as the brand of a different app isn't permitted.
- The official **store listings**: their text, graphics and screenshots. These aren't in this repository.
- The official **app identifier** `dev.bluedog.kindlingcontrol` and the websites we run (kindlingcontrol.app).

## What you can do

- Build the app from source, for yourself or others, under the GPL.
- Fork it, change it, and distribute your version (with its source) under the GPL.
- Say your project is **based on** or **a fork of** KindlingControl, with a link to this repository.
- Describe what your app is for in your own words. You may say it works with Positive Grid Spark amps (see below).
- Package community builds (for example in a Linux distribution) and keep the name when the software is **unmodified**.

## What you shouldn't do, if your version differs from ours

- Don't call it "KindlingControl", or something confusingly similar, and don't use our logo or icon. **Pick your own name and artwork.**
- Don't use our app identifier. Change `appId` in `capacitor.config.json` and the Android `applicationId`, iOS bundle ID and electron-builder `appId` to your own. Google Play only allows one app per package name anyway.
- Don't copy our store listing text, graphics or screenshots. Write your own, and take your own screenshots.
- Don't suggest we made, endorse or support your version. Point your users' support and donation links at yourself: change the in-app **Buy me a coffee** link, the website and the contact details.
- Don't publish a modified build under our name on any store or website.

If you're not sure, ask by opening an issue. We say yes to most reasonable requests.

## Positive Grid and third parties

KindlingControl is an independent interoperability project. It is not made, endorsed or supported by Positive Grid. "Spark" and "Positive Grid" are trademarks of their owners; "Spark" is used only to say which amps the app works with. Gear names shown in the app ("based on…") are trademarks of their owners. Your fork should keep this disclaimer, and shouldn't use Positive Grid's own logos, art or text.
