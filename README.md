# Remote operator console

| Directory | Role |
|---|---|
| `console/` | Operator website and API (Node/Express + React). Coolify builds this with Base Directory `/console` and Dockerfile `/Dockerfile`. |
| `firmware/` | ESP32-S3 USB keyboard and mouse (PlatformIO). |
| `bridge/` | LookCam session bridge and the desk capture agent. |

## Secrets

Do not commit real credentials.

- Server: copy `console/.env.example` → `console/.env`
- Firmware: copy `firmware/include/secrets.h.example` → `firmware/include/secrets.h`
- Bridge: copy `bridge/env.example` → `bridge/.env` on the device only (`chmod 600`)

`DEVICE_TOKEN` stays on the HID relay and the ESP32. `CAPTURE_TOKEN` and `BRIDGE_TOKEN` stay on this server and the agent or bridge that dials in. The browser never receives them.

## Quick start

Server (see `console/README.md`):

```bash
cd console
cp .env.example .env
npm install
npm run build
npm start
```

Firmware (see `firmware/`):

```bash
cd firmware
cp include/secrets.h.example include/secrets.h
pio run -t upload
```

Bridge (see `bridge/README.md`):

```bash
cd bridge
cp env.example .env
```
