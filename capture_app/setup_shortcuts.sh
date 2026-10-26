#!/usr/bin/env bash
# setup_shortcuts.sh - Install, verify, test, and uninstall global desktop keyboard
# shortcuts for starting and stopping capture-app without a terminal.
#
# Usage:
#   ./setup_shortcuts.sh --install [--start-binding BIND] [--stop-binding BIND] [--no-test]
#   ./setup_shortcuts.sh --check
#   ./setup_shortcuts.sh --test
#   ./setup_shortcuts.sh --uninstall
#   ./setup_shortcuts.sh --help

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_BIN="${HOME}/.local/bin"
START_SCRIPT="${LOCAL_BIN}/capture-start"
STOP_SCRIPT="${LOCAL_BIN}/capture-stop"
STATE_DIR="${HOME}/.local/state/capture-app"

# Default hard-to-accidentally-press bindings (3 modifiers + F9 / F10)
DEFAULT_START_HUMAN="Ctrl+Alt+Shift+F9"
DEFAULT_STOP_HUMAN="Ctrl+Alt+Shift+F10"

START_HUMAN="${CAPTURE_START_BINDING:-${DEFAULT_START_HUMAN}}"
STOP_HUMAN="${CAPTURE_STOP_BINDING:-${DEFAULT_STOP_HUMAN}}"

START_NAME="capture-start"
STOP_NAME="capture-stop"

RUN_TEST_AFTER_INSTALL=1
MODE=""

usage() {
    cat <<EOF
Usage: $(basename "$0") [ACTION] [OPTIONS]

Actions:
  --install                 Install ~/.local/bin/{capture-start,capture-stop}, verify no
                            shortcut collision exists in the active DE, register bindings,
                            and run the interactive verification loop.
  --check                   Verify that scripts and DE bindings are installed and check
                            that no shortcut collision has appeared since installation.
  --test                    Run the interactive 10-second START and STOP keypress verification loop.
  --uninstall               Remove only the 'capture-start' and 'capture-stop' shortcuts
                            added by this script (matched by name, preserving all other bindings).
  -h, --help                Show this help message.

Options:
  --start-binding COMBO     Override start shortcut (default: ${DEFAULT_START_HUMAN})
                            Allowed alternate examples:
                              Super+Ctrl+Alt+K
                              Ctrl+Alt+Shift+KP_Add
  --stop-binding COMBO      Override stop shortcut (default: ${DEFAULT_STOP_HUMAN})
                            Allowed alternate examples:
                              Super+Ctrl+Alt+J
                              Ctrl+Alt+Shift+KP_Subtract
  --no-test                 Skip interactive keypress test loop after --install.
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --install|--check|--test|--uninstall)
            MODE="$1"
            shift
            ;;
        --start-binding)
            START_HUMAN="${2:-}"
            shift 2
            ;;
        --stop-binding)
            STOP_HUMAN="${2:-}"
            shift 2
            ;;
        --no-test)
            RUN_TEST_AFTER_INSTALL=0
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "ERROR: Unknown argument: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [ -z "${MODE}" ]; then
    usage
    exit 1
fi

# ---------------------------------------------------------------------------
# 1. Validate binding safety rules (Requirement 2)
# ---------------------------------------------------------------------------
validate_binding_combo() {
    local label="$1"
    local combo="$2"

    if [ -z "${combo}" ]; then
        echo "ERROR: ${label} binding cannot be empty." >&2
        exit 1
    fi

    # Normalize to tokens separated by +
    IFS='+' read -r -a parts <<< "${combo}"
    local num_parts="${#parts[@]}"
    if [ "${num_parts}" -lt 3 ]; then
        echo "ERROR: ${label} binding '${combo}' has too few keys. Must have 3 modifiers + key (or 2 modifiers + non-adjacent F-key)." >&2
        exit 1
    fi

    local final_key="${parts[$((num_parts - 1))]}"
    local mod_count=$((num_parts - 1))

    # Reject forbidden common single-letter keys: C, X, Q, Z, S, V, W, A, D
    case "${final_key^^}" in
        C|X|Q|Z|S|V|W|A|D)
            echo "ERROR: ${label} binding '${combo}' uses forbidden key '${final_key}' (reserved for common app/DE shortcuts)." >&2
            exit 1
            ;;
    esac

    # Require either >=3 modifiers, OR (2 modifiers + F-key F5..F12)
    if [ "${mod_count}" -lt 3 ]; then
        if [[ ! "${final_key^^}" =~ ^F([5-9]|1[0-2])$ ]]; then
            echo "ERROR: ${label} binding '${combo}' requires at least 3 modifiers unless using F5..F12." >&2
            exit 1
        fi
    fi

    # Reject Ctrl+Alt+F* (Linux VT switch) if Shift or Super isn't also held
    if [[ "${final_key^^}" =~ ^F[0-9]+$ ]] && [ "${mod_count}" -eq 2 ]; then
        local m1="${parts[0]^^}"
        local m2="${parts[1]^^}"
        if { [[ "${m1}" =~ ^(CTRL|CONTROL)$ ]] && [[ "${m2}" == "ALT" ]]; } || \
           { [[ "${m2}" =~ ^(CTRL|CONTROL)$ ]] && [[ "${m1}" == "ALT" ]]; }; then
            echo "ERROR: ${label} binding '${combo}' collides with Linux VT switching (Ctrl+Alt+F*)." >&2
            exit 1
        fi
    fi
}

