# Stream-test notes / known issues

Operator console **Stream-test** tab: browser camera → WHIP → MediaMTX path `desk` → WHEP → glass-to-glass QR latency.

## Known issue: `Failed to fetch` on WHIP (CSP)

**Symptom (2026-08-27):**

- Log shows camera OK, then `WHIP: ICE gathering timed out`, then  
  `WHIP POST https://mediarelay…/desk/whip` → **`Start failed: Failed to fetch`** (~2 ms later).
- DevTools **Network** search for `desk/whip` finds **no request**.
- Console often shows CSP “Refused to connect…” errors.

**Cause:** HID Node Helmet CSP had `connect-src 'self'` only. The UI is on `webrelay…`; WHIP/WHEP go to `mediarelay…` (cross-origin). The browser blocked `fetch` and STUN (`stun:stun.l.google.com:19302`), so ICE hung until the 8s gather timeout and the WHIP POST never left the page.

This is **not** a MediaMTX cert/502 problem (TLS to mediarelay can be fine while the HID CSP still blocks the client).

**Fix:** Allow media origin + STUN in CSP (`src/http.js`), driven by `MEDIA_BASE_URL` / `MEDIA_STUN_URL` in `src/config.js` (defaults match `VITE_MEDIA_BASE_URL`). Redeploy/restart the **HID** app after changing CSP.

**Verify:**

1. Response headers on `webrelay` include  
   `Content-Security-Policy: … connect-src 'self' https://mediarelay.sahilpatel.online stun:stun.l.google.com:19302 …`
2. Stream-test → Start loopback → Network shows `POST …/desk/whip` (and usually OPTIONS).
3. ICE gather completes without the CSP-related 8s stall (UDP **8189** / `MTX_WEBRTCADDITIONALHOSTS` still required for media path).

## Related

- First desk results + bottlenecks: `docs/STREAMTEST_LOG.md`
- Gate 7: `docs/DESK_TESTS.md`
- MediaMTX Coolify: `docs/MEDIAMTX_COOLIFY_CASESTUDY.md`, `deploy/mediamtx/README.md`
- Client media URL: `web/src/lib/mediaConfig.ts` (`VITE_MEDIA_BASE_URL`)
