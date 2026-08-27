# MediaMTX (Coolify)

Video middleman for the operator console: **Pi publishes H.264 (WHIP) → MediaMTX → browser (WHEP)**.

Keep this **separate** from the HID Node app. Never put video on `/ws/hid`.

Config is **copied into the image** via `Dockerfile` (no bind-mount of `mediamtx.yml`). That avoids Coolify creating `mediamtx.yml` as a directory and failing the mount.

## Coolify

1. New resource → **Docker Compose**.
2. Base directory: `deploy/mediamtx` (this folder).
3. Domain e.g. `mediarelay.sahilpatel.online` → container port **8889** (TCP / HTTPS).
4. Env (required for WebRTC ICE):

   ```
   MTX_WEBRTCADDITIONALHOSTS=mediarelay.sahilpatel.online,34.42.4.172
   ```

5. VPS firewall: allow **443/tcp** (proxy) and **8189/udp** (WebRTC ICE).  
   Do not expose **8554** publicly unless you need RTSP debug.

### If a previous deploy failed on the yml mount

SSH to the server and remove the bad path if it is a directory:

```bash
sudo rm -rf /data/coolify/applications/<resource-uuid>/mediamtx.yml
```

Then redeploy.

## URLs (path `cam`)

| Role | URL |
|---|---|
| Built-in test page | `https://mediarelay…/cam` |
| Pi / ffmpeg publish (WHIP) | `https://mediarelay…/cam/whip` |
| Browser play (WHEP) | `https://mediarelay…/cam/whep` |
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
