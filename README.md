# Remote operator console

| Directory | Role |
|---|---|
| `console/` | Operator website and API (Node/Express + React). Includes the sandboxed C++17 runner, harness-first coding agent (`gemini-4-argon`), LookCam stream viewer, and HID keyboard/mouse proxy. Coolify builds this with Base Directory `/console` and Dockerfile `/Dockerfile`. |
| `firmware/` | ESP32-S3 USB keyboard and mouse (PlatformIO). |
| `bridge/` | LookCam session bridge and the desk capture agent. |

## Secrets

Do not commit real credentials.

- Server: copy `console/.env.example` → `console/.env`
- Firmware: copy `firmware/include/secrets.h.example` → `firmware/include/secrets.h`
- Bridge: copy `bridge/env.example` → `bridge/.env` on the device only (`chmod 600`)

`DEVICE_TOKEN` stays on the HID relay and the ESP32. `CAPTURE_TOKEN`, `BRIDGE_TOKEN`, and `GEMINI_API_KEY` stay on this server and the agent or bridge that dials in. The browser never receives them.

## Coding Agent (`gemini-4-argon`)

Set `GEMINI_API_KEY` (and optional `GEMINI_MODEL=gemini-4-argon`) in `console/.env`. The agent follows a harness-first workflow:
1. Extracts the problem statement, target function signature (or `solve()`), and exact sample I/O format from text or a screenshot.
2. Builds the `int main()` I/O test wrapper first and implements the algorithm inside the target function.
3. Compiles and runs test cases in an isolated sandbox (`bwrap` / `prlimit`), and supports adding extra edge/stress test cases (`+ Edge cases` or natural language requests) and human-in-the-loop guidance.

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
