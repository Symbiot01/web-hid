import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

import {
    scanWifiNetworks,
    listSavedHiddenProfiles,
    connectVisible,
    connectHidden,
    activateSavedProfile,
} from './wifi.js';

class ConnectDialog extends ModalDialog.ModalDialog {
    constructor({title, ssidLabel = 'Network name (SSID)', ssid = '', askPassword = true}) {
        super({styleClass: 'prompt-dialog'});
        this._resolve = null;
        this._reject = null;

        const box = new St.BoxLayout({vertical: true, style_class: 'prompt-dialog-content'});
        box.add_child(new St.Label({text: title, style_class: 'prompt-dialog-title'}));

        this._ssidEntry = new St.Entry({can_focus: true, text: ssid});
        box.add_child(new St.Label({text: ssidLabel}));
        box.add_child(this._ssidEntry);

        this._passwordEntry = null;
        if (askPassword) {
            this._passwordEntry = new St.Entry({can_focus: true, password_char: '•', text: ''});
            box.add_child(new St.Label({text: 'Password (leave empty if open)'}));
            box.add_child(this._passwordEntry);
        }

        this.contentLayout.add_child(box);
        this.setButtons([
            {label: 'Cancel', action: () => this._done(null)},
            {label: 'Connect', default: true, action: () => this._submit()},
        ]);
    }

    openAsync() {
        this.open(global.get_current_time());
        return new Promise((resolve, reject) => {
            this._resolve = resolve;
            this._reject = reject;
        });
    }

    _done(value) {
        this.close();
        if (value === null) this._reject?.(new Error('cancelled'));
        else this._resolve?.(value);
    }

    _submit() {
        const ssid = this._ssidEntry.get_text().trim();
        const password = this._passwordEntry?.get_text() ?? '';
        if (!ssid) return;
        this._done({ssid, password});
    }
}

