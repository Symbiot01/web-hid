# HID Web Relay

Password-gated browser console that relays text to an ESP32 USB HID keyboard over WebSocket.

This is a **local network keyboard bridge**, not a public website. Anyone with the gate password can type on the PC the ESP32 is plugged into.

## Local run

```bash
cp .env.example .env
# Edit .env: set GATE_PASSWORD (≥16 chars), SESSION_SECRET (≥32 chars),
# ALLOW_LEGACY_DEVICE=true, NODE_ENV=development
npm install
npm start
```

Open `http://<LAN-IP>:8080`, log in, wait for the ESP32 badge to show **Connected**, then send text.

### Firmware (sibling project `web-hid`)

Current `main.cpp` is a TCP connectivity test. Restore the commented HID WebSocket client and point it at this host:

- `WS_HOST` = your PC LAN IP
- `WS_PORT` = `8080`
- `WS_PATH` = `/` (empty path)

The device should send `{"type":"device_ready"}` on connect. The server sends **raw text + newline**; firmware types it with `Keyboard.print()`.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `GATE_PASSWORD` | yes | Shared UI password, min 16 chars. Never commit. |
| `SESSION_SECRET` | yes | Cookie signing secret, min 32 chars (`openssl rand -hex 32`). |
| `PORT` | no | Default `8080` local; Coolify should use `3000`. |
| `HOST` | no | Default `0.0.0.0`. |
| `NODE_ENV` | no | `development` or `production`. |
| `TRUST_PROXY` | no | Set `1` behind Coolify so rate limits see real IPs. |
| `ALLOW_LEGACY_DEVICE` | no | Must be exactly `true` to accept unauthenticated ESP32 WS on `/`. |
| `DEVICE_TOKEN` | no | Enables future `wss://…/ws/device?token=…` path. |

Legacy `/` WebSocket is **off** unless `ALLOW_LEGACY_DEVICE=true`. Do not enable that on a public host.

## Coolify (GitHub → Application)

1. Push **this** `HID` folder as its own GitHub repo (not `web-hid`).
2. Create a Coolify **Application** from that repo URL (Dockerfile build).
3. One domain, HTTPS on, WebSocket/Upgrade enabled. Do **not** publish host port 8080.
4. Set env in Coolify UI:
   - `GATE_PASSWORD` (strong, ≥16)
   - `SESSION_SECRET` (random, ≥32)
   - `NODE_ENV=production`
   - `PORT=3000`
   - `TRUST_PROXY=1`
   - Leave `ALLOW_LEGACY_DEVICE` **unset** until firmware speaks `wss://your-domain/ws/device?token=…` with `DEVICE_TOKEN` set.
5. Healthcheck path: `/healthz`.

Coolify **Servers** list stays unchanged — this is one Application.

## API / sockets (summary)

- `POST /api/login` — password → HttpOnly session cookie (rate limited)
- `POST /api/logout`
- `GET /api/status` — `{ deviceConnected }` (session required)
- `GET /healthz` — `{ ok: true }`
- `WS /ws/ui` — browser JSON (`send` / `ping`); cookie + origin check
- `WS /` — legacy ESP32 (only if `ALLOW_LEGACY_DEVICE=true`)
- `WS /ws/device?token=` — when `DEVICE_TOKEN` is set

Keystroke bodies are never logged; only character counts and connect events.