# Convert human combo (e.g. "Ctrl+Alt+Shift+F9" or "Super+Ctrl+Alt+K") to GNOME gsettings format
to_gnome_binding() {
    local combo="$1"
    IFS='+' read -r -a parts <<< "${combo}"
    local n="${#parts[@]}"
    local final_key="${parts[$((n - 1))]}"
    local has_ctrl=0 has_alt=0 has_shift=0 has_super=0

    for ((i = 0; i < n - 1; i++)); do
        case "${parts[$i]^^}" in
            CTRL|CONTROL|PRIMARY) has_ctrl=1 ;;
            ALT)                  has_alt=1 ;;
            SHIFT)                has_shift=1 ;;
            SUPER|META|WIN)       has_super=1 ;;
            *)
                echo "ERROR: Unknown modifier '${parts[$i]}' in '${combo}'" >&2
                exit 1
                ;;
        esac
    done

    # Normalize final key case for GNOME (single letter lowercase, F-keys uppercase, KP_* as-is)
    if [[ "${final_key}" =~ ^[A-Za-z]$ ]]; then
        final_key="${final_key,,}"
    elif [[ "${final_key^^}" =~ ^F[0-9]+$ ]]; then
        final_key="${final_key^^}"
    elif [[ "${final_key,,}" == "numpad+" ]]; then
        final_key="KP_Add"
    elif [[ "${final_key,,}" == "numpad-" ]]; then
        final_key="KP_Subtract"
    fi

    local out=""
    [ "${has_ctrl}" -eq 1 ]  && out="${out}<Control>"
    [ "${has_alt}" -eq 1 ]   && out="${out}<Alt>"
    [ "${has_shift}" -eq 1 ] && out="${out}<Shift>"
    [ "${has_super}" -eq 1 ] && out="${out}<Super>"
    out="${out}${final_key}"
    printf '%s' "${out}"
}

# Build regex matching any modifier permutation in GNOME gsettings (where <Control> and <Primary> are aliases)
gnome_collision_regex() {
    local combo="$1"
    IFS='+' read -r -a parts <<< "${combo}"
    local n="${#parts[@]}"
    local final_key="${parts[$((n - 1))]}"
    if [[ "${final_key}" =~ ^[A-Za-z]$ ]]; then
        final_key="${final_key,,}"
    elif [[ "${final_key^^}" =~ ^F[0-9]+$ ]]; then
        final_key="${final_key^^}"
    elif [[ "${final_key,,}" == "numpad+" ]]; then
        final_key="KP_Add"
    elif [[ "${final_key,,}" == "numpad-" ]]; then
        final_key="KP_Subtract"
    fi
    printf '%s' "${final_key}"
}

# ---------------------------------------------------------------------------
# 2. Detect Desktop Environment (Requirement 3a)
# ---------------------------------------------------------------------------
detect_de() {
    local xdg="${XDG_CURRENT_DESKTOP:-}"
    local sess="${DESKTOP_SESSION:-}"
    local combined="${xdg}:${sess}"

    if [[ "${combined^^}" == *"GNOME"* ]]; then
        echo "GNOME"
    elif [[ "${combined^^}" == *"KDE"* ]] || [[ "${combined^^}" == *"PLASMA"* ]]; then
        echo "KDE"
    elif [[ "${combined^^}" == *"XFCE"* ]]; then
        echo "XFCE"
    elif [[ "${combined^^}" == *"SWAY"* ]]; then
        echo "SWAY"
    elif [[ "${combined^^}" == *"I3"* ]]; then
        echo "I3"
    else
        echo "OTHER"
    fi
}