export default class EwrpWifiExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._indicator.add_child(new St.Icon({
            icon_name: 'network-wireless-symbolic',
            style_class: 'system-status-icon',
        }));

        this._menu = this._indicator.menu;
        this._statusItem = new PopupMenu.PopupMenuItem('Loading…');
        this._statusItem.reactive = false;
        this._menu.addMenuItem(this._statusItem);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const refresh = new PopupMenu.PopupMenuItem('↻  Scan networks');
        refresh.connect('activate', () => this._refreshMenu(true));
        this._menu.addMenuItem(refresh);

        const joinHidden = new PopupMenu.PopupMenuItem('Join hidden network…');
        joinHidden.connect('activate', () => this._joinHiddenManual());
        this._menu.addMenuItem(joinHidden);

        this._sectionVisible = new PopupMenu.PopupSubMenuMenuItem('In range (visible / open)');
        this._sectionHiddenAp = new PopupMenu.PopupSubMenuMenuItem('Hidden APs (beacon only)');
        this._sectionSaved = new PopupMenu.PopupSubMenuMenuItem('Saved hidden profiles');

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._menu.addMenuItem(this._sectionVisible);
        this._menu.addMenuItem(this._sectionHiddenAp);
        this._menu.addMenuItem(this._sectionSaved);

        this._menu.connect('open-state-changed', (_m, open) => {
            if (open) this._refreshMenu(false);
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }

    _setStatus(text) {
        this._statusItem.label.text = text;
    }

    _clearSubmenu(section) {
        section.menu.removeAll();
    }

    async _refreshMenu(forceRescan) {
        this._setStatus(forceRescan ? 'Scanning…' : 'Updating…');
        try {
            const [scan, saved] = await Promise.all([
                scanWifiNetworks(),
                listSavedHiddenProfiles(),
            ]);
            this._populateVisible(scan.visible);
            this._populateHiddenBeacons(scan.hiddenBeacons);
            this._populateSaved(saved);
            const n = scan.visible.length + scan.hiddenBeacons.length;
            this._setStatus(`${n} network(s) found · WiFi active`);
        } catch (e) {
            this._setStatus(e.message || 'Scan failed');
        }
    }

    _populateVisible(list) {
        this._clearSubmenu(this._sectionVisible);
        if (!list.length) {
            this._sectionVisible.menu.addMenuItem(new PopupMenu.PopupMenuItem('None found'));
            return;
        }
        for (const ap of list) {
            const tag = ap.inUse ? ' • connected' : '';
            const sec = ap.open ? 'open' : ap.security.split(' ')[0] || 'secured';
            const label = `${ap.ssid}  (${ap.signal}%) · ${sec}${tag}`;
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._connectVisibleAp(ap));
            this._sectionVisible.menu.addMenuItem(item);
        }
    }

    _populateHiddenBeacons(list) {
        this._clearSubmenu(this._sectionHiddenAp);
        if (!list.length) {
            this._sectionHiddenAp.menu.addMenuItem(new PopupMenu.PopupMenuItem('None in this scan'));
            return;
        }
        for (const ap of list) {
            const bssid = ap.bssid ? ap.bssid.slice(-8) : '?';
            const label = `Hidden AP  ${ap.signal}%  · …${bssid}`;
            const item = new PopupMenu.PopupMenuItem(label);
            item.connect('activate', () => this._connectHiddenBeacon(ap));
            this._sectionHiddenAp.menu.addMenuItem(item);
        }
    }

    _populateSaved(list) {
        this._clearSubmenu(this._sectionSaved);
        if (!list.length) {
            this._sectionSaved.menu.addMenuItem(new PopupMenu.PopupMenuItem('None saved'));
            return;
        }
        for (const prof of list) {
            const item = new PopupMenu.PopupMenuItem(`${prof.ssid}  (profile: ${prof.name})`);
            item.connect('activate', () => this._activateProfile(prof.name));
            this._sectionSaved.menu.addMenuItem(item);
        }
    }

    async _connectVisibleAp(ap) {
        try {
            if (ap.security.includes('802.1X')) {
                this._setStatus(`${ap.ssid} uses enterprise login — use system WiFi or a saved profile`);
                return;
            }
            let password = '';
            if (!ap.open) {
                const creds = await this._prompt({
                    title: `Connect to ${ap.ssid}`,
                    ssid: ap.ssid,
                    askPassword: true,
                });
                password = creds.password;
            }
            this._setStatus(`Connecting to ${ap.ssid}…`);
            await connectVisible(ap.ssid, password);
            this._setStatus(`Connected to ${ap.ssid}`);
        } catch (e) {
            if (e.message !== 'cancelled') this._setStatus(e.message || 'Connect failed');
        }
    }

    async _connectHiddenBeacon(ap) {
        try {
            const creds = await this._prompt({
                title: 'Hidden access point — enter SSID',
                ssid: '',
                askPassword: true,
            });
            this._setStatus(`Connecting to hidden ${creds.ssid}…`);
            await connectHidden({
                ssid: creds.ssid,
                password: creds.password,
                bssid: ap.bssid,
            });
            this._setStatus(`Connected to ${creds.ssid}`);
        } catch (e) {
            if (e.message !== 'cancelled') this._setStatus(e.message || 'Connect failed');
        }
    }

    async _joinHiddenManual() {
        try {
            const creds = await this._prompt({
                title: 'Join hidden network',
                ssid: '',
                askPassword: true,
            });
            this._setStatus(`Connecting to ${creds.ssid}…`);
            await connectHidden({
                ssid: creds.ssid,
                password: creds.password,
                bssid: '',
            });
            this._setStatus(`Connected to ${creds.ssid}`);
        } catch (e) {
            if (e.message !== 'cancelled') this._setStatus(e.message || 'Connect failed');
        }
    }

    async _activateProfile(name) {
        try {
            this._setStatus(`Activating ${name}…`);
            await activateSavedProfile(name);
            this._setStatus(`Activated ${name}`);
        } catch (e) {
            this._setStatus(e.message || 'Activation failed');
        }
    }

    _prompt(opts) {
        const dialog = new ConnectDialog(opts);
        Main.pushModal(dialog);
        return dialog.openAsync().finally(() => Main.popModal(dialog));
    }
}
