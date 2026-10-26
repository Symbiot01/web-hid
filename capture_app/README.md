# `capture-app` — Portal + PipeWire + VA-API H.264 + WHIP Screen Publisher

`capture-app` is a production C11 screen streaming application for Linux (Wayland and X11). It captures the desktop screen via the XDG Desktop Portal (`libportal`) and PipeWire (`libpipewire-0.3`), encodes frames in hardware to H.264 Annex B using VA-API (`libva` / `libva-drm`), and publishes the live stream over WebRTC WHIP (RFC 9683) using `libdatachannel` to MediaMTX behind Traefik (`https://mediarelay.sahilpatel.online/cam/whip`).

---

## 1. Pipeline Architecture

```
[XDG Desktop Portal (libportal)]
       │  (User consent dialog -> PipeWire fd + node_id)
       ▼
[PipeWire Consumer (pw_capture.c)]
       │  (Negotiates SPA_DATA_DmaBuf first, MemPtr fallback; 10 fps wall-clock pacing)
       ▼
[Bounded SPSC Queue (pipeline.c)]
       │  (Depth=4, drop_policy=oldest|newest|block, dup()s DMA-BUF fd until encode completes)
       ▼
[VA-API H.264 Encoder (vaapi_encoder.c)]
       │  (/dev/dri/renderD128, VAProfileH264Main, ~3000 kbps, 2s GOP, Annex B SPS+PPS+IDR/P)
       ▼
[WHIP Publisher (whip_publisher.c + http.c)]
          (libdatachannel RTCPeerConnection + H264RtpPacketizer, HTTPS POST offer -> 201 Created,
           optional mTLS, exponential backoff reconnect, polite HTTP DELETE on shutdown)
```

---

## 2. Build & Install

### Build
```bash
cd ~/Projects/remote_operator_console/capture_app
make
```

### Run Unit & 60-Second Integration Tests
```bash
make check
```

### Install System-Wide
```bash
sudo make install
```
Installs `/usr/local/bin/capture-app` and copies `config/config.ini.example` to `/etc/capture-app/config.ini` (if not already present).

### Uninstall
```bash
sudo make uninstall
```

---

## 3. Running `capture-app`

```bash
# Check version and build hash
capture-app --version

# List all CLI options and defaults
capture-app --help

# Run with default configuration (/etc/capture-app/config.ini)
capture-app --config /etc/capture-app/config.ini

# Run in the background (detached from terminal — safe to close terminal)
capture-app start --whip-url https://mediarelay.sahilpatel.online/cam/whip

# Check running status and live pipeline stats
capture-app status

# Stop background or foreground stream cleanly (drains pipeline, DELETEs WHIP resource, closes portal)
capture-app stop

# Restart in the background
capture-app restart --whip-url https://mediarelay.sahilpatel.online/cam/whip

# Or run in the foreground with explicit CLI overrides and mTLS client certificates
capture-app \
  --whip-url https://mediarelay.sahilpatel.online/cam/whip \
  --fps 10 \
  --bitrate-kbps 3000 \
  --keyframe-interval 2 \
  --cert /path/to/client.crt \
  --key  /path/to/client.key \
  --ca   /path/to/ca.crt
```

### Runtime Signals
- `SIGINT` / `SIGTERM`: Graceful shutdown in strict order:
  1. Stop new PipeWire captures
  2. Drain bounded queue & flush VA-API encoder
  3. Send HTTP `DELETE` to the WHIP session `Location` URL
  4. Close XDG Portal session (`xdp_session_close`) so the desktop screen-sharing indicator disappears cleanly
  5. Remove PID file and exit `0`
- Second `SIGINT`: Forces immediate exit with exit code `130`.
- `SIGUSR1`: Dumps live pipeline statistics (`captured`, `encoded`, `published`, `dropped`, `reconnects`) to the log.
- `SIGHUP`: Reopens the log file for external log rotation.

---

## 4. Configuration Reference

| Option / INI Key | CLI Flag | Default | Description |
|---|---|---|---|
| `config` | `--config PATH` | `/etc/capture-app/config.ini` | Path to INI configuration file |
| `fps` | `--fps N` | `10` | Target capture and encode framerate (`1`–`120`) |
| `bitrate_kbps` | `--bitrate-kbps N` | `3000` | Target H.264 bitrate in kbps (`100`–`50000`) |
| `keyframe_interval` | `--keyframe-interval N` | `2` | Keyframe (IDR) interval in seconds (`GOP = N * fps`) |
| `monitor` | `--monitor NAME` | `primary` | Target monitor hint |
| `whip_url` | `--whip-url URL` | `https://mediarelay.sahilpatel.online/cam/whip` | WHIP ingest endpoint URL (or `/desk/whip`) |
| `cert` | `--cert PATH` | *(none)* | mTLS client certificate PEM path |
| `key` | `--key PATH` | *(none)* | mTLS client private key PEM path |
| `ca` | `--ca PATH` | *(system)* | Custom CA certificate bundle PEM path |
| `spki_pin_sha256` | `--spki-pin PIN` | *(none)* | Optional server SPKI SHA-256 pin |
| `log_level` | `--log-level LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARN`, or `ERROR` |
| `log_file` | `--log-file PATH` | `stderr` | Log file path (rotates at 10 MB, keeps `.1`..`.3`) |
| `duration` | `--duration N` | `0` | Run duration in seconds (`0` = forever) |
| `reconnect_initial_delay_ms` | `--reconnect-initial-ms N` | `500` | Initial WHIP reconnect delay (ms) |
| `reconnect_max_delay_ms` | `--reconnect-max-ms N` | `30000` | Maximum WHIP reconnect backoff delay (ms) |
| `reconnect_max_attempts` | `--reconnect-max-attempts N` | `0` | Maximum WHIP reconnect attempts (`0` = forever) |
| `pipeline_depth` | *(INI only)* | `4` | Bounded SPSC queue capacity (`1`–`64`) |
| `drop_policy` | *(INI only)* | `oldest` | Queue full policy: `oldest`, `newest`, or `block` |
| `render_node` | `--render-node PATH` | `/dev/dri/renderD128` | VA-API DRM render node (auto-falls back to `renderD129` if `renderD128` is non-VAAPI dGPU) |
| `pid_file` | `--pid-file PATH` | *(none)* | Optional PID file path |

