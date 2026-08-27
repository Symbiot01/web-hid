# Stream-test latency / quality log

Operator **Stream-test** loopback (same PC browser → WHIP → MediaMTX → WHEP → same page).
Glass-to-glass via QR timestamp on published frames (`hidlat:{ms}`).

## Environment

| Item | Value |
|---|---|
| Date | 2026-08-27 |
| Media relay | `mediarelay.sahilpatel.online` (Dallas VPS, MediaMTX path **`desk`**) |
| UI / control | `webrelay.sahilpatel.online` (HID React SPA) |
| Path | Camera → canvas 1920×1080 @ 30 + QR → WHIP → MediaMTX → WHEP → `<video>` → jsQR |
| CSP | Fixed earlier so `connect-src` allows media origin + STUN (see `STREAMTEST_NOTES.md`) |

## Run 1 (first successful desk loopback)

### Glass-to-glass (QR)

| Run | n | p50 | p95 | p99 | loss% | Notes |
|---|---|---|---|---|---|---|
| A (cold / ramp) | 50/50 | **3775 ms** | 4357 ms | 4459 ms | 0.0 | miss ticks 21; early sample while encoder still at ~320×180 / low FPS |
| B (warm) | 50/50 | **555 ms** | 770 ms | 847 ms | 0.0 | miss ticks 13; after stream settled |

### getStats snapshot (after run B)

| Role | RTT | Jitter | FPS | kbps | Drop | Res |
|---|---|---|---|---|---|---|
| whip | 326 ms | — | 30 | 1584 | — | **640×360** |
| whep | 333 ms | 4 ms | 22 | 1759 | 36 | **640×360** |

During run A / mid-session snapshots also showed **320×180** at ~7–13 fps before climbing to 30 fps.

### Session timeline (abridged)

- Camera: `1920×1080 @ 30` → canvas `1920×1080`
- WHIP ICE gather timeout 8s → POST OK → connected (~2.4s after POST)
- WHEP ICE gather timeout 8s → POST OK → track + connected
- Run A G2G samples ~3.2–4.5 s; stats still 320×180 / low fps
- Run B G2G samples ~0.42–0.85 s; stats 640×360 @ ~22–30 fps
- Clean WHIP/WHEP DELETE on Stop

## Interpretation

1. **Floor is geography.** WHIP/WHEP ICE RTT ≈ **330 ms** each (same ballpark as HID Self-test Dallas p50 ~285 ms). Loopback glass-to-glass must cross the VPS **twice** (up + down) plus encode/decode/buffer.
2. **Warm glass-to-glass ~555 ms** ≈ ~330 ms network + ~200–250 ms pipeline (canvas re-encode, browser encoder, MediaMTX, decoder, QR sample lag). Plausible.
3. **Cold run ~3.8 s is not steady-state.** Browser/MediaMTX started at **320×180** and low FPS; QR decode still “succeeded” on blurry/late frames → inflated G2G. Prefer sampling after FPS/res stabilize (or discard first N seconds).
4. **Quality gap (run 1):** local canvas is 1080p, but RTP negotiated/adapted to **640×360**. Mitigated in code by WHIP HQ sender params (`maxBitrate` 6 Mbps, `scaleResolutionDownBy: 1`, `maintain-resolution`, `contentHint=detail`, H.264 preferred). Re-check getStats `Res` after redeploy — expect 1280×720 or 1920×1080 when uplink allows.
5. **Stills:** Use **Snap local (1080)** / click local pane for a full-canvas JPEG (true 1920×1080 quality, not ABR). **Snap received** captures WHEP decoded pixels (may still be soft until HQ bitrate sticks).
6. **ICE gather timeout** still may fire; gather wait shortened to ~2.5s. Connection usually still succeeds.

## Bottlenecks (ordered)

| # | Bottleneck | Evidence | Impact |
|---|---|---|---|
| 1 | **Dallas VPS hairpin** | RTT ~326–333 ms | Dominates warm G2G; India/closer VPS cuts this hardest |
| 2 | **Double hop** (publish + play) | Two PCs to same MTX | G2G ≥ ~1× RTT + encode; Pi→operator is one play hop only |
| 3 | **No encoder constraints** | Res drops to 320→640 | Browser ABR underestimates; looks soft, early samples bad |
| 4 | **Canvas `captureStream` re-encode** | Camera already 1080p → canvas → WHIP | Extra CPU + encoder delay vs raw track (+ overlay another way) |
| 5 | **QR / sample cadence** | QR ~10 Hz, sample 200 ms | Adds up to ~100–200 ms measurement jitter (not true media delay) |
| 6 | **ICE gather 8s wait** | Log every start | Slow Start loopback UX; not steady G2G |

## How to improve

### Latency (biggest wins first)

1. **Closer MediaMTX** (or second region) — target ICE RTT well under 100 ms if operators are in India.
2. **Warm-up before sample** — auto-wait until inbound FPS ≥ 25 and width ≥ 1280 (or fixed 5–10 s) before Gate latency run.
3. **Force publish encoding** on WHIP sender after `addTrack`:
   - `scaleResolutionDownBy: 1`
   - `maxFramerate: 30`
   - `maxBitrate` ~2.5–6 Mbps for 1080p
   - Prefer codec H.264 if available (Pi path later); for desk test VP8/VP9/AV1 is fine if bitrate is high enough
4. **Shorter ICE wait** (e.g. 1–2 s or resolve on first usable candidate) — faster start only.
5. **Faster QR stamp** (every frame or 30 Hz) + sample interval 100 ms — tighter G2G measurement, small real gain.

### Quality (toward real 1080)

1. Same **bitrate / resolution** sender params as above; confirm getStats `frameWidth`/`frameHeight` stay **1920×1080**.
2. Optional: publish **camera track** with a WebGL/canvas *data-channel or alternate overlay* only for latency runs — avoids full-frame canvas rescale (more work).
3. MediaMTX: ensure no accidental downscale; keep `webrtc` path passthrough (already no transcode). Check VPS CPU when forcing 1080p30.
4. Operator uplink: ~1080p30 needs sustained ~3–8 Mbps up; soft Wi‑Fi will keep ABR at 360p.

### Measurement hygiene

- Log **res + fps at sample start** in Copy JSON (not only end snapshot).
- Mark run A–style cold samples as `warmup=true` or exclude from “official” p50.
- Compare G2G p50 to `2 × one-way` ≈ ICE RTT as a sanity band (warm should sit modestly above RTT, not 10×).

## Target bands (desk, Dallas)

| Metric | Current warm | Stretch (same VPS) | Stretch (closer VPS) |
|---|---|---|---|
| ICE RTT | ~330 ms | ~330 ms (path) | ~40–120 ms |
| G2G p50 | ~555 ms | ~400–500 ms (encode tune) | ~150–300 ms |
| Publish res | 640×360 | 1280×720 → 1920×1080 | same |

## Related

- Gate 7: `docs/DESK_TESTS.md`
- CSP issue: `docs/STREAMTEST_NOTES.md`
- HID Self-test Dallas: `docs/SELFTEST_LOG.md`
