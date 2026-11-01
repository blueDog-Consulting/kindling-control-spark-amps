# Capturing the official app's traffic

When you want to know how the official app does something this project doesn't support yet (a new effect, the looper, a Spark 2 feature), record the Bluetooth traffic while you do it in the app, then decode the log.

## 1. Turn on the Bluetooth HCI snoop log (Android)

1. Turn on **Developer options**: *Settings → About phone →* tap **Build number** 7 times.
2. *Settings → System → Developer options →* **Enable Bluetooth HCI snoop log** → **Enabled**. On some phones the option is called "Full".
3. Turn Bluetooth **off and on** again so logging starts.

## 2. Record a session

1. Open the Spark app and connect to your amp.
2. Do one thing at a time and note the time, for example: "switch to preset 2", "set gain to 7", "turn on the looper".
3. Close the app.

Short, focused captures are much easier to read than one long session.

## 3. Get the log off the phone

The easiest route is a bug report:

```sh
adb bugreport bugreport.zip
unzip -o bugreport.zip 'FS/data/misc/bluetooth/logs/*' -d bugreport
# the file is usually  bugreport/FS/data/misc/bluetooth/logs/btsnoop_hci.log
```

On some phones you can also pull it directly:

```sh
adb pull /sdcard/btsnoop_hci.log            # older Android
adb pull /data/misc/bluetooth/logs/btsnoop_hci.log   # needs root on most phones
```

Without a computer, *Developer options → Take bug report* produces the same zip, which you can share to yourself.

Turn the snoop log off again when you're done. It keeps growing and records all Bluetooth traffic.

## 4. Decode it

**In the browser:** open the web app, go to the **Capture** tab and choose the file. Decoding happens locally; nothing is uploaded.

**On the command line:**

```sh
node tools/btsnoop-decode.js btsnoop_hci.log            # readable timeline
node tools/btsnoop-decode.js btsnoop_hci.log --raw      # plus raw chunk hex
node tools/btsnoop-decode.js btsnoop_hci.log --unknown  # only messages not understood yet
node tools/btsnoop-decode.js btsnoop_hci.log --json > session.jsonl
```

Example output:

```
    0.000s  app → amp  [02 11] seq=01 request  what=AMP_NAME values=[]
    0.007s  amp → app  [03 11] seq=01 ampName  name=Spark 40
    0.014s  app → amp  [01 04] seq=02 param  effect=Twin index=0 value=0.5
    0.021s  amp → app  [03 99] seq=09 unknown  values=[true,5]
```

Messages marked `unknown` still get a best-effort generic msgpack decode in `values`. That's usually enough to work out the meaning. Then add a builder or parser in `src/spark/messages.js`, plus a test.

The decoder handles BLE (ATT writes, notifications and long writes) and Classic (RFCOMM/SPP). It finds the Spark streams by their `01 FE 00 00` block signature, so other Bluetooth devices in the log (headphones, watches) are ignored.

## Sniffing without a phone log

* **nRF Connect** (Android/iOS) can connect to the amp and subscribe to `0xFFC2`, which is good for watching events while you turn knobs.
* The web app's **Console** tab shows every decoded message in both directions. It can also send raw `cmd sub data` messages, which helps when you're probing unknown commands. Probe with **requests** (`02 xx`) first. Writes (`01 xx`) change the amp's state.
