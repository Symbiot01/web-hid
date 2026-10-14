'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WebSocket } = require('ws');

const OP_KEY_DOWN = 1;
const OP_KEY_UP = 2;
const OP_RELEASE_ALL = 3;
const RECONNECT_MS = 4000;

const SHIFT_USAGES = new Set([0xe1, 0xe5]);

/** USB HID usage → unshifted / shifted character. Backspace is "\b". */
const USAGE_CHAR = new Map([
  [0x04, ['a', 'A']],
  [0x05, ['b', 'B']],
  [0x06, ['c', 'C']],
  [0x07, ['d', 'D']],
  [0x08, ['e', 'E']],
  [0x09, ['f', 'F']],
  [0x0a, ['g', 'G']],
  [0x0b, ['h', 'H']],
  [0x0c, ['i', 'I']],
  [0x0d, ['j', 'J']],
  [0x0e, ['k', 'K']],
  [0x0f, ['l', 'L']],
  [0x10, ['m', 'M']],
  [0x11, ['n', 'N']],
  [0x12, ['o', 'O']],
  [0x13, ['p', 'P']],
  [0x14, ['q', 'Q']],
  [0x15, ['r', 'R']],
  [0x16, ['s', 'S']],
  [0x17, ['t', 'T']],
  [0x18, ['u', 'U']],
  [0x19, ['v', 'V']],
  [0x1a, ['w', 'W']],
  [0x1b, ['x', 'X']],
  [0x1c, ['y', 'Y']],
  [0x1d, ['z', 'Z']],
  [0x1e, ['1', '!']],
  [0x1f, ['2', '@']],
  [0x20, ['3', '#']],
  [0x21, ['4', '$']],
  [0x22, ['5', '%']],
  [0x23, ['6', '^']],
  [0x24, ['7', '&']],
  [0x25, ['8', '*']],
  [0x26, ['9', '(']],
  [0x27, ['0', ')']],
  [0x28, ['\n', '\n']],
  [0x2a, ['\b', '\b']],
  [0x2b, ['\t', '\t']],
  [0x2c, [' ', ' ']],
  [0x2d, ['-', '_']],
  [0x2e, ['=', '+']],
  [0x2f, ['[', '{']],
  [0x30, [']', '}']],
  [0x31, ['\\', '|']],
  [0x33, [';', ':']],
  [0x34, ["'", '"']],
  [0x35, ['`', '~']],
  [0x36, [',', '<']],
  [0x37, ['.', '>']],
  [0x38, ['/', '?']],
]);

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const outputFile = path.resolve(__dirname, process.env.OUTPUT_FILE || './hid_test.txt');
const deviceToken = process.env.DEVICE_TOKEN || 'YOUR_DEVICE_TOKEN';
const wsBase = process.env.WS_URL || 'wss://webrelay.sahilpatel.online/ws/device';

let socketUrl;
try {
  socketUrl = new URL(wsBase);
} catch {
  console.error('WS_URL is not a valid WebSocket URL');
  process.exit(1);
}
if (socketUrl.protocol !== 'ws:' && socketUrl.protocol !== 'wss:') {
  console.error('WS_URL must be a ws or wss URL');
  process.exit(1);
}
if (socketUrl.username || socketUrl.password) {
  console.error('WS_URL must not contain credentials');
  process.exit(1);
}
socketUrl.searchParams.set('token', deviceToken);

let buffer = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '';
let shiftDown = false;
let reconnectTimer = null;
/** @type {import('ws').WebSocket | null} */
let socket = null;

function flush() {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, buffer);
}

function applyChar(ch) {
  if (ch === '\b') {
    buffer = buffer.slice(0, -1);
  } else {
    buffer += ch;
  }
  flush();
}

/**
 * @param {Buffer} buf
 */
function applyBinary(buf) {
  if (buf.length < 4 || (buf[1] & 0x01) === 0) return;
  const op = buf[0];
  if (op === OP_RELEASE_ALL && buf.length === 4) {
    shiftDown = false;
    return;
  }
  if ((op !== OP_KEY_DOWN && op !== OP_KEY_UP) || buf.length !== 5) return;
  const usage = buf[4];
  if (SHIFT_USAGES.has(usage)) {
    shiftDown = op === OP_KEY_DOWN;
    return;
  }
  if (op !== OP_KEY_DOWN) return;
  const pair = USAGE_CHAR.get(usage);
  if (!pair) return;
  applyChar(shiftDown ? pair[1] : pair[0]);
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  const ws = new WebSocket(socketUrl);
  socket = ws;
  ws.on('open', () => {
    console.log(`HID simulator connected to ${socketUrl.host}${socketUrl.pathname}`);
    ws.send(JSON.stringify({ type: 'device_ready' }));
  });
  ws.on('message', (data, isBinary) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (isBinary) {
      applyBinary(buf);
      return;
    }
    const text = buf.toString('utf8');
    if (!text || text.includes('\0')) return;
    applyChar(text.length === 1 && text === '\b' ? '\b' : text);
    if (text !== '\b') process.stdout.write(`received ${text.length} chars\n`);
  });
  ws.on('close', () => {
    if (socket === ws) socket = null;
    console.log('HID simulator disconnected, retrying');
    scheduleReconnect();
  });
  ws.on('error', () => {
    // close follows; do not print the URL (it contains the token)
  });
}

flush();
console.log(`Writing HID input to ${outputFile}`);
connect();

function shutdown() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (socket) {
    socket.removeAllListeners('close');
    socket.close();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
