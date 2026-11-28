# Store release notes

One folder per released version. The folder name is the tag without the `v`:

```
release-notes/
  0.3.0/
    android.txt     Google Play "What's new" (500 characters at most)
    ios.txt         App Store (iPhone and iPad) "What's New in This Version" (4000 characters at most)
    macos.txt       Mac App Store "What's New in This Version" (4000 characters at most)
  0.3.1-beta.1/     pre-releases get their own folder if they need notes
```

Plain text, no Markdown (the stores don't render it). Write for users: what they can do now, not what changed in the code.

- `npm run release -- v0.3.0` drafts `android.txt` from the commit log, opens it in your editor, validates it, then commits, pushes, tags and pushes the tag.
- Tagging by hand? Commit and push the notes **before** you tag. `git tag v0.3.0` ships exactly `release-notes/0.3.0/`.
- A final (non-pre-release) tag that builds Android **fails early** if `android.txt` is missing, empty or over the limit. Pre-releases don't need notes.
- `ios.txt` is optional and, like `macos.txt`, isn't checked or published by CI until iOS is built there.
- `macos.txt` is optional. macOS isn't built in CI, so CI doesn't check or publish it: check it locally (`npm run release:notes -- v0.3.0`) and paste it into App Store Connect yourself.
- The release workflow checks and publishes notes only for the store apps that release builds (today: Android). It adds them to the GitHub Release body and attaches `kindling-control-<version>-android-whatsnew.txt`, ready to paste into Play Console.
- Check locally: `npm run release:notes -- v0.3.0 --require android`

See [docs/RELEASING.md](../docs/RELEASING.md).
