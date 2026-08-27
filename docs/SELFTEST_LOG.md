# Self-test latency log

Operator Self-test loopback (same PC + ESP32 HID + public relay).
Measured via Operator Console → **Self-test** tab (inject-only; no echo).

## Environment

| Item | Value |
|---|---|
| Date | 2026-08-27 |
| Relay | Public VPS (Dallas, US) |
| Path | Browser → WSS → Dallas → ESP32 (Wi‑Fi) → USB HID → same OS → browser |
| UI | React SPA (`HID/web`) |
| Firmware | `web-hid` keyboard + mouse (op 4) |
| Mouse live rate | Browser `mousemove`, server cap **250 frames/s** |
| Square / nudge | **3 px / 8 ms** (~125 Hz) |

## Run results (Dallas)

Status line noted: `Square smoke done in 2705 ms`

| Metric | n | p50 | p95 | p99 | loss% | Notes |
|---|---|---|---|---|---|---|
| Keyboard down RTT | 100/100 | 285.6 ms | 298.4 ms | 520.2 ms | 0.0 | KeyF; gap 40ms |
| Keyboard up RTT | 100/100 | 286.0 ms | 298.7 ms | 476.6 ms | 0.0 | KeyF |
| Click down RTT | 50/50 | 289.3 ms | 307.8 ms | 960.2 ms | 0.0 | left button on hit pad |
| Click up RTT | 50/50 | 286.3 ms | 303.2 ms | 312.2 ms | 0.0 | left button |
| Burst 100/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1605ms |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1813ms |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1115ms |
| Square smoke | 1/1 | 2710.9 ms | 2710.9 ms | 2710.9 ms | 0.0 | wall-clock; move accuracy qualitative |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1068ms |
| Burst 100/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1504ms |
| Burst 250/s | 100/100 | — | — | — | 0.0 | 100 keydowns in 1731ms |
| Click down RTT | 50/50 | 285.9 ms | 362.1 ms | 942.6 ms | 0.0 | left button on hit pad |
| Click up RTT | 49/50 | 284.4 ms | 295.4 ms | 519.7 ms | 2.0 | left button |
| Square smoke | 1/1 | 2705.2 ms | 2705.2 ms | 2705.2 ms | 0.0 | wall-clock; move accuracy qualitative |

## Interpretation

- **p50 ~285–290 ms** for keys/clicks is dominated by **India ↔ Dallas WAN**, not Node/React overhead.
- **0% loss** on most bursts at 100/s and 250/s → forwarder + firmware keep up.
- **Square ~2.7 s** is scripted pacing (`4 × 240/3 × 8 ms ≈ 2.56 s`), not RTT.
- Occasional **p99 spikes** (500–960 ms) are consistent with Wi‑Fi / OS scheduling jitter.

## Expected if relay were in India (estimate only)

| Setup | Likely key/click p50 |
|---|---|
| Dallas (measured) | ~280–300 ms |
| India VPS (same region as operator + ESP32) | ~40–90 ms |
| India VPS (cross-city domestic) | ~60–120 ms |
| LAN / local Node (no public VPS) | ~15–40 ms |

Re-run Self-test after any region change and append a new dated section below.

## Mouse smoothness notes

- Live feel is limited first by **~290 ms RTT** (delayed relative moves).
- OS pointer acceleration further distorts relative HID deltas.
- Live transfer frequency: up to **250/s** (server gate); Square/nudge fixed at **125 Hz**.

## Append next runs

Copy JSON from Self-test **Copy JSON**, or paste a new table under a new `## Run — YYYY-MM-DD (region)` heading.
