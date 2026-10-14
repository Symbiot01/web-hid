'use strict';

const crypto = require('node:crypto');
const { WebSocket } = require('ws');

const PASTE_MAX_CHARS = 4000;
/** Firmware accepts WS text frames shorter than 256 bytes. */
const DEVICE_TEXT_MAX = 200;
const DEVICE_SEND_BUFFER_LIMIT = 500;
const FLAG_SEQ = 0x01;
const WPM_MIN = 20;
const WPM_MAX = 300;
const JITTER_MIN = 0;
const JITTER_MAX = 50;

const OP_KEY_DOWN = 1;
const OP_KEY_UP = 2;
const OP_RELEASE_ALL = 3;
const OP_MOUSE = 4;
const ESCAPE_USAGE = 0x29;
const BLOCKED_WITHOUT_ALL = new Set([0xe0, 0xe2, 0xe3, 0xe4, 0xe6, 0xe7, ESCAPE_USAGE]);

/**
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 */
function integerIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * @param {number} usage
 */
function isKeyboardUsage(usage) {
  if (!Number.isInteger(usage)) return false;
  if (usage >= 0xe0 && usage <= 0xe7) return true;
  return usage > 0 && usage < 0xa5;
}

/**
 * @param {number} usage
 * @param {'typing' | 'all' | null} mode
 */
function usageAllowed(usage, mode) {
  if (!isKeyboardUsage(usage)) return false;
  if (mode === 'all') return true;
  return !BLOCKED_WITHOUT_ALL.has(usage);
}

/**
 * Key frames follow the live mode. Mouse is only allowed while live.
 * `null` is the idle socket: typing keys and release-all, no mouse.
 * @param {Buffer} buf
 * @param {'typing' | 'all' | null} [mode]
 */
function validLiveFrame(buf, mode = null) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf.length > 10) return false;
  const op = buf[0];
  if (op === OP_RELEASE_ALL) return buf.length === 4;
  if (op === OP_KEY_DOWN || op === OP_KEY_UP) {
    return buf.length === 5 && usageAllowed(buf[4], mode);
  }
  if (op !== OP_MOUSE || (mode !== 'typing' && mode !== 'all') || buf.length !== 10) return false;
  return buf[4] <= 7;
}

/**
 * One live operator. A second socket keeps the idle key rules.
 */
function createLiveGate() {
  /** @type {unknown} */
  let owner = null;
  /** @type {'typing' | 'all' | null} */
  let mode = null;

  return {
    /**
     * @param {unknown} id
     * @param {unknown} next
     */
    claim(id, next) {
      if (next !== 'typing' && next !== 'all') return { ok: false, error: 'Invalid mode' };
      if (owner && owner !== id) return { ok: false, error: 'Live mode is already in use' };
      const release = owner === id && mode !== next;
      owner = id;
      mode = next;
      return { ok: true, mode, release };
    },
    /**
     * @param {unknown} id
     */
    leave(id) {
      if (owner !== id) return false;
      owner = null;
      mode = null;
      return true;
    },
    /**
     * @param {unknown} id
     * @returns {'typing' | 'all' | null}
     */
    modeFor(id) {
      return owner === id ? mode : null;
    },
  };
}

function releaseAllFrame() {
  const frame = Buffer.alloc(4);
  frame[0] = OP_RELEASE_ALL;
  frame[1] = 0x01;
  return frame;
}

/**
 * @param {unknown} body
 * @returns {{ error: string } | { text: string, mode: 'dump' | 'paced', wpm?: number, jitterPct?: number }}
 */
function validatePaste(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Invalid paste' };
  const input = /** @type {Record<string, unknown>} */ (body);
  const allowed = new Set(['text', 'mode', 'wpm', 'jitterPct']);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return { error: 'Unknown field' };
  }
  const text = input.text;
  if (typeof text !== 'string' || text.length === 0) return { error: 'Empty text' };
  if (text.length > PASTE_MAX_CHARS) return { error: 'Text too long' };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) return { error: 'Text contains control characters' };
  if (input.mode !== 'dump' && input.mode !== 'paced') return { error: 'Invalid mode' };
  if (input.mode === 'dump') return { text, mode: 'dump' };
  if (!integerIn(input.wpm, WPM_MIN, WPM_MAX) || !integerIn(input.jitterPct, JITTER_MIN, JITTER_MAX)) {
    return { error: 'Invalid speed' };
  }
  return { text, mode: 'paced', wpm: input.wpm, jitterPct: input.jitterPct };
}

