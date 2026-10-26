# Security Architecture (`capture-app`)

## 1. Normal, Unprivileged, Consent-Driven Operation

`capture-app` is a standard, visible Linux desktop application designed around the principle of least privilege:

- **Explicit Portal Consent (`libportal`)**: Screen capture is negotiated exclusively through `org.freedesktop.portal.ScreenCast` via `libportal`. The desktop environment presents the standard system screen-sharing consent dialog to the logged-in user and displays the desktop's active screen-sharing indicator for the duration of the session.If the user clicks **Deny** or cancels the dialog, `capture-app` immediately exits with exit code `2`.
- **Zero Elevated Capabilities**: The binary requires **no** `root` privileges, **no** `CAP_SYS_ADMIN`, and **no** `DRM_MASTER` ownership.
- **Render-Node Hardware Encoding (`/dev/dri/renderD128`)**: Hardware H.264 encoding uses the unprivileged DRM render node (`/dev/dri/renderD128`, with automatic fallback to `/dev/dri/renderD129` on hybrid Intel/NVIDIA systems) rather than privileged `/dev/dri/card*` primary nodes.
- **Full System Visibility**: `capture-app` does not employ any process hiding, socket obfuscation, or anti-monitoring techniques. It appears normally in `ps aux`, `ss -tupn`, `pw-cli list-objects`, and `pw-top`. It is run as a normal user process (`systemctl status capture-app` returns `Unit not found`).

---

## 2. Transport Security & Mutual TLS (mTLS)

All WHIP signaling (`HTTPS POST` of the WebRTC SDP offer and `HTTPS DELETE` of the session resource on shutdown) uses **OpenSSL 3** (via `libcurl` with `CURLOPT_SSL_VERIFYPEER=1L`, `CURLOPT_SSL_VERIFYHOST=2L`, and `CURL_SSLVERSION_TLSv1_2` minimum), while WebRTC media is encrypted end-to-end with **DTLS-SRTP** via `libdatachannel`.

### Enabling Mutual TLS (mTLS)

When connecting to a Traefik / MediaMTX ingress configured for client certificate authentication, provide `client.crt`, `client.key`, and optionally `ca.crt` via CLI flags or `/etc/capture-app/config.ini`:

#### Via CLI:
```bash
capture-app \
  --whip-url https://mediarelay.sahilpatel.online/cam/whip \
  --cert /path/to/client.crt \
  --key  /path/to/client.key \
  --ca   /path/to/ca.crt
```

#### Via `/etc/capture-app/config.ini`:
```ini
[whip]
whip_url = https://mediarelay.sahilpatel.online/cam/whip
cert     = /etc/capture-app/certs/client.crt
key      = /etc/capture-app/certs/client.key
ca       = /etc/capture-app/certs/ca.crt
```

### Certificate Validation Rules
1. **Paired Client Credentials**: Providing `--cert` without `--key` (or vice versa) is rejected at startup before any network traffic is sent.
2. **File Readability & Permissions**: Keep `client.key` readable only by the running user (`chmod 600 client.key`). If any specified certificate or key file is missing, unreadable, or rejected by OpenSSL during the TLS handshake, `capture-app` logs a clear error and exits immediately with a non-zero exit code (`1`) without entering an infinite retry loop.
3. **Optional SPKI Public Key Pinning**: You can additionally pin the server's Subject Public Key Info (SPKI) hash via `spki_pin_sha256 = sha256//<base64>` in `config.ini` or `--spki-pin`.

---

## 3. Compiler & Memory Hardening

The binary is built with strict C11 compiler hardening flags:
- `-std=c11 -Wall -Wextra -Wpedantic -Werror`
- `-fstack-protector-strong`
- `-D_FORTIFY_SOURCE=2 -O2`
- Strict bounds checking on INI parsing, HTTP SDP accumulation buffers, and DMA-BUF descriptor lifetime management.
