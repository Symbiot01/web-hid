# Operator Console

Password-gated browser console that drives an ESP32-S3 USB HID keyboard over WebSocket.
Live keys use **binary** frames on `/ws/hid`. Dump paste uses `POST /api/paste`.
The device connects only to `/ws/device?token=…` (no legacy unauthenticated path).

This is a **desk / LAN bridge** first. Anyone with the gate password can type on the PC the ESP32 is plugged into. Use a **second computer** as the target.

## Local run

```bash
cp .env.example .env
# Set GATE_PASSWORD (≥16), SESSION_SECRET (≥32), DEVICE_TOKEN (≥16)
npm install
npm start
```

Open `http://127.0.0.1:8080`, log in, wait for the device badge **Connected**, then Start live keys.

### Firmware (`web-hid`)

1. `cp include/secrets.h.example include/secrets.h` (gitignored).
2. Set Wi-Fi, `WS_HOST` = this PC LAN IP, `WS_PORT=8080`, `WS_USE_SSL=false`, same `DEVICE_TOKEN`.
3. `pio run -t upload`. Plug into the **target** PC.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `GATE_PASSWORD` | yes | UI password, min 16 chars |
| `SESSION_SECRET` | yes | Cookie signing, min 32 (`openssl rand -hex 32`) |
| `DEVICE_TOKEN` | yes | Device WS token, min 16 |
| `PORT` | no | Default `8080` |
| `HOST` | no | Default `0.0.0.0` |
| `NODE_ENV` | no | `development` or `production` |
| `TRUST_PROXY` | no | `1` behind a reverse proxy |

## API / sockets

- `POST /api/login` — password → HttpOnly session cookie (5 / 15 min)
- `POST /api/logout`
- `GET /api/status` — `{ deviceConnected }` (session)
- `POST /api/paste` — `{ text }` dump to device (session, max 2000 chars)
- `GET /healthz` — `{ ok: true }`
- `WS /ws/hid` — binary live HID frames; cookie + origin check; status/errors as small JSON
- `WS /ws/device?token=` — ESP32 only

Key identities and paste bodies are never logged; only character counts and connect events.

## Desk test gates

1. Server refuses to start without the three secrets. `/healthz` → 200. Unauthenticated `/ws/device` and `/ws/hid` → 401.
2. Live keys type `abc` into Notepad on the target. Stop / close tab → no stuck modifiers.
3. Paste view Send of ~20 chars appears on target. Logs show a count only.
4. Scratch pane typing does not reach the target; Focus live does.

## Out of scope (later)

Mouse, paced WPM paste, Pi camera / WebRTC, Go `hidfwd`, public MediaMTX.
