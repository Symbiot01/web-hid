# HID simulator

Stands in for the ESP32-S3 keyboard. It dials the operator console at `/ws/device` and writes paste text and live keystrokes into `hid_test.txt`.

```bash
cd hid_simulator
cp .env.example .env   # already set for webrelay.sahilpatel.online
npm install
npm start
```

Defaults:

| Variable | Value |
|---|---|
| `WS_URL` | `wss://webrelay.sahilpatel.online/ws/device` |
| `DEVICE_TOKEN` | `YOUR_DEVICE_TOKEN` |
| `OUTPUT_FILE` | `./hid_test.txt` |

`DEVICE_TOKEN` on the console (Coolify env for `webrelay.sahilpatel.online`, and `console/.env` locally) must be the same value. The simulator does not print the token.

Send paste or type in the HID tab on the website. The text shows up in `hid_test.txt`.