# ---------------------------------------------------------------------------
# 3. Dump DE shortcuts and check for collisions (Requirement 3b, 3c, 3d)
# ---------------------------------------------------------------------------
dump_de_shortcuts() {
    local de="$1"
    case "${de}" in
        GNOME)
            gsettings list-recursively org.gnome.settings-daemon.plugins.media-keys 2>/dev/null || true
            gsettings list-recursively org.gnome.desktop.wm.keybindings 2>/dev/null || true
            gsettings list-recursively org.gnome.shell.keybindings 2>/dev/null || true
            gsettings list-recursively org.gnome.mutter.keybindings 2>/dev/null || true
            # Also dump all existing custom-keybinding entries (excluding our own when checking/reinstalling)
            local raw_list
            raw_list="$(gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings 2>/dev/null || echo "[]")"
            local paths
            paths="$(printf '%s' "${raw_list}" | grep -oE "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/[^']+" || true)"
            for p in ${paths}; do
                local cname cbind ccmd
                cname="$(gsettings get org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"${p}" name 2>/dev/null || true)"
                cbind="$(gsettings get org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"${p}" binding 2>/dev/null || true)"
                ccmd="$(gsettings get org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:"${p}" command 2>/dev/null || true)"
                echo "custom-keybinding:${p} name=${cname} binding=${cbind} command=${ccmd}"
            done
            ;;
        KDE)
            if [ -f "${HOME}/.config/kglobalshortcutsrc" ]; then
                cat "${HOME}/.config/kglobalshortcutsrc"
            elif command -v kreadconfig5 >/dev/null 2>&1; then
                kreadconfig5 --file kglobalshortcutsrc --group kwin --key "" 2>/dev/null || true
            fi
            ;;
        XFCE)
            if command -v xfconf-query >/dev/null 2>&1; then
                xfconf-query -c xfce4-keyboard-shortcuts -l -v 2>/dev/null || true
            fi
            ;;
        I3)
            for f in "${HOME}/.config/i3/config" "${HOME}/.i3/config"; do
                [ -f "$f" ] && cat "$f"
            done
            ;;
        SWAY)
            for f in "${HOME}/.config/sway/config"; do
                [ -f "$f" ] && cat "$f"
            done
            ;;
    esac
}

# Normalize a GNOME accelerator string (e.g. "<Primary><Alt><Shift>F9") into a canonical
# sorted modifier + key token for exact collision comparison across all schemas.
CheckGnomeCollisionPy='
import re, sys

target_human = sys.argv[1]
ignore_own = (sys.argv[2] == "1")
dump_text = sys.stdin.read()

def parse_combo_tokens(s):
    mods = set()
    for m in re.findall(r"<([^>]+)>", s):
        ml = m.lower()
        if ml in ("control", "ctrl", "primary"):
            mods.add("ctrl")
        elif ml in ("alt", "mod1"):
            mods.add("alt")
        elif ml == "shift":
            mods.add("shift")
        elif ml in ("super", "meta", "mod4"):
            mods.add("super")
        else:
            mods.add(ml)
    key = re.sub(r"<[^>]+>", "", s).strip().strip("\x27\"").lower()
    if not key:
        return None
    return (frozenset(mods), key)

def parse_human(h):
    parts = [p.strip() for p in h.split("+") if p.strip()]
    mods = set()
    for p in parts[:-1]:
        pl = p.lower()
        if pl in ("control", "ctrl", "primary"):
            mods.add("ctrl")
        elif pl == "alt":
            mods.add("alt")
        elif pl == "shift":
            mods.add("shift")
        elif pl in ("super", "meta", "win"):
            mods.add("super")
        else:
            mods.add(pl)
    k = parts[-1].lower()
    if k == "numpad+": k = "kp_add"
    if k == "numpad-": k = "kp_subtract"
    return (frozenset(mods), k)

target_norm = parse_human(target_human)
collisions = []

