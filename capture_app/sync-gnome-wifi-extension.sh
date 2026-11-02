#!/usr/bin/env bash
# sync-gnome-wifi-extension.sh — install/update ewrp-wifi@local (top-bar WiFi picker).
set -euo pipefail

UUID="ewrp-wifi@local"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gnome-shell/_sync-common.sh
source "${SCRIPT_DIR}/gnome-shell/_sync-common.sh"

SRC="${SCRIPT_DIR}/gnome-shell/${UUID}"
DST="${HOME}/.local/share/gnome-shell/extensions/${UUID}"

if [ ! -f "${SRC}/metadata.json" ] || [ ! -f "${SRC}/extension.js" ]; then
    echo "ERROR: missing extension under ${SRC}" >&2
    exit 1
fi

mkdir -p "${DST}"
install -m 0644 "${SRC}/metadata.json" "${DST}/metadata.json"
install -m 0644 "${SRC}/extension.js" "${DST}/extension.js"
install -m 0644 "${SRC}/wifi.js" "${DST}/wifi.js"
echo "Installed ${UUID} -> ${DST}"

set +e
gnome_extension_try_enable "${UUID}"
rc=$?
set -e
gnome_extension_finish_enable_message "${UUID}" "${rc}"
exit "${rc}"
