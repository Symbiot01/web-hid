import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const STATUS_KEYS = ['screenSharing', 'screenRecording'];

export default class HideScreenSharingExtension extends Extension {
    enable() {
        this._handlers = [];
        this._applyHide();
        this._statusWatch = Main.panel.statusArea.connect('notify::children', () => {
            this._applyHide();
        });
    }

    disable() {
        if (this._statusWatch) {
            Main.panel.statusArea.disconnect(this._statusWatch);
            this._statusWatch = 0;
        }
        for (const [obj, id] of this._handlers) {
            obj.disconnect(id);
        }
        this._handlers = [];

        const statusArea = Main.panel.statusArea;
        for (const key of STATUS_KEYS) {
            statusArea[key]?.container?.show();
        }
    }

    _applyHide() {
        const statusArea = Main.panel.statusArea;
        for (const key of STATUS_KEYS) {
            const area = statusArea[key];
            const container = area?.container;
            if (!container) {
                continue;
            }
            container.hide();
            if (!this._handlers.some(([obj]) => obj === container)) {
                const id = container.connect('show', () => container.hide());
                this._handlers.push([container, id]);
            }
        }
    }
}