---

## 5. Exit Codes

| Exit Code | Meaning |
|---|---|
| `0` | Clean shutdown / success |
| `1` | General error (CLI/config validation failure, unreadable or invalid mTLS cert) |
| `2` | User denied XDG Desktop Portal screen-sharing consent |
| `3` | Cannot reach WHIP endpoint after `reconnect_max_attempts` retries |
| `4` | Hardware VA-API encoder initialization failure (VA-API unavailable) |
| `5` | Capture failure (unrecoverable PipeWire or Portal disconnect) |
| `130` | Forced immediate exit via second `SIGINT` |

---

## 6. Watching the Live Stream on the Console Viewer

1. Start `capture-app` on your Linux desktop and click **Allow / Share** in the portal prompt.
2. Verify in the logs that all stages are active:
   - `portal: portal session established`
   - `pipewire: PipeWire client connected`
   - `vaapi: VAAPI encoder initialized`
   - `whip: 201 Created received from WHIP endpoint`
   - `whip: connected`
3. Open your deployed Remote Operator Console viewer page in your browser (which plays the stream from MediaMTX via WHEP / HLS on `mediarelay.sahilpatel.online` under `/cam/whep` or the console UI). You will see your desktop streaming live at ~10 fps.

---

## 7. Desktop Keyboard Shortcuts (`capture-start` & `capture-stop`)

Global keyboard shortcuts let you start and stop `capture-app` from anywhere in your desktop session (browser focused, IDE focused, etc.) without opening a terminal.

### Default Bindings
Two separate, non-toggling scripts and bindings are installed so start and stop are unambiguous and hard to press accidentally:

| Action | Default Binding | GNOME Accelerator | Script Invoked | Log File |
|---|---|---|---|---|
| **Start Capture** | `Ctrl+Alt+Shift+F9` | `<Control><Alt><Shift>F9` | `~/.local/bin/capture-start` | `~/.local/state/capture-app/start.log` |
| **Stop Capture** | `Ctrl+Alt+Shift+F10` | `<Control><Alt><Shift>F10` | `~/.local/bin/capture-stop` | `~/.local/state/capture-app/stop.log` |

Each script:
- Serializes concurrent invocations using `flock` (`~/.local/state/capture-app/shortcut.lock`).
- Cleans up stale PID files (`~/.local/state/capture-app/capture-app.pid`) if `pgrep -x capture-app` finds no live process.
- Is strictly idempotent (pressing **Start** while running or **Stop** while stopped is a safe no-op that exits `0`).
- Inherits and exports `XDG_RUNTIME_DIR` and `PIPEWIRE_REMOTE` and sends desktop notifications via `notify-send`.

### Installing the Shortcuts
```bash
cd ~/Projects/remote_operator_console/capture_app
./setup_shortcuts.sh --install
```
Before installing, `setup_shortcuts.sh` detects your desktop environment (GNOME, KDE, Xfce, i3/sway), dumps all existing shortcuts, and verifies there are no collisions. On GNOME it appends `capture-start` and `capture-stop` to `org.gnome.settings-daemon.plugins.media-keys custom-keybindings` without overwriting existing custom shortcuts, then runs an interactive 10-second test loop for both keys.

### Verifying Installed Shortcuts (`--check` and `--test`)
```bash
# Verify scripts, DE shortcut registration, and confirm no collisions exist
./setup_shortcuts.sh --check

# Run the interactive 10-second keypress verification loop at any time
./setup_shortcuts.sh --test
```

### Changing the Key Bindings
Pass `--start-binding` and `--stop-binding` (or set `CAPTURE_START_BINDING` / `CAPTURE_STOP_BINDING`) when running `--install`. Bindings must use 3 modifiers + a key (or 2 modifiers + a non-adjacent function key) and must not use reserved single letters (`C, X, Q, Z, S, V, W, A, D`):
```bash
# Example 1: Super+Ctrl+Alt+K (start) and Super+Ctrl+Alt+J (stop)
./setup_shortcuts.sh --install \
  --start-binding Super+Ctrl+Alt+K \
  --stop-binding  Super+Ctrl+Alt+J

# Example 2: Ctrl+Alt+Shift+numpad+ (start) and Ctrl+Alt+Shift+numpad- (stop)
./setup_shortcuts.sh --install \
  --start-binding Ctrl+Alt+Shift+numpad+ \
  --stop-binding  Ctrl+Alt+Shift+numpad-
```

### Uninstalling the Shortcuts
```bash
./setup_shortcuts.sh --uninstall
```
This removes only the `capture-start` and `capture-stop` entries (matched by name, not array index) and preserves all other custom shortcuts on the system.
