# Starter presets

Presets made by the KindlingControl maintainers to share with the community, for example on the
[presets hub](https://kindlingspark.app/presets/). Each file is a preset JSON file, the same format the app's
**Export** writes (compatible with [Ignitron](https://github.com/stangreg/Ignitron)).

To try one: in the app, open the **Presets** tab, choose **Import JSON…**, pick the file, then load it. Importing
only adds it to *My presets*; nothing on the amp changes until you load it, and a hardware slot only changes if you
**Save…** to one.

| File | Sound | Notes |
|---|---|---|
| `famous-last-words.json` | Rhythm guitar in the style of My Chemical Romance, "Famous Last Words" | Tube Drive as a clean boost into a Plexiglas at about 7 gain, Guitar EQ trims the low end and lifts 800 Hz–1.6 kHz, short room reverb. Use the bridge humbucker; roll the amp's Gain back for the verses. |
| `welcome-to-the-black-parade.json` | Rhythm guitar in the style of My Chemical Romance, "Welcome to the Black Parade" | Clone Drive as a low-gain boost into an RB 101 at about 6.4 gain for a thicker, smoother wall of chords; looser gate so held chords sustain; quiet 200 ms digital delay and Hall Medium reverb for size. Bridge humbucker; for the quiet opening, switch to the neck pickup and turn your guitar's volume down. |

Song and band names only describe the sound these presets aim for. They are not affiliated with or endorsed by the
artists, and the values were tuned by ear, not taken from any official rig.

## Adding a preset

- Keep the 7 blocks in the standard order (gate, comp/wah, drive, amp, mod/EQ, delay, reverb) and use effect ids
  from `src/spark/effects.js`, so the preset works on every supported amp.
- Parameter values are 0–1 (the app shows them as 0–10).
- Give it a fresh UUID and `"PresetNumber": 127` (the temporary slot).
- `npm test` checks every file here (`test/presets.test.js`): it must import, round-trip and encode for the amp.
- Add a row to the table above.
