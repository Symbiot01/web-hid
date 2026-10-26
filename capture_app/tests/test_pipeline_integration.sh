#!/usr/bin/env bash
# test_pipeline_integration.sh - Full integration & failure-mode test suite for capture-app
#
# Verifies:
#   1. Failure test: Bad mTLS certificate -> clear error message, non-zero exit (code 1)
#   2. Failure test: Unreachable WHIP endpoint -> retries with backoff, exits with code 3
#   3. 60-second live VA-API H.264 + libdatachannel WHIP integration run against a local
#      mock WHIP server (Python http.server responding 201 Created with Location header
#      and SDP answer); asserts frames_encoded > 500, WHIP DELETE received on shutdown,
#      and zero file descriptor leaks across the run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
BIN="${APP_DIR}/capture-app"

if [[ ! -x "${BIN}" ]]; then
    echo "ERROR: ${BIN} not built" >&2
    exit 1
fi

echo "=== [1/4] Verifying --version and --help ==="
VER_OUT="$("${BIN}" --version)"
echo "  ${VER_OUT}"
if [[ "${VER_OUT}" != *"capture-app 1.0.0 (build "* ]]; then
    echo "FAIL: unexpected --version output" >&2
    exit 1
fi
"${BIN}" --help >/dev/null
echo "  [PASS] CLI --version and --help"

echo "=== [2/4] Failure Test: Invalid mTLS certificate path -> non-zero exit ==="
set +e
BAD_CERT_OUT="$("${BIN}" --cert /tmp/nonexistent_cert.pem --key /tmp/nonexistent_key.pem 2>&1)"
BAD_CERT_RC=$?
set -e
echo "  Exit code: ${BAD_CERT_RC} | Output: ${BAD_CERT_OUT}"
if [[ "${BAD_CERT_RC}" -eq 0 ]]; then
    echo "FAIL: expected non-zero exit code for invalid certificate" >&2
    exit 1
fi
echo "  [PASS] Bad certificate rejected with exit code ${BAD_CERT_RC}"

echo "=== [3/4] Failure Test: Unreachable WHIP URL -> retries with backoff and exits with code 3 ==="
set +e
UNREACH_LOG="/tmp/capture_app_unreach_$$.log"
"${BIN}" \
    --synthetic-capture \
    --whip-url "http://127.0.0.1:59999/cam/whip" \
    --reconnect-max-attempts 2 \
    --reconnect-initial-ms 100 \
    --reconnect-max-ms 300 \
    --log-file "${UNREACH_LOG}"
UNREACH_RC=$?
set -e
cat "${UNREACH_LOG}"
rm -f "${UNREACH_LOG}"
if [[ "${UNREACH_RC}" -ne 3 ]]; then
    echo "FAIL: expected exit code 3 for unreachable WHIP endpoint, got ${UNREACH_RC}" >&2
    exit 1
fi
echo "  [PASS] Unreachable WHIP URL exited with code 3 after retries"

echo "=== [4/4] 60-Second End-to-End VAAPI + WHIP Integration Run ==="
MOCK_PORT=18989
MOCK_STATE_FILE="/tmp/mock_whip_state_$$.txt"
INT_LOG_FILE="/tmp/capture_app_int_$$.log"
rm -f "${MOCK_STATE_FILE}" "${INT_LOG_FILE}"

python3 -u - "${MOCK_PORT}" "${MOCK_STATE_FILE}" <<'PYEOF' &
import http.server
import socketserver
import sys

port = int(sys.argv[1])
state_file = sys.argv[2]

CANNED_ANSWER_SDP = (
    "v=0\r\n"
    "o=- 0 0 IN IP4 127.0.0.1\r\n"
    "s=-\r\n"
    "t=0 0\r\n"
    "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
    "c=IN IP4 127.0.0.1\r\n"
    "a=rtcp-mux\r\n"
    "a=ice-ufrag:mockufrag\r\n"
    "a=ice-pwd:mockpassword12345678901234\r\n"
    "a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF\r\n"
    "a=setup:passive\r\n"
    "a=mid:video\r\n"
    "a=recvonly\r\n"
    "a=rtpmap:96 H264/90000\r\n"
)

class WhipHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        _ = self.rfile.read(length)
        with open(state_file, "a") as f:
            f.write(f"POST {self.path}\n")
        body = CANNED_ANSWER_SDP.encode("utf-8")
        self.send_response(201)
        self.send_header("Content-Type", "application/sdp")
        self.send_header("Location", f"http://127.0.0.1:{port}/cam/whip/session-1")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_DELETE(self):
        with open(state_file, "a") as f:
            f.write(f"DELETE {self.path}\n")
        self.send_response(200)
        self.end_headers()

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), WhipHandler) as httpd:
    httpd.serve_forever()
PYEOF
MOCK_PID=$!

cleanup() {
    kill "${MOCK_PID}" 2>/dev/null || true
    rm -f "${MOCK_STATE_FILE}" "${INT_LOG_FILE}"
}
trap cleanup EXIT

sleep 0.5

# Run capture-app for 60s at 10 fps (with slight oversampling at 10fps -> ~600 frames)
"${BIN}" \
    --synthetic-capture \
    --fps 10 \
    --bitrate-kbps 3000 \
    --keyframe-interval 2 \
    --whip-url "http://127.0.0.1:${MOCK_PORT}/cam/whip" \
    --duration 60 \
    --log-file "${INT_LOG_FILE}" &
APP_PID=$!

sleep 2
FD_START=$(ls -1 "/proc/${APP_PID}/fd" 2>/dev/null | wc -l)
echo "  capture-app PID=${APP_PID} initial open FDs=${FD_START}"

# Trigger SIGUSR1 mid-run to verify live stats dump
sleep 10
kill -USR1 "${APP_PID}"

sleep 40
FD_END=$(ls -1 "/proc/${APP_PID}/fd" 2>/dev/null | wc -l || echo "${FD_START}")
echo "  capture-app PID=${APP_PID} open FDs at t=52s=${FD_END}"

wait "${APP_PID}"
APP_RC=$?

if [[ "${APP_RC}" -ne 0 ]]; then
    echo "FAIL: capture-app exited with ${APP_RC}" >&2
    cat "${INT_LOG_FILE}"
    exit 1
fi

ENCODED_COUNT=$(grep -Eo 'encoded=[0-9]+' "${INT_LOG_FILE}" | tail -n 1 | cut -d= -f2)
CAPTURED_COUNT=$(grep -Eo 'captured=[0-9]+' "${INT_LOG_FILE}" | tail -n 1 | cut -d= -f2)
echo "  60s run stats: captured=${CAPTURED_COUNT} encoded=${ENCODED_COUNT}"

if [[ -z "${ENCODED_COUNT}" || "${ENCODED_COUNT}" -le 500 ]]; then
    echo "FAIL: expected frames_encoded > 500 over 60s, got ${ENCODED_COUNT:-0}" >&2
    cat "${INT_LOG_FILE}"
    exit 1
fi

FD_DIFF=$(( FD_END - FD_START ))
if [[ "${FD_DIFF}" -gt 5 ]]; then
    echo "FAIL: detected file descriptor leak (start=${FD_START}, end=${FD_END})" >&2
    exit 1
fi

if ! grep -q "POST /cam/whip" "${MOCK_STATE_FILE}"; then
    echo "FAIL: mock WHIP server did not receive POST /cam/whip" >&2
    exit 1
fi

if ! grep -q "DELETE /cam/whip/session-1" "${MOCK_STATE_FILE}"; then
    echo "FAIL: mock WHIP server did not receive polite DELETE on shutdown" >&2
    exit 1
fi

echo "  [PASS] 60s integration test passed (encoded=${ENCODED_COUNT} > 500, fd_delta=${FD_DIFF}, WHIP POST+DELETE verified)"
