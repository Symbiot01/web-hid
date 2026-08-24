'use strict';

const { WebSocket } = require('ws');

/**
 * Single-device HID relay state.
 * Browser UI sockets receive status; device socket receives raw keystroke text.
 */
class Relay {
  constructor() {
    /** @type {import('ws').WebSocket|null} */
    this.espClient = null;
    /** @type {Set<import('ws').WebSocket>} */
    this.uiClients = new Set();
  }

  isDeviceConnected() {
    return Boolean(this.espClient && this.espClient.readyState === WebSocket.OPEN);
  }

  /**
   * Register a browser UI socket; sends initial status.
   * @param {import('ws').WebSocket} ws
   */
  addUiClient(ws) {
    this.uiClients.add(ws);
    this.sendUi(ws, { type: 'status', deviceConnected: this.isDeviceConnected() });
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  removeUiClient(ws) {
    this.uiClients.delete(ws);
  }

  /**
   * Attach ESP32 device socket. Replaces any previous device connection.
   * @param {import('ws').WebSocket} ws
   */
  setDevice(ws) {
    if (this.espClient && this.espClient !== ws) {
      try {
        this.espClient.close(1000, 'replaced');
      } catch {
        // ignore
      }
    }
    this.espClient = ws;
    console.log('[device] connected');
    this.broadcastStatus();
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  clearDevice(ws) {
    if (this.espClient === ws) {
      this.espClient = null;
      console.log('[device] disconnected');
      this.broadcastStatus();
    }
  }

  /**
   * Send raw text + newline to the ESP32. Never logs the body.
   * @param {string} text
   * @returns {{ ok: true, chars: number } | { ok: false, message: string }}
   */
  sendToDevice(text) {
    if (typeof text !== 'string') {
      return { ok: false, message: 'Invalid payload' };
    }
    if (!this.isDeviceConnected()) {
      return { ok: false, message: 'Device not connected' };
    }
    const payload = text.endsWith('\n') ? text : `${text}\n`;
    try {
      this.espClient.send(payload);
      const chars = Buffer.byteLength(text, 'utf8');
      console.log(`[relay] sent ${chars} chars`);
      return { ok: true, chars };
    } catch (err) {
      console.error('[relay] send failed:', err.message);
      return { ok: false, message: 'Send failed' };
    }
  }

  /**
   * @param {import('ws').WebSocket} ws
   * @param {object} msg
   */
  sendUi(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  broadcastStatus() {
    const msg = JSON.stringify({
      type: 'status',
      deviceConnected: this.isDeviceConnected(),
    });
    for (const ws of this.uiClients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(msg);
      }
    }
  }
}

module.exports = { Relay };