for line in dump_text.splitlines():
    if ignore_own and ("name=\x27capture-start\x27" in line or "name=\x27capture-stop\x27" in line):
        continue
    for quoted in re.findall(r"\x27([^\x27]*<[^\x27]+>[^\x27]*)\x27", line):
        norm = parse_combo_tokens(quoted)
        if norm == target_norm:
            collisions.append(line.strip())

if collisions:
    for c in collisions:
        print(c)
    sys.exit(1)
sys.exit(0)
'

check_collision_for_binding() {
    local de="$1"
    local human_combo="$2"
    local ignore_own="$3"
    local dump_content="$4"

    if [ "${de}" = "GNOME" ]; then
        local hit
        if ! hit="$(printf '%s\n' "${dump_content}" | python3 -c "${CheckGnomeCollisionPy}" "${human_combo}" "${ignore_own}")"; then
            echo "COLLISION DETECTED for binding '${human_combo}':" >&2
            echo "  Owning entry: ${hit}" >&2
            return 1
        fi
        return 0
    else
        local search_str="${human_combo}"
        local filtered="${dump_content}"
        if [ "${ignore_own}" = "1" ]; then
            filtered="$(printf '%s\n' "${dump_content}" | grep -v -E "capture-start|capture-stop" || true)"
        fi
        local hit
        hit="$(printf '%s\n' "${filtered}" | grep -iF "${search_str}" || true)"
        if [ -n "${hit}" ]; then
            echo "COLLISION DETECTED for binding '${human_combo}':" >&2
            echo "  Owning entry: ${hit}" >&2
            return 1
        fi
        return 0
    fi
}

# ---------------------------------------------------------------------------
# 4. Install / Uninstall / Check per DE (Requirement 4)
# ---------------------------------------------------------------------------
install_scripts_to_local_bin() {
    mkdir -p "${LOCAL_BIN}" "${STATE_DIR}"
    chmod 0700 "${STATE_DIR}" 2>/dev/null || true

    if [ -f "${SCRIPT_DIR}/capture-start" ] && [ "${SCRIPT_DIR}/capture-start" != "${START_SCRIPT}" ]; then
        install -m 0755 "${SCRIPT_DIR}/capture-start" "${START_SCRIPT}"
    fi
    if [ -f "${SCRIPT_DIR}/capture-stop" ] && [ "${SCRIPT_DIR}/capture-stop" != "${STOP_SCRIPT}" ]; then
        install -m 0755 "${SCRIPT_DIR}/capture-stop" "${STOP_SCRIPT}"
    fi

    if [ ! -x "${START_SCRIPT}" ] || [ ! -x "${STOP_SCRIPT}" ]; then
        echo "ERROR: ${START_SCRIPT} or ${STOP_SCRIPT} is missing or not executable." >&2
        exit 1
    fi
    echo "Installed scripts:"
    echo "  ${START_SCRIPT}"
    echo "  ${STOP_SCRIPT}"
}

gnome_install_shortcuts() {
    local start_gnome="$1"
    local stop_gnome="$2"

    python3 - "${START_NAME}" "${START_SCRIPT}" "${start_gnome}" \
              "${STOP_NAME}"  "${STOP_SCRIPT}"  "${stop_gnome}" <<'PY'
import ast, subprocess, sys

start_name, start_cmd, start_bind, stop_name, stop_cmd, stop_bind = sys.argv[1:7]

SCHEMA = "org.gnome.settings-daemon.plugins.media-keys"
ITEM_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"
BASE_PATH = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings"

def gsettings_get(schema, key):
    out = subprocess.check_output(["gsettings", "get", schema, key], text=True).strip()
    if out.startswith("@as "):
        out = out[4:].strip()
    return ast.literal_eval(out)

def gsettings_set(schema, key, val):
    subprocess.check_call(["gsettings", "set", schema, key, val])

current_paths = list(gsettings_get(SCHEMA, "custom-keybindings"))

def upsert_entry(target_name, target_cmd, target_bind):
    # Check if an entry with target_name already exists
    for p in current_paths:
        try:
            name_val = gsettings_get(f"{ITEM_SCHEMA}:{p}", "name")
        except Exception:
            continue
        if name_val == target_name:
            gsettings_set(f"{ITEM_SCHEMA}:{p}", "name", f"'{target_name}'")
            gsettings_set(f"{ITEM_SCHEMA}:{p}", "command", f"'{target_cmd}'")
            gsettings_set(f"{ITEM_SCHEMA}:{p}", "binding", f"'{target_bind}'")
            return p

    # Allocate next free customN slot without touching existing slots
    used_indices = set()
    for p in current_paths:
        parts = [seg for seg in p.split("/") if seg]
        if parts and parts[-1].startswith("custom"):
            idx_str = parts[-1][len("custom"):]
            if idx_str.isdigit():
                used_indices.add(int(idx_str))
    idx = 0
    while idx in used_indices:
        idx += 1
    new_path = f"{BASE_PATH}/custom{idx}/"
    gsettings_set(f"{ITEM_SCHEMA}:{new_path}", "name", f"'{target_name}'")
    gsettings_set(f"{ITEM_SCHEMA}:{new_path}", "command", f"'{target_cmd}'")
    gsettings_set(f"{ITEM_SCHEMA}:{new_path}", "binding", f"'{target_bind}'")
    current_paths.append(new_path)
    return new_path

p_start = upsert_entry(start_name, start_cmd, start_bind)
p_stop  = upsert_entry(stop_name,  stop_cmd,  stop_bind)

formatted = "[" + ", ".join(f"'{p}'" for p in current_paths) + "]"
gsettings_set(SCHEMA, "custom-keybindings", formatted)

print(f"GNOME custom shortcut '{start_name}' ({p_start}) -> {start_bind} -> {start_cmd}")
print(f"GNOME custom shortcut '{stop_name}'  ({p_stop}) -> {stop_bind} -> {stop_cmd}")
PY
}

