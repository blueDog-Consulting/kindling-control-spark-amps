# Spark Bluetooth protocol

This is how the Positive Grid Spark amps (Spark 40, MINI, GO, 2, NEO) talk to the Spark app. It builds on community reverse engineering, mainly Paul Hamshere's [Spark](https://github.com/paulhamsh/Spark) protocol description and stangreg's [Ignitron](https://github.com/stangreg/Ignitron). `src/spark/` implements everything described here, and the tests check it against real captured traffic.

The parts marked **(unverified)** are things the community has seen but that nobody has confirmed on every model. To confirm or extend them, capture your own amp's traffic (see [CAPTURE.md](CAPTURE.md)).

## Transport

| | |
|---|---|
| BLE service | `0xFFC0` |
| Write characteristic (app → amp) | `0xFFC1`. Supports write and write-without-response |
| Notify characteristic (amp → app) | `0xFFC2` |
| Classic Bluetooth | Spark 40 also offers SPP/RFCOMM. Older Android app versions used it. |

The bytes are identical on BLE and SPP. They're a stream of **blocks**, and a block doesn't have to fit in one BLE notification: the amp splits blocks across notifications, and the app may split one block across several writes. The reader has to buffer and reassemble.

Writing to the amp, as Ignitron does on real amps:

* Use **write-without-response**. On Spark 2 + macOS, write-with-response fails with "GATT operation failed for unknown reason". The transports here fall back to the other mode once if a write fails.
* Spark 40, GO and NEO accept up to `0xAD` bytes per write. MINI and Spark 2 need writes of `0x64` bytes or less, and a pause of about 80 ms after each block.
* Until the amp has reported its name (`02 11`), use the conservative limits: `0x64`-byte writes with 80 ms between blocks.

## Framing

```
block  = 01 FE 00 00 | dir(2) | len(1) | 00 ×9 | chunk-stream…
           magic       53 FE = to amp       total block length, including this 16-byte header
                       41 FF = from amp
chunk  = F0 01 | seq | xor | cmd | sub | 7-bit data… | F7
```

* A block can hold several chunks, and a chunk can **continue into the next block**. Amp → app blocks are at most `0x6A` bytes, and the amp packs several 39-byte chunks into each one. App → amp blocks are at most `0xAD` bytes.
* `seq` is a message counter (1…0x7F) chosen by the sender. Acks echo it back.
* `xor` is the XOR of every 7-bit data byte between `sub` and `F7`.
* All chunk data is 7-bit, so `F0`, `F7` and `01 FE` can't appear inside it. That makes resyncing a stream easy.

### 7-bit packing

The 8-bit payload is split into groups of up to 7 bytes. Each group goes on the wire as one byte holding the high bits (bit *n* = the 8th bit of byte *n*), followed by the 7 low-bit bytes. This is the same packing MIDI SysEx uses.

### Multi-chunk messages

Presets (`01 01` and `03 01`) are too large for one chunk. Every chunk of a preset starts its 8-bit payload with a 3-byte sub-header, `total, index, length`, and all chunks share the same `seq`.

| direction | max 8-bit payload per chunk |
|---|---|
| app → amp | `0x80` (one chunk fills one `0xAD` block exactly) |
| amp → app | `0x19` |

## Payload values

The payload is roughly [msgpack](https://msgpack.org):

| bytes | meaning |
|---|---|
| `00`–`7F` | small int |
| `CC xx` / `CD xx xx` / `CE ×4` | uint8 / uint16 / uint32 |
| `90+n` | array of *n* |
| `A0+n …` | string of *n* ≤ 31 chars |
| `D9 n …` | string of *n* chars (used for UUIDs and long names) |
| `n A0+n …` | **"prefixed" string**: a length byte, then a normal fixstr. Used for effect names in `01 04`, `01 06`, `01 15`, `03 37`, `03 06` and others |
| `C2` / `C3` | false / true |
| `CA ×4` | float32, big-endian |

Parameter values are floats from 0.0 to 1.0. The app shows them as 0 to 10.

## Commands

`cmd`: `01` write (app → amp), `02` request (app → amp), `03` response or event (amp → app), `04` ack, `05` intermediate ack (preset upload).

### App → amp

| cmd sub | payload | reply | meaning |
|---|---|---|---|
| `01 01` | preset (see below), multi-chunk | `05 01` per chunk, `04 01` at the end | upload preset to slot 0–3 or `7F` (temporary) |
| `01 04` | pstr effect, int param, float value | **none** | set a parameter |
| `01 06` | pstr old, pstr new | `04 06` | swap the model in a slot (e.g. `Twin` → `Plexi`) |
| `01 15` | pstr effect, bool, `00` | `04 15` | effect on/off |
| `01 28` | pstr effect, bool | `04 28` | ask the amp to report expression/wah volume (JH.Vox846) |
| `01 38` | `00`, slot | `04 38` | select a hardware preset (0–3; **Spark 2: 0–7**, where 4–7 is bank 2), or `7F` |
| `01 65` | bool | `04 65` | tuner on/off **(GO / MINI / 2 / NEO)** |
| `01 70` | 64-byte key | `04 70` | licence key the app sends at startup. Not needed for control. |
| `01 75` / `01 76` | … | | looper command / settings **(Spark 2 / GO / NEO, unverified)** |
| `02 01` | `00 n` hardware slot, or `01 00` for the live state | `03 01` | read a preset |
| `02 10` | – | `03 10` (`00 n`) | which preset is selected |
| `02 11` | – | `03 11` (pstr) | amp name, e.g. `Spark 40`, `Spark GO`, `Spark MINI`, `Spark 2`, `Spark NEO` |
| `02 23` | – | `03 23` (string) | serial number |
| `02 2A` | `94 00 01 02 03` | `03 2A` | checksums of the 4 stored presets |
| `02 2B` | `00` | `03 2B` | extended checksums **(newer amps)** |
| `02 2F` | – | `03 2F` (`CE` + 4 bytes) | firmware version a.b.c.d |
| `02 71` | – | `03 71` | power / battery status **(not Spark 40)** |
| `02 72`, `02 75`, `02 76`, `02 78` | – | `03 xx` | unknown / looper status **(unverified)** |

### Amp → app (unsolicited events)

| cmd sub | payload | when |
|---|---|---|
| `03 06` | pstr old, pstr new | amp model changed with the amp's knob |
| `03 15` | pstr effect, bool | effect toggled from the amp (mod / delay knobs) |
| `03 27` | `00`, slot | user long-pressed a preset button to store |
| `03 28` | float | expression/wah volume |
| `03 37` | pstr effect, int param, float value | a knob was turned on the amp |
| `03 38` | `00`, slot | preset button pressed on the amp (Spark 2 reports 4–7 for bank 2) |
| `03 63` | float bpm | tap tempo |
| `03 64` | int note (0 = C), float offset (0.5 = in tune) | tuner reading |
| `03 65` | bool | tuner turned on/off from the amp |
| `03 6B` | float | input volume |
| `03 71` | `[?, 1, batteryPowered, charging(0 discharging, 1 powered, 2 charging, 3 full), level(uint16), ?, ?]` | power status |
| `03 75`…`03 78` | … | looper **(unverified)** |

## Preset format

```
00 slot            (or 01 00 for "current state")
D9 24 <uuid>       36-char UUID
str name
str version        usually "0.7"
str description
str icon           usually "icon.png"
CA float bpm
97                 array of 7 effects, in signal-chain order:
                   gate, comp/wah, drive, amp, mod/EQ, delay, reverb
  str  effect id
  bool on
  9n   array of n params
    int index, 91, CA float value     (repeated n times)
checksum           (sum of all bytes after the 2 slot bytes) mod 256
```

Values have to round-trip bit-exactly (float32), or the checksum and the `02 2A` slot checksums stop matching what the app expects.

Effect ids and parameter names are listed in [`src/spark/effects.js`](../src/spark/effects.js). The reverb model is always `bias.reverb`; its parameter 6 picks the reverb type (0.0, 0.1, … 0.8).

## Signal chain order

Every preset has exactly 7 blocks, and factory presets always use the order gate → comp/wah → drive → amp → mod/EQ → delay → reverb. The official app has no way to reorder them, and it treats the blocks as slot types: the wah is chosen in the compressor slot, and the EQs in the modulation slot. **Whether the firmware accepts or processes a different order is unknown (unverified).**

The app's **Reorder chain** feature probes this safely:

1. It sends the reordered preset to the temporary slot `7F` (`01 01`), then selects it (`01 38`).
2. It reads the live state back (`02 01 01 00`).
3. If the amp returns the canonical order, the firmware normalises the order. If it returns the new order, the amp at least *stored* it; confirm by ear whether the sound changed.

Please record real-amp results here (model, firmware, outcome).

## Spark 2 preset banks

The Spark 2 stores 8 presets in two banks of four. The bank button on the amp just changes which four the preset buttons select. On the wire there's no "bank" message: the slot number covers both banks, with **0–3 for bank 1 and 4–7 for bank 2**, in `01 38`, `03 38`, `02 10`/`03 10` and `02 01`. Ignitron also uses `02 2B 00` (extended checksums) instead of `02 2A` on the Spark 2.

## Startup sequence used by the official app

`02 11` amp name → `02 2A` checksums → `02 23` serial → `01 70` licence → `02 01` × 4 (stored presets) → `02 10` selected preset → `02 2F` firmware → `02 01 01 00` live state.

`SparkClient.handshake()` runs a reduced version of this: name, serial, firmware, selected preset and power status.

## Open questions (good targets for your captures)

* Spark 2 / NEO-only messages, such as the looper, the extra effect models, and any per-model differences in `03 71`.
* The meaning of `02 72` / `03 72` and the unknown fields in `03 71`.
* Whether the amp accepts preset uploads without the `01 70` licence key on every firmware. The Ignitron community reports that it does.
