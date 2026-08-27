# Desk test gates (Steps 1–4)

Run these in order. Stop if a gate fails.

## Gate 0 — Server secrets and health

```bash
cd HID
cp .env.example .env   # if needed
# GATE_PASSWORD ≥16, SESSION_SECRET ≥32, DEVICE_TOKEN ≥16
npm install
npm start
```

In another terminal:

```bash
curl -s http://127.0.0.1:8080/healthz
# → {"ok":true}

# Missing secrets: temporarily empty DEVICE_TOKEN and confirm process exits on boot.

curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/app
# → 302 (redirect to login)

curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8080/api/paste \
  -H 'Content-Type: application/json' -d '{"text":"x"}'
# → 401
```

Unauthenticated WebSocket upgrades must return **401**:

- `GET /ws/device` without `?token=`
- `GET /ws/hid` without session cookie

## Gate 1 — Firmware hygiene

```bash
cd web-hid
cp include/secrets.h.example include/secrets.h
# Set WIFI_*, WS_HOST=<operator LAN IP>, WS_PORT=8080, WS_USE_SSL=false
# DEVICE_TOKEN must match HID/.env
pio run -t upload
```

Plug the XIAO into the **target** PC (not the operator PC). Confirm Wi-Fi joins and the operator UI device badge shows **Connected**.

Unplug Wi-Fi / kill power: badge → **Disconnected**.

## Gate 2 — Live keys on a second PC

1. Focus Notepad (or any editor) on the **target**.
2. On the operator: open `/app`, Focus view, click the camera placeholder, **Start live keys**.
3. Type `abc`, Shift, Enter, Backspace.
4. **Stop**. Close the operator tab mid-key.

Pass when:

- Characters appear only on the target.
- Stop / tab close leaves no stuck Ctrl/Shift/Alt.
- Device badge tracks connect/disconnect.

## Gate 3 — Dump paste

1. Stop live keys.
2. Paste view: enter ~20 characters, **Send**.
3. Check server log: a character **count** only (no paste body).

Pass when text appears on the target and live keys still work afterward.

## Gate 4 — Three-view focus isolation

1. Split view: type in the scratch textarea while live is off → nothing on target.
2. Start live, click the video placeholder, type → target receives keys.
3. Click scratch while live → keys stay local (scratch).
4. Switch Focus → Paste → Focus: each switch releases keys (`releaseAll`).

## Binary live frame (reference)

Little-endian:

| Bytes | Field |
|---|---|
| 0 | `op` (1=down, 2=up, 3=releaseAll) |
| 1 | `flags` (bit0 = seq present) |
| 2–3 | `seq` u16 |
| 4 | `usage` u8 (ops 1–2 only) |

## Not in these gates

Mouse, paced WPM, Pi camera, Go `hidfwd`, public TLS/MediaMTX.
