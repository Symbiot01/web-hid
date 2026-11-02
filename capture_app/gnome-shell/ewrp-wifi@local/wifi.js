import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

function runNmcli(argv) {
    const proc = Gio.Subprocess.new(
        argv,
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE,
    );
    return new Promise((resolve, reject) => {
        proc.wait_async(null, (p, res) => {
            try {
                p.wait_finish(res);
            } catch (e) {
                reject(e);
                return;
            }
            const [, stdout] = p.communicate_utf8(null, null);
            resolve({code: p.get_exit_status(), stdout: stdout ?? ''});
        });
    });
}

export async function rescanWifi() {
    await runNmcli(['nmcli', 'dev', 'wifi', 'rescan']);
}

function parseMultilineScan(stdout) {
    const visible = [];
    const hiddenBeacons = [];
    let cur = {};
    const flush = () => {
        if (cur.bssid === undefined && cur.ssid === undefined) return;
        const ssid = (cur.ssid ?? '').trim();
        const signal = parseInt(cur.signal, 10) || 0;
        const security = (cur.security ?? '').trim();
        const inUseRaw = (cur.inUse ?? '').trim();
        const inUse = inUseRaw === 'yes' || inUseRaw === '*';
        const bssid = (cur.bssid ?? '').trim();
        const open = security === '' || security === '--';
        const entry = {ssid, signal, security, inUse, bssid, open, hidden: false};
        if (!ssid || ssid === '--') {
            entry.hidden = true;
            entry.ssid = '';
            hiddenBeacons.push(entry);
        } else {
            visible.push(entry);
        }
        cur = {};
    };
    for (const line of stdout.split('\n')) {
        if (!line.trim()) {
            flush();
            continue;
        }
        const idx = line.indexOf(':');
        if (idx <= 0) continue;
        const key = line.slice(0, idx);
        const value = line.slice(idx + 1);
        if (key === 'SSID') {
            if (cur.ssid !== undefined) flush();
            cur.ssid = value;
        } else if (key === 'SIGNAL') {
            cur.signal = value;
        } else if (key === 'SECURITY') {
            cur.security = value;
        } else if (key === 'IN-USE') {
            cur.inUse = value;
        } else if (key === 'BSSID') {
            cur.bssid = value;
            flush();
        }
    }
    flush();
    visible.sort((a, b) => b.signal - a.signal);
    hiddenBeacons.sort((a, b) => b.signal - a.signal);
    return {visible, hiddenBeacons};
}

export async function scanWifiNetworks() {
    await rescanWifi();
    const {code, stdout} = await runNmcli([
        'nmcli', '-t', '-m', 'multiline', '-f', 'SSID,SIGNAL,SECURITY,IN-USE,BSSID',
        'dev', 'wifi', 'list',
    ]);
    if (code !== 0) throw new Error(stdout.trim() || 'WiFi scan failed');
    return parseMultilineScan(stdout);
}

export async function listSavedHiddenProfiles() {
    const {code, stdout} = await runNmcli(
        ['nmcli', '-t', '-f', 'NAME,802-11-wireless.ssid,802-11-wireless.hidden', 'connection', 'show'],
    );
    if (code !== 0) return [];
    const out = [];
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const [name, ssid, hiddenFlag] = line.split(':');
        if (hiddenFlag !== 'yes') continue;
        out.push({name, ssid: ssid || name, hidden: true});
    }
    return out;
}

export async function connectVisible(ssid, password = '') {
    const argv = ['nmcli', '--wait', '45', 'dev', 'wifi', 'connect', ssid];
    if (password) argv.push('password', password);
    const {code, stdout} = await runNmcli(argv);
    if (code !== 0) throw new Error(stdout.trim() || 'Connect failed');
    return stdout.trim();
}

export async function connectHidden({ssid, password = '', bssid = ''}) {
    if (!ssid?.trim()) throw new Error('SSID is required');
    const argv = ['nmcli', '--wait', '45', 'dev', 'wifi', 'connect', ssid, 'hidden', 'yes'];
    if (password) argv.push('password', password);
    if (bssid) argv.push('bssid', bssid);
    const {code, stdout} = await runNmcli(argv);
    if (code !== 0) throw new Error(stdout.trim() || 'Connect failed');
    return stdout.trim();
}

export async function activateSavedProfile(name) {
    const {code, stdout} = await runNmcli(['nmcli', 'connection', 'up', name], 50);
    if (code !== 0) throw new Error(stdout.trim() || 'Activation failed');
    return stdout.trim();
}