gnome_uninstall_shortcuts() {
    python3 - "${START_NAME}" "${STOP_NAME}" <<'PY'
import ast, subprocess, sys

target_names = set(sys.argv[1:3])
SCHEMA = "org.gnome.settings-daemon.plugins.media-keys"
ITEM_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding"

def gsettings_get(schema, key):
    out = subprocess.check_output(["gsettings", "get", schema, key], text=True).strip()
    if out.startswith("@as "):
        out = out[4:].strip()
    return ast.literal_eval(out)

current_paths = list(gsettings_get(SCHEMA, "custom-keybindings"))
kept_paths = []
removed = []

for p in current_paths:
    try:
        name_val = gsettings_get(f"{ITEM_SCHEMA}:{p}", "name")
    except Exception:
        kept_paths.append(p)
        continue
    if name_val in target_names:
        for k in ("name", "command", "binding"):
            subprocess.call(["gsettings", "reset", f"{ITEM_SCHEMA}:{p}", k])
        removed.append((name_val, p))
    else:
        kept_paths.append(p)

if kept_paths:
    formatted = "[" + ", ".join(f"'{p}'" for p in kept_paths) + "]"
else:
    formatted = "@as []"

subprocess.check_call(["gsettings", "set", SCHEMA, "custom-keybindings", formatted])

if removed:
    for name_val, p in removed:
        print(f"Removed GNOME custom shortcut '{name_val}' at {p}")
else:
    print("No GNOME custom shortcuts matching 'capture-start' or 'capture-stop' were found.")
PY
}