/**
 * Timing-safe compare. A length mismatch still spends a compare.
 * @param {unknown} provided
 * @param {string} expected
 */
function tokensMatch(provided, expected) {
  const a = Buffer.from(typeof provided === 'string' ? provided : '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * @param {number} wpm
 * @param {number} jitterPct
 * @param {string} ch
 */
function nextDelayMs(wpm, jitterPct, ch) {
  const charsPerSec = (wpm * 5) / 60;
  const baseMs = 1000 / charsPerSec;
  const scale = 1 + (Math.random() * 2 - 1) * (jitterPct / 100);
  let ms = baseMs * scale;
  if (ch === '\n') ms *= 2;
  else if (ch === '.' || ch === '!' || ch === '?') ms *= 1.5;
  return Math.max(8, Math.round(ms));
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function dumpChunks(text) {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + DEVICE_TEXT_MAX, text.length);
    if (end < text.length) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    if (end <= i) end = i + 1;
    chunks.push(text.slice(i, end));
    i = end;
  }
  return chunks;
}

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @param {{ wake: (() => void) | null, paused: boolean }} gate
 */
function sleep(ms, signal, gate) {
  if (signal.aborted || gate.paused) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      if (gate.wake === finish) gate.wake = null;
      resolve();
    };
    const timer = setTimeout(finish, ms);
    gate.wake = finish;
    signal.addEventListener('abort', finish);
  });
}

/**
 * In-process HID device and paste runner. No HTTP and no second service.
 * @param {{ deviceToken?: string }} [options]
 */
