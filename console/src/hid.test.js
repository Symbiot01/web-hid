'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocket } = require('ws');
const { validatePaste, validLiveFrame, createLiveGate, createHidControl } = require('./hid');
const { attachHidSocket } = require('./hidProxy');
const { createApp } = require('./http');
const { createSessionToken, COOKIE_NAME } = require('./auth');

test('paste validation rejects secrets fields and bad speed', () => {
  assert.equal(validatePaste({ text: 'main', mode: 'paced', wpm: 10, jitterPct: 25 }).error, 'Invalid speed');
  assert.equal(validatePaste({ text: 'main', mode: 'paced', wpm: 80, jitterPct: 25, password: 'nope' }).error, 'Unknown field');
  assert.equal(validatePaste({ text: 'a\u0000b', mode: 'dump' }).error, 'Text contains control characters');
  const ok = validatePaste({ text: 'int main() {\n}\n', mode: 'paced', wpm: 80, jitterPct: 25 });
  assert.equal('error' in ok, false);
  assert.equal(ok.text.includes('main'), true);
});

test('live frames follow the socket mode', () => {
  const keyA = Buffer.from([1, 1, 0, 1, 0x04]);
  const ctrl = Buffer.from([1, 1, 0, 1, 0xe0]);
  const esc = Buffer.from([1, 1, 0, 1, 0x29]);
  const shift = Buffer.from([1, 1, 0, 1, 0xe1]);
  const mouse = Buffer.from([4, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
  const badMouse = Buffer.from([4, 1, 0, 1, 8, 0, 0, 0, 0, 0]);
  assert.equal(validLiveFrame(Buffer.from([3, 1, 0, 1])), true);
  assert.equal(validLiveFrame(keyA), true);
  assert.equal(validLiveFrame(shift, 'typing'), true);
  assert.equal(validLiveFrame(ctrl), false);
  assert.equal(validLiveFrame(ctrl, 'typing'), false);
  assert.equal(validLiveFrame(esc, 'typing'), false);
  assert.equal(validLiveFrame(mouse, 'typing'), true);
  assert.equal(validLiveFrame(mouse), false);
  assert.equal(validLiveFrame(badMouse, 'all'), false);
  assert.equal(validLiveFrame(ctrl, 'all'), true);
  assert.equal(validLiveFrame(esc, 'all'), true);
  assert.equal(validLiveFrame(Buffer.from([1, 1, 0, 1, 0])), false);

  const gate = createLiveGate();
  assert.equal(gate.claim('a', 'typing').ok, true);
  assert.equal(gate.claim('b', 'all').ok, false);
  assert.equal(validLiveFrame(ctrl, gate.modeFor('b')), false);
  assert.equal(validLiveFrame(mouse, gate.modeFor('a')), true);
  assert.equal(gate.claim('a', 'all').release, true);
  assert.equal(validLiveFrame(ctrl, gate.modeFor('a')), true);
  assert.equal(gate.leave('a'), true);
  assert.equal(gate.modeFor('a'), null);
  assert.equal(validLiveFrame(mouse, gate.modeFor('a')), false);
});

test('in-process HID forwards frames, paces paste, and hides the device token', async () => {
  const token = 'device-token-value';
  const hid = createHidControl({ deviceToken: token });
  assert.equal(hid.configured(), true);
  assert.equal(hid.authorizeDevice('wrong-token-value!'), false);
  assert.equal(hid.authorizeDevice(token), true);
  assert.equal(JSON.stringify(hid.status()).includes(token), false);

  const idle = createHidControl({ deviceToken: '' });
  assert.equal(idle.configured(), false);
  assert.equal(idle.authorizeDevice(token), false);
  assert.deepEqual(idle.status(), { configured: false, deviceConnected: false });

  /** @type {Array<Buffer | string>} */
  const sent = [];
  const device = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send(data) {
      sent.push(data);
    },
    close() {},
  };
  /** @type {string[]} */
  const uiMessages = [];
  const ui = {
    readyState: WebSocket.OPEN,
    send(data) {
      uiMessages.push(String(data));
    },
  };
  hid.setDevice(device);
  hid.addUiClient(ui);
  assert.equal(hid.status().deviceConnected, true);
  assert.equal(JSON.parse(uiMessages[0]).deviceConnected, true);
  assert.equal(uiMessages.join('').includes(token), false);

  const frame = Buffer.from([1, 1, 0, 1, 0x04]);
  assert.equal(hid.forwardLiveFrame(frame, 'typing').ok, true);
  assert.equal(sent[0], frame);
  assert.equal(hid.forwardLiveFrame(Buffer.from([1, 1, 0, 1, 0xe0]), null).message, 'Key not supported');
  device.bufferedAmount = 501;
  assert.equal(hid.forwardLiveFrame(frame, 'typing').message, 'Device busy');
  device.bufferedAmount = 0;

  /** @type {Array<{ state: string, sent: number, total: number }>} */
  const progress = [];
  const unsubscribe = hid.subscribeProgress((item) => progress.push(item));
  const dumped = await hid.paste({ text: 'ab', mode: 'dump' });
  assert.equal(dumped.status, 200);
  assert.equal(dumped.body.chars, 2);
  assert.equal(sent.includes('ab'), true);
  assert.equal(JSON.stringify(dumped).includes(token), false);
  assert.equal(progress.some((item) => item.state === 'complete' && item.sent === 2), true);

  const paced = await hid.paste({ text: 'Hi', mode: 'paced', wpm: 300, jitterPct: 0 });
  assert.equal(paced.status, 200);
  assert.equal(paced.body.chars, 2);
  assert.equal(sent.includes('H') && sent.includes('i'), true);

  const pending = hid.paste({ text: 'abcdefghij', mode: 'paced', wpm: 20, jitterPct: 0 });
  hid.cancel();
  const cancelled = await pending;
  assert.equal(cancelled.status, 409);
  assert.equal(cancelled.body.error, 'Cancelled');
  assert.equal(JSON.stringify(cancelled).includes(token), false);
  unsubscribe();

  hid.clearDevice(device);
  assert.equal(hid.status().deviceConnected, false);
  const offline = await hid.paste({ text: 'z', mode: 'dump' });
  assert.equal(offline.status, 409);
  assert.equal(offline.body.error, 'Device not connected');
});

function consoleConfig(deviceToken) {
  return {
    gatePassword: 'g'.repeat(16),
    sessionSecret: 's'.repeat(32),
    nodeEnv: 'development',
    trustProxy: false,
    streamWhepUrl: 'http://127.0.0.1:9/cam/whep',
    streamSrtUrl: 'srt://127.0.0.1:9?streamid=publish:cam',
    streamDeskSrtUrl: 'srt://127.0.0.1:9?streamid=publish:desk',
    captureRtspCam: 'rtsp://127.0.0.1:9/cam',
    bridgeToken: '',
    lookcamPassword: '',
    captureToken: '',
    geminiApiKey: '',
    geminiModel: 'gemini-4-argon',
    deviceToken,
  };
}

/**
 * @param {import('ws').WebSocket} socket
 */
function upgradeStatus(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('upgrade timed out')), 2000);
    socket.on('error', () => {});
    socket.on('unexpected-response', (_req, res) => {
      clearTimeout(timer);
      res.resume();
      resolve(res.statusCode);
    });
    socket.on('open', () => {
      clearTimeout(timer);
      resolve(101);
    });
  });
}

