# Store release notes

One folder per released version. The folder name is the tag without the `v`:

```
release-notes/
  0.3.0/
    android.txt     Google Play "What's new" (500 characters at most)
    macos.txt       Mac App Store "What's New in This Version" (4000 characters at most)
  0.3.1-beta.1/     pre-releases get their own folder if they need notes
```

Plain text, no Markdown (the stores don't render it). Write for users: what they can do now, not what changed in the code.

- Commit the notes **before** you tag. `git tag v0.3.0` ships exactly `release-notes/0.3.0/`.
- A final (non-pre-release) tag that builds Android **fails early** if `android.txt` is missing, empty or over the limit. Pre-releases don't need notes.
- `macos.txt` is optional because macOS isn't built in CI, but if it exists it is validated and published the same way.
- The release workflow adds the notes to the GitHub Release body and attaches them as `kindling-control-<version>-android-whatsnew.txt` and `…-macos-whatsnew.txt`, ready to paste into Play Console / App Store Connect. Android notes are included only when that release built Android.
- Check locally: `npm run release:notes -- v0.3.0 --require android`

See [docs/RELEASING.md](../docs/RELEASING.md).
