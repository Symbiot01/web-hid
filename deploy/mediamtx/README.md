# MediaMTX (Coolify)

Video middleman for the operator console: **Pi publishes H.264 (WHIP) → MediaMTX → browser (WHEP)**.

Keep this **separate** from the HID Node app. Never put video on `/ws/hid`.

## Coolify

1. New resource → **Docker Compose**.
2. Base directory: `deploy/mediamtx` (this folder).
3. Domain e.g. `media.yourdomain.com` → container port **8889** (TCP / HTTPS).
4. Env (recommended):

   ```
   MTX_WEBRTCADDITIONALHOSTS=media.yourdomain.com,YOUR_VPS_PUBLIC_IP
   ```

5. VPS firewall: allow **443/tcp** (proxy) and **8189/udp** (WebRTC ICE).  
   Do not expose **8554** publicly unless you need RTSP debug.

## URLs (path `cam`)

| Role | URL |
|---|---|
| Built-in test page | `https://media.yourdomain.com/cam` |
| Pi / ffmpeg publish (WHIP) | `https://media.yourdomain.com/cam/whip` |
| Browser play (WHEP) | `https://media.yourdomain.com/cam/whep` |
| RTSP debug | `rtsp://VPS_IP:8554/cam` |

Exact paths follow [MediaMTX WebRTC docs](https://mediamtx.org/docs/).

## Smoke test

1. Deploy; check container logs for listen on `:8889` / `:8189`.
2. Publish a test stream (OBS WHIP or ffmpeg) to `/cam/whip`.
3. Open `/cam` or WHEP in a browser from another network.
4. Then point the Pi camera publisher at the WHIP URL.

## Auth

Current `mediamtx.yml` allows open publish/read for bring-up. Before production, replace `authInternalUsers` with a publish credential for the Pi and restrict read (or put WHEP behind the same session proxy as the operator UI).

## Related

- HID control plane: repo root `Dockerfile` / Coolify HID app  
- Design: `docs/TECH_DESIGN.md` §6