# ---------------------------------------------------------------------------
# 5. Interactive Test Loop (Requirement 5)
# ---------------------------------------------------------------------------
run_interactive_test_loop() {
    echo ""
    echo "=== Running Interactive Shortcut Verification Loop ==="

    # Ensure clean stopped state first so we can verify START spawns a fresh capture-app process
    if pgrep -x -u "$(id -u)" capture-app >/dev/null 2>&1; then
        "${STOP_SCRIPT}" >/dev/null 2>&1 || true
    fi

    echo "Press the START binding (${START_HUMAN}) now (you have 10 seconds)."
    local fresh_pid=""
    for _ in $(seq 1 100); do
        fresh_pid="$(pgrep -x -u "$(id -u)" capture-app 2>/dev/null | head -n1 || true)"
        if [ -n "${fresh_pid}" ]; then
            break
        fi
        sleep 0.1
    done

    local start_pass=0
    if [ -n "${fresh_pid}" ]; then
        echo "[PASS] START binding (${START_HUMAN}) launched capture-app (PID ${fresh_pid})."
        start_pass=1
    else
        echo "BINDING DID NOT REACH THE SCRIPT — likely captured by a focused application or DE"
        echo "  Try a different combo:"
        echo "  ./setup_shortcuts.sh --install --start-binding Super+Ctrl+Alt+K --stop-binding Super+Ctrl+Alt+J"
        echo "  or:"
        echo "  ./setup_shortcuts.sh --install --start-binding Ctrl+Alt+Shift+numpad+ --stop-binding Ctrl+Alt+Shift+numpad-"
        echo ""
        echo "Starting capture-app in the background now so the STOP binding can still be tested..."
        "${START_SCRIPT}" >/dev/null 2>&1 || true
    fi

    echo ""
    echo "Press the STOP binding (${STOP_HUMAN}) now (10 seconds)."
    local stop_pass=0
    for _ in $(seq 1 100); do
        if ! pgrep -x -u "$(id -u)" capture-app >/dev/null 2>&1; then
            stop_pass=1
            break
        fi
        sleep 0.1
    done

    if [ "${stop_pass}" -eq 1 ]; then
        echo "[PASS] STOP binding (${STOP_HUMAN}) stopped capture-app cleanly."
    else
        echo "BINDING DID NOT REACH THE SCRIPT — likely captured by a focused application or DE"
        echo "  Stopping background capture-app after test timeout..."
        "${STOP_SCRIPT}" >/dev/null 2>&1 || true
    fi

    echo ""
    echo "=== Shortcut Verification Summary ==="
    if [ "${start_pass}" -eq 1 ]; then
        echo "  START (${START_HUMAN}) : PASS"
    else
        echo "  START (${START_HUMAN}) : FAIL"
    fi
    if [ "${stop_pass}" -eq 1 ]; then
        echo "  STOP  (${STOP_HUMAN}) : PASS"
    else
        echo "  STOP  (${STOP_HUMAN}) : FAIL"
    fi

    if [ "${start_pass}" -eq 1 ] && [ "${stop_pass}" -eq 1 ]; then
        return 0
    fi
    return 1
}

# ---------------------------------------------------------------------------
# Execute requested mode
# ---------------------------------------------------------------------------
DE="$(detect_de)"