test('device and browser sockets stay on this server and never echo the token', async () => {
  const deviceToken = 'd'.repeat(32);
  const config = consoleConfig(deviceToken);
  const hid = createHidControl({ deviceToken });
  const app = createApp({ config, hid });
  const server = http.createServer(app);
  attachHidSocket(server, { config, hid });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const cookie = `${COOKIE_NAME}=${encodeURIComponent(createSessionToken(config.sessionSecret))}`;
  /** @type {import('ws').WebSocket[]} */
  const sockets = [];
  try {
    const rejected = new WebSocket(`ws://127.0.0.1:${port}/ws/device?token=wrong-token-value`);
    sockets.push(rejected);
    assert.equal(await upgradeStatus(rejected), 401);

    const device = new WebSocket(`ws://127.0.0.1:${port}/ws/device?token=${deviceToken}`);
    sockets.push(device);
    /** @type {Array<Buffer | string>} */
    const fromBrowser = [];
    device.on('message', (data, isBinary) => {
      fromBrowser.push(isBinary ? Buffer.from(data) : data.toString());
    });
    assert.equal(await upgradeStatus(device), 101);

    const statusRes = await fetch(`http://127.0.0.1:${port}/api/hid/status`, { headers: { cookie } });
    const statusBody = await statusRes.json();
    assert.equal(statusRes.status, 200);
    assert.equal(statusBody.configured, true);
    assert.equal(statusBody.deviceConnected, true);
    assert.equal(JSON.stringify(statusBody).includes(deviceToken), false);

    const browser = new WebSocket(`ws://127.0.0.1:${port}/ws/hid`, {
      headers: { Cookie: cookie, Origin: `http://127.0.0.1:${port}` },
    });
    sockets.push(browser);
    /** @type {string[]} */
    const uiMessages = [];
    browser.on('message', (data) => uiMessages.push(data.toString()));
    assert.equal(await upgradeStatus(browser), 101);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(uiMessages.some((item) => item.includes('"deviceConnected":true')), true);
    assert.equal(uiMessages.join('').includes(deviceToken), false);

    browser.send(Buffer.from([1, 1, 0, 1, 0x04]));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('device did not receive the key')), 2000);
      const check = () => {
        if (fromBrowser.length === 0) return;
        clearTimeout(timer);
        device.off('message', check);
        resolve();
      };
      device.on('message', check);
      check();
    });
    assert.equal(Buffer.isBuffer(fromBrowser[0]) && fromBrowser[0][4] === 0x04, true);

    device.send(deviceToken);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(uiMessages.join('').includes(deviceToken), false);

    const progressRes = await fetch(`http://127.0.0.1:${port}/api/hid/paste/progress`, { headers: { cookie } });
    assert.equal(progressRes.status, 200);
    const reader = progressRes.body.getReader();
    const first = await reader.read();
    const progressText = Buffer.from(first.value).toString('utf8');
    assert.match(progressText, /"state":"idle"/);
    assert.equal(progressText.includes(deviceToken), false);
    await reader.cancel();

    const pasteRes = await fetch(`http://127.0.0.1:${port}/api/hid/paste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ text: 'ok', mode: 'dump' }),
    });
    const pasteBody = await pasteRes.json();
    assert.equal(pasteRes.status, 200);
    assert.equal(pasteBody.chars, 2);
    assert.equal(JSON.stringify(pasteBody).includes(deviceToken), false);
    assert.equal(fromBrowser.includes('ok'), true);
  } finally {
    for (const socket of sockets) {
      try {
        socket.terminate();
      } catch {
        // already closed
      }
    }
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
