'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { isAllowedOrigin, sessionFromCookieHeader } = require('./auth');
const { createLiveGate } = require('./hid');

const MAX_CLIENTS = 4;
const KEY_EVENTS_PER_SEC = 250;

/**
 * @returns {() => boolean}
 */
function rateGate() {
  let windowStart = Date.now();
  let count = 0;
  return function allow() {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= KEY_EVENTS_PER_SEC;
  };
}

/**
 * @param {import('http').IncomingMessage} req
 */
function requestPath(req) {
  try {
    return new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

/**
 * Query token, or Authorization: Bearer. The value is compared, never logged.
 * @param {import('http').IncomingMessage} req
 */
function deviceTokenFrom(req) {
  try {
    const query = new URL(req.url || '/', 'http://localhost').searchParams.get('token');
    if (query) return query;
  } catch {
    // fall through to the bearer header
  }
  const header = req.headers.authorization;
  if (typeof header !== 'string') return '';
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header);
  return match ? match[1] : '';
}

/**
 * @param {import('net').Socket} socket
 * @param {number} status
 * @param {string} reason
 */
function rejectUpgrade(socket, status, reason) {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/**
 * @param {import('http').Server} server
 * @param {{
 *   config: { sessionSecret: string, nodeEnv: string },
 *   hid: ReturnType<typeof import('./hid').createHidControl>,
 * }} opts
 */
function attachHidSocket(server, opts) {
  const { config, hid } = opts;
  const wssHid = new WebSocketServer({ noServer: true, maxPayload: 64 });
  const wssDevice = new WebSocketServer({ noServer: true, maxPayload: 2048 });
  const live = createLiveGate();
  let clients = 0;

  server.on('upgrade', (req, socket, head) => {
    const path = requestPath(req);
    if (path === '/ws/device') {
      if (!hid.configured()) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      if (!hid.authorizeDevice(deviceTokenFrom(req))) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      wssDevice.handleUpgrade(req, socket, head, (ws) => {
        wssDevice.emit('connection', ws, req);
      });
      return;
    }
    if (path === '/ws/hid') {
      if (!isAllowedOrigin(req, config.nodeEnv) || !sessionFromCookieHeader(req.headers.cookie, config.sessionSecret)) {
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }
      if (!hid.configured() || clients >= MAX_CLIENTS) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      wssHid.handleUpgrade(req, socket, head, (ws) => {
        wssHid.emit('connection', ws, req);
      });
      return;
    }
    rejectUpgrade(socket, 404, 'Not Found');
  });

  wssDevice.on('connection', (ws) => {
    hid.setDevice(ws);
    ws.on('message', () => {
      // device_ready and keepalives stay on the device. Never forward or log them.
    });
    const drop = () => hid.clearDevice(ws);
    ws.on('close', drop);
    ws.on('error', drop);
  });

  wssHid.on('connection', (browser) => {
    clients += 1;
    const allow = rateGate();
    let closed = false;
    hid.addUiClient(browser);

    const notify = (message) => {
      if (browser.readyState !== WebSocket.OPEN) return;
      browser.send(JSON.stringify({ type: 'error', message }));
    };

    browser.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        const control = parseLiveControl(text);
        if (!control) return;
        if (control.type === 'leave') {
          if (live.leave(browser)) hid.releaseAll();
          return;
        }
        const claimed = live.claim(browser, control.mode);
        if (!claimed.ok) {
          notify(claimed.error);
          return;
        }
        if (claimed.release) hid.releaseAll();
        return;
      }
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (!allow()) {
        notify('Too many input events');
        return;
      }
      const result = hid.forwardLiveFrame(buf, live.modeFor(browser));
      if (!result.ok && (result.message === 'Device not connected' || result.message === 'Send failed')) {
        notify(result.message);
      }
    });

    const stop = () => {
      if (closed) return;
      closed = true;
      clients = Math.max(0, clients - 1);
      live.leave(browser);
      hid.removeUiClient(browser);
      hid.releaseAll();
    };
    browser.on('close', stop);
    browser.on('error', stop);
  });
}

/**
 * @param {string} text
 */
function parseLiveControl(text) {
  if (text.length > 80) return null;
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const keys = Object.keys(msg);
  if (msg.type === 'leave' && keys.length === 1) return { type: 'leave' };
  if (msg.type === 'live' && keys.length === 2 && (msg.mode === 'typing' || msg.mode === 'all')) {
    return { type: 'live', mode: msg.mode };
  }
  return null;
}

module.exports = { attachHidSocket, parseLiveControl };