function createHidControl(options = {}) {
  const deviceToken = typeof options.deviceToken === 'string' ? options.deviceToken : '';
  /** @type {import('ws').WebSocket | { readyState: number, bufferedAmount?: number, send: Function, close?: Function } | null} */
  let device = null;
  /** @type {Set<import('ws').WebSocket>} */
  const uiClients = new Set();
  /** @type {AbortController | null} */
  let abort = null;
  let running = false;
  let paused = false;
  const delayGate = { wake: /** @type {(() => void) | null} */ (null), paused: false };
  /** @type {(() => void) | null} */
  let releasePause = null;
  /** @type {Set<(progress: { state: string, sent: number, total: number, mode: string | null }) => void>} */
  const listeners = new Set();
  let progress = { state: 'idle', sent: 0, total: 0, mode: /** @type {string | null} */ (null) };

  function configured() {
    return Buffer.byteLength(deviceToken, 'utf8') >= 16;
  }

  /**
   * @param {unknown} token
   */
  function authorizeDevice(token) {
    if (!configured()) return false;
    return tokensMatch(token, deviceToken);
  }

  function deviceOpen() {
    return Boolean(device && device.readyState === WebSocket.OPEN);
  }

  function status() {
    return { configured: configured(), deviceConnected: deviceOpen() };
  }

  function publish(next) {
    progress = { ...progress, ...next };
    const snapshot = { ...progress };
    for (const listener of listeners) listener(snapshot);
  }

  function broadcastStatus() {
    const message = JSON.stringify({ type: 'status', deviceConnected: deviceOpen() });
    for (const ws of uiClients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(message);
        } catch {
          // the socket is already closing
        }
      }
    }
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  function setDevice(ws) {
    if (device && device !== ws) {
      try {
        device.close(1000, 'replaced');
      } catch {
        // ignore
      }
    }
    device = ws;
    broadcastStatus();
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  function clearDevice(ws) {
    if (device !== ws) return false;
    device = null;
    broadcastStatus();
    return true;
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  function addUiClient(ws) {
    uiClients.add(ws);
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'status', deviceConnected: deviceOpen() }));
      } catch {
        // ignore
      }
    }
  }

  /**
   * @param {import('ws').WebSocket} ws
   */
  function removeUiClient(ws) {
    uiClients.delete(ws);
  }

  /**
   * @param {Buffer} buf
   * @param {'typing' | 'all' | null} [mode]
   * @returns {{ ok: true } | { ok: false, message: string }}
   */
  function forwardLiveFrame(buf, mode = null) {
    if (!Buffer.isBuffer(buf) || buf.length < 4 || (buf[1] & FLAG_SEQ) === 0 || !validLiveFrame(buf, mode)) {
      const blockedKey =
        Buffer.isBuffer(buf) &&
        buf.length === 5 &&
        (buf[0] === OP_KEY_DOWN || buf[0] === OP_KEY_UP) &&
        isKeyboardUsage(buf[4]) &&
        !usageAllowed(buf[4], mode);
      return { ok: false, message: blockedKey ? 'Key not supported' : 'Invalid frame' };
    }
    if (!deviceOpen() || !device) return { ok: false, message: 'Device not connected' };
    if ((device.bufferedAmount || 0) > DEVICE_SEND_BUFFER_LIMIT) return { ok: false, message: 'Device busy' };
    try {
      device.send(buf);
      return { ok: true };
    } catch {
      return { ok: false, message: 'Send failed' };
    }
  }

  /**
   * @returns {{ ok: true } | { ok: false, message: string }}
   */
  function releaseAll() {
    if (!deviceOpen() || !device) return { ok: false, message: 'Device not connected' };
    try {
      device.send(releaseAllFrame());
      return { ok: true };
    } catch {
      return { ok: false, message: 'Send failed' };
    }
  }

  /**
   * @param {string} text
   * @returns {{ ok: true, chars: number } | { ok: false, message: string }}
   */
  function sendPasteText(text) {
    if (!deviceOpen() || !device) return { ok: false, message: 'Device not connected' };
    try {
      device.send(text);
      return { ok: true, chars: text.length };
    } catch {
      return { ok: false, message: 'Send failed' };
    }
  }

  /**
   * @param {(progress: { state: string, sent: number, total: number, mode: string | null }) => void} listener
   */
  function subscribeProgress(listener) {
    listeners.add(listener);
    listener({ ...progress });
    return () => listeners.delete(listener);
  }

  /**
   * @param {string} text
   */
  async function dump(text) {
    if (running) return { ok: false, message: 'Paste already running' };
    if (!deviceOpen()) return { ok: false, message: 'Device not connected' };
    const parts = dumpChunks(text);
    let sent = 0;
    running = true;
    abort = new AbortController();
    publish({ state: 'running', sent: 0, total: text.length, mode: 'dump' });
    try {
      for (const part of parts) {
        if (abort.signal.aborted) {
          publish({ state: 'cancelled', sent });
          return { ok: false, message: 'Cancelled', sent, total: text.length };
        }
        await waitWhilePaused(abort.signal);
        if (paused) await waitWhilePaused(abort.signal);
        if (abort.signal.aborted) {
          publish({ state: 'cancelled', sent });
          return { ok: false, message: 'Cancelled', sent, total: text.length };
        }
        const result = sendPasteText(part);
        if (!result.ok) {
          publish({ state: 'error', sent });
          return { ...result, sent, total: text.length };
        }
        sent += result.chars;
        publish({ sent });
        await new Promise((resolve) => setImmediate(resolve));
      }
      publish({ state: 'complete', sent });
      return { ok: true, chars: sent, mode: 'dump' };
    } finally {
      finishRun();
    }
  }

  /**
   * @param {AbortSignal} signal
   */
  function waitWhilePaused(signal) {
    if (!paused || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', finish);
        if (releasePause === finish) releasePause = null;
        resolve();
      };
      releasePause = finish;
      signal.addEventListener('abort', finish);
      if (!paused || signal.aborted) finish();
    });
  }

  function finishRun() {
    running = false;
    paused = false;
    delayGate.paused = false;
    abort = null;
    releasePause = null;
    delayGate.wake = null;
  }

  /**
   * @param {{ text: string, wpm: number, jitterPct: number }} opts
   */
  async function paced(opts) {
    const { text, wpm, jitterPct } = opts;
    if (running) return { ok: false, message: 'Paste already running' };
    if (!deviceOpen()) return { ok: false, message: 'Device not connected' };
    running = true;
    abort = new AbortController();
    const { signal } = abort;
    let sent = 0;
    publish({ state: 'running', sent: 0, total: text.length, mode: 'paced' });
    try {
      for (let i = 0; i < text.length; i += 1) {
        if (signal.aborted) {
          publish({ state: 'cancelled', sent });
          return { ok: false, message: 'Cancelled', sent, total: text.length };
        }
        await waitWhilePaused(signal);
        if (paused) await waitWhilePaused(signal);
        if (signal.aborted) {
          publish({ state: 'cancelled', sent });
          return { ok: false, message: 'Cancelled', sent, total: text.length };
        }
        if (!deviceOpen()) {
          publish({ state: 'error', sent });
          return { ok: false, message: 'Device not connected', sent, total: text.length };
        }
        let unit = text[i];
        const code = unit.charCodeAt(0);
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = text[i + 1];
          if (next && next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff) {
            unit += next;
            i += 1;
          }
        }
        const result = sendPasteText(unit);
        if (!result.ok) {
          publish({ state: 'error', sent });
          return { ...result, sent, total: text.length };
        }
        sent += 1;
        publish({ sent });
        if (i < text.length - 1) await sleep(nextDelayMs(wpm, jitterPct, unit[0]), signal, delayGate);
      }
      publish({ state: 'complete', sent });
      return { ok: true, chars: sent, mode: 'paced', wpm, jitterPct };
    } finally {
      finishRun();
    }
  }

  /**
   * @param {{ text: string, mode: 'dump' | 'paced', wpm?: number, jitterPct?: number }} pasteBody
   */
  async function paste(pasteBody) {
    if (!configured()) return { status: 503, body: { error: 'HID is not configured' } };
    const result = pasteBody.mode === 'dump' ? await dump(pasteBody.text) : await paced(pasteBody);
    if (!result.ok) {
      /** @type {Record<string, unknown>} */
      const body = { error: String(result.message || 'Paste failed').slice(0, 200) };
      if (typeof result.sent === 'number') body.sent = result.sent;
      if (typeof result.total === 'number') body.total = result.total;
      return { status: 409, body };
    }
    /** @type {Record<string, unknown>} */
    const body = { ok: true, mode: result.mode, chars: result.chars };
    if (result.mode === 'paced') {
      body.wpm = result.wpm;
      body.jitterPct = result.jitterPct;
    }
    return { status: 200, body };
  }

  function pause() {
    if (!running || !abort || abort.signal.aborted) return { ok: false, error: 'Nothing to pause' };
    if (paused) return { ok: true };
    paused = true;
    delayGate.paused = true;
    releaseAll();
    const wake = delayGate.wake;
    delayGate.wake = null;
    if (wake) wake();
    publish({ state: 'paused' });
    return { ok: true };
  }

  function resume() {
    if (!running || !paused || !abort || abort.signal.aborted) return { ok: false, error: 'Nothing to resume' };
    paused = false;
    delayGate.paused = false;
    const wake = releasePause;
    releasePause = null;
    if (wake) wake();
    publish({ state: 'running' });
    return { ok: true };
  }

  function cancel() {
    paused = false;
    delayGate.paused = false;
    const wakeDelay = delayGate.wake;
    delayGate.wake = null;
    if (wakeDelay) wakeDelay();
    const wakeHold = releasePause;
    releasePause = null;
    if (wakeHold) wakeHold();
    if (abort) {
      abort.abort();
      publish({ state: 'cancelled' });
    }
    releaseAll();
    return true;
  }

  return {
    configured,
    authorizeDevice,
    status,
    setDevice,
    clearDevice,
    addUiClient,
    removeUiClient,
    forwardLiveFrame,
    releaseAll,
    paste,
    pause,
    resume,
    cancel,
    subscribeProgress,
  };
}

module.exports = {
  PASTE_MAX_CHARS,
  WPM_MIN,
  WPM_MAX,
  JITTER_MIN,
  JITTER_MAX,
  validatePaste,
  validLiveFrame,
  createLiveGate,
  releaseAllFrame,
  createHidControl,
};
