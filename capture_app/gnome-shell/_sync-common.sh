# shellcheck shell=bash
# Shared helpers for local GNOME Shell extension install scripts.

_gnome_extension_list_raw() {
    gdbus call --session \
        --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions \
        --method org.gnome.Shell.Extensions.ListExtensions 2>/dev/null || true
}

# True when gnome-shell has scanned this UUID (files on disk alone are not enough).
gnome_extension_registered() {
    local uuid="$1"
    local raw
    raw="$(_gnome_extension_list_raw)"
    [[ -n "${raw}" && "${raw}" == *"'${uuid}':"* ]]
}

gnome_extension_enabled() {
    local uuid="$1"
    if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions list --enabled 2>/dev/null | grep -Fxq "${uuid}" && return 0
    fi
    local info
    info="$(gdbus call --session \
        --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions \
        --method org.gnome.Shell.Extensions.GetExtensionInfo \
        "${uuid}" 2>/dev/null || true)"
    [[ "${info}" == *"'state': <'ENABLED'>"* ]]
}

gnome_extension_try_enable() {
    local uuid="$1"
    if ! gnome_extension_registered "${uuid}"; then
        return 2
    fi
    if gnome_extension_enabled "${uuid}"; then
        return 0
    fi
    if command -v gnome-extensions >/dev/null 2>&1; then
        gnome-extensions enable "${uuid}" 2>/dev/null || true
        gnome_extension_enabled "${uuid}" && return 0
    fi
    gdbus call --session \
        --dest org.gnome.Shell.Extensions \
        --object-path /org/gnome/Shell/Extensions \
        --method org.gnome.Shell.Extensions.EnableExtension \
        "${uuid}" >/dev/null 2>&1 || true
    gnome_extension_enabled "${uuid}"
}

gnome_extension_finish_enable_message() {
    local uuid="$1"
    local rc="$2"
    case "${rc}" in
        0) echo "Extension ${uuid} is enabled." ;;
        2)
            cat <<EOF
Extension files are installed, but GNOME Shell has not loaded "${uuid}" yet.
This is normal on Wayland after adding a new extension folder.

Do this once:
  1. Log out and log back in (or reboot).
  2. Re-run this install script, OR run: gnome-extensions enable ${uuid}

Until you log out/in, "gnome-extensions enable ${uuid}" will say "does not exist".
EOF
            ;;
        *)
            echo "Extension ${uuid} is registered but could not be enabled. Try: gnome-extensions enable ${uuid}"
            ;;
    esac
}