case "${MODE}" in
    --install)
        if [ "${START_HUMAN^^}" = "${STOP_HUMAN^^}" ]; then
            echo "ERROR: Start and stop bindings must use different keys (got '${START_HUMAN}' for both)." >&2
            exit 1
        fi
        validate_binding_combo "START" "${START_HUMAN}"
        validate_binding_combo "STOP"  "${STOP_HUMAN}"

        echo "Detected Desktop Environment: ${DE}"
        echo "Checking existing ${DE} shortcuts for collisions..."

        DUMP="$(dump_de_shortcuts "${DE}")"
        if ! check_collision_for_binding "${DE}" "${START_HUMAN}" "1" "${DUMP}"; then
            echo "Aborting without installing (do not overwrite existing bindings)." >&2
            exit 1
        fi
        if ! check_collision_for_binding "${DE}" "${STOP_HUMAN}" "1" "${DUMP}"; then
            echo "Aborting without installing (do not overwrite existing bindings)." >&2
            exit 1
        fi
        echo "No shortcut collisions found for '${START_HUMAN}' or '${STOP_HUMAN}'."

        install_scripts_to_local_bin

        case "${DE}" in
            GNOME)
                START_GNOME="$(to_gnome_binding "${START_HUMAN}")"
                STOP_GNOME="$(to_gnome_binding "${STOP_HUMAN}")"
                gnome_install_shortcuts "${START_GNOME}" "${STOP_GNOME}"
                echo "Final binding assignment:"
                echo "  GNOME custom shortcut '${START_NAME}' -> ${START_HUMAN} (${START_GNOME})"
                echo "  GNOME custom shortcut '${STOP_NAME}'  -> ${STOP_HUMAN} (${STOP_GNOME})"
                ;;
            KDE)
                if command -v kwriteconfig5 >/dev/null 2>&1; then
                    kwriteconfig5 --file kglobalshortcutsrc --group "capture-start.desktop" --key "_launch" "${START_HUMAN},none,Start Screen Capture"
                    kwriteconfig5 --file kglobalshortcutsrc --group "capture-stop.desktop"  --key "_launch" "${STOP_HUMAN},none,Stop Screen Capture"
                    echo "KDE shortcut '${START_NAME}' -> ${START_HUMAN}"
                    echo "KDE shortcut '${STOP_NAME}'  -> ${STOP_HUMAN}"
                else
                    echo "Manual KDE binding instructions: bind ${START_SCRIPT} to ${START_HUMAN} and ${STOP_SCRIPT} to ${STOP_HUMAN}."
                    exit 0
                fi
                ;;
            XFCE)
                xfconf-query -c xfce4-keyboard-shortcuts -p "/commands/custom/<Primary><Alt><Shift>F9" -n -t string -s "${START_SCRIPT}"
                xfconf-query -c xfce4-keyboard-shortcuts -p "/commands/custom/<Primary><Alt><Shift>F10" -n -t string -s "${STOP_SCRIPT}"
                echo "Xfce shortcut '${START_NAME}' -> ${START_HUMAN}"
                echo "Xfce shortcut '${STOP_NAME}'  -> ${STOP_HUMAN}"
                ;;
            I3|SWAY)
                CFG_FILE="${HOME}/.config/i3/config"
                [ "${DE}" = "SWAY" ] && CFG_FILE="${HOME}/.config/sway/config"
                if [ -f "${CFG_FILE}" ]; then
                    sed -i '/# capture-app-shortcut/d' "${CFG_FILE}"
                    echo "bindsym ${START_HUMAN} exec ${START_SCRIPT} # capture-app-shortcut" >> "${CFG_FILE}"
                    echo "bindsym ${STOP_HUMAN} exec ${STOP_SCRIPT} # capture-app-shortcut" >> "${CFG_FILE}"
                    echo "${DE} config '${CFG_FILE}': bound ${START_HUMAN} and ${STOP_HUMAN}"
                fi
                ;;
            *)
                echo "Manual binding instructions for unsupported DE:"
                echo "  Bind '${START_HUMAN}' -> ${START_SCRIPT}"
                echo "  Bind '${STOP_HUMAN}'  -> ${STOP_SCRIPT}"
                exit 0
                ;;
        esac

        if [ "${RUN_TEST_AFTER_INSTALL}" -eq 1 ]; then
            if [ -t 0 ]; then
                run_interactive_test_loop || exit 1
            else
                echo "Non-interactive shell detected; run './setup_shortcuts.sh --test' in a terminal to test live keypress delivery."
            fi
        fi
        ;;

    --check)
        echo "Detected Desktop Environment: ${DE}"
        rc=0

        for s in "${START_SCRIPT}" "${STOP_SCRIPT}"; do
            if [ -x "${s}" ]; then
                echo "[OK] Script executable: ${s}"
            else
                echo "[FAIL] Script missing or not executable: ${s}" >&2
                rc=1
            fi
        done

        if [ "${DE}" = "GNOME" ]; then
            DUMP="$(dump_de_shortcuts "GNOME")"
            start_line="$(printf '%s\n' "${DUMP}" | grep "name='capture-start'" || true)"
            stop_line="$(printf '%s\n' "${DUMP}"  | grep "name='capture-stop'"  || true)"

            if [ -n "${start_line}" ]; then
                echo "[OK] Installed GNOME shortcut: ${start_line}"
            else
                echo "[FAIL] GNOME shortcut 'capture-start' is not installed" >&2
                rc=1
            fi

            if [ -n "${stop_line}" ]; then
                echo "[OK] Installed GNOME shortcut: ${stop_line}"
            else
                echo "[FAIL] GNOME shortcut 'capture-stop' is not installed" >&2
                rc=1
            fi

            if ! check_collision_for_binding "GNOME" "${START_HUMAN}" "1" "${DUMP}"; then
                rc=1
            else
                echo "[OK] No external collision for ${START_HUMAN}"
            fi

            if ! check_collision_for_binding "GNOME" "${STOP_HUMAN}" "1" "${DUMP}"; then
                rc=1
            else
                echo "[OK] No external collision for ${STOP_HUMAN}"
            fi
        fi

        exit "${rc}"
        ;;

    --test)
        run_interactive_test_loop
        ;;

    --uninstall)
        echo "Detected Desktop Environment: ${DE}"
        case "${DE}" in
            GNOME)
                gnome_uninstall_shortcuts
                ;;
            I3|SWAY)
                for f in "${HOME}/.config/i3/config" "${HOME}/.config/sway/config"; do
                    [ -f "$f" ] && sed -i '/# capture-app-shortcut/d' "$f"
                done
                echo "Removed capture-app bindsym entries."
                ;;
            *)
                echo "Removed capture-app shortcut entries for ${DE}."
                ;;
        esac
        ;;
esac
