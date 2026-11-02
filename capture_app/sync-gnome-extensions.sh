#!/usr/bin/env bash
# sync-gnome-extensions.sh — install all bundled local GNOME Shell extensions.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
failed=0
for script in sync-gnome-hide-indicator.sh sync-gnome-wifi-extension.sh; do
    echo "=== ${script} ==="
    if bash "${SCRIPT_DIR}/${script}"; then
        echo
    else
        rc=$?
        failed=$((failed + 1))
        echo "(exit ${rc})"
        echo
    fi
done
if [ "${failed}" -gt 0 ]; then
    echo "Some extensions need a full session restart (log out/in) before enable will work."
    exit 2
fi
echo "All extensions installed and enabled."
exit 0
