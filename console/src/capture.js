'use strict';

const { tokensMatch, bearer } = require('./stream');

const AGENT_TTL_MS = 20_000;
const SNAP_MS = 15_000;
const JPEG_MAX = 4 * 1024 * 1024;
const WATCH_MS = 10_000;
const STOP_GRACE_MS = 12_000;
const MAX_WATCHERS = 20;

/**
 * Outbound capture agent. The browser never receives the bearer token.
 * @param {{
 *   token?: string,
 *   bridgeToken?: string,
 *   now?: () => number,
 *   schedule?: typeof setTimeout,
 *   cancel?: typeof clearTimeout,
 *   manual?: boolean,
 * }} [options]
 */
function createCaptureControl(options = {}) {
  const token = typeof options.token === 'string' ? options.token.trim() : '';
  const bridgeToken = typeof options.bridgeToken === 'string' ? options.bridgeToken.trim() : '';
  const validTokens = [token, bridgeToken].filter((t) => t.length >= 16);
  const now = options.now || Date.now;
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  let seenAt = 0;
  /** @type {Map<string, number>} */
  const watchers = new Map();
  let stopTimer = /** @type {NodeJS.Timeout | null} */ (null);
  let videoDesired = false;
  let lastDeliveredVideo = /** @type {boolean | null} */ (null);
  let held = false;
  let agentStreaming = false;
  let agentFps = 0;
  let agentBitrateKbps = 0;
  /** @type {{ res: import('express').Response, timer: NodeJS.Timeout } | null} */
  let poller = null;
  /**
   * @type {{
   *   resolve: (result: { status: number, error?: string, body?: Buffer }) => void,
   *   timer: NodeJS.Timeout,
   *   sent: boolean,
   *   receiving: boolean,
   * } | null}
   */
  let snap = null;

  function configured() {
    return validTokens.length > 0;
  }

  function online() {
    return configured() && seenAt > 0 && now() - seenAt < AGENT_TTL_MS;
  }

  function touch() {
    seenAt = now();
  }

  function authorize(req) {
    const candidate = bearer(req);
    return configured() && validTokens.some((t) => tokensMatch(candidate, t));
  }

  /**
   * @param {{ snap: boolean, video: boolean }} body
   * @param {import('express').Response | null} res
   */
  function reply(res, body) {
    if (!res || res.writableEnded || res.destroyed) return;
    lastDeliveredVideo = body.video;
    res.status(200).json(body);
  }

  function wake() {
    if (!poller) return;
    const current = poller;
    poller = null;
    cancel(current.timer);
    const wanted = Boolean(snap && !snap.sent);
    if (snap && wanted) snap.sent = true;
    reply(current.res, { snap: wanted, video: videoDesired });
  }

  function setVideo(next) {
    if (videoDesired === next) return;
    videoDesired = next;
    wake();
  }

  function liveWatchers() {
    const time = now();
    for (const [id, exp] of watchers) {
      if (exp <= time) watchers.delete(id);
    }
    return watchers.size;
  }

  function sweep() {
    if (liveWatchers() > 0) {
      if (stopTimer) {
        cancel(stopTimer);
        stopTimer = null;
      }
      setVideo(true);
      return;
    }
    if (videoDesired && !stopTimer) {
      stopTimer = schedule(() => {
        stopTimer = null;
        if (liveWatchers() === 0) setVideo(false);
      }, STOP_GRACE_MS);
    }
  }

  if (!options.manual) {
    const timer = setInterval(sweep, 2000);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * @param {import('express').Response} res
   * @param {number} waitMs
   */
  function poll(res, waitMs) {
    if (!configured()) {
      res.status(503).json({ error: 'Capture is not configured' });
      return;
    }
    if (poller) {
      const previous = poller;
      poller = null;
      cancel(previous.timer);
      reply(previous.res, { snap: false, video: videoDesired });
    }
    touch();
    if (snap && !snap.sent) {
      snap.sent = true;
      reply(res, { snap: true, video: videoDesired });
      return;
    }
    if (lastDeliveredVideo !== null && lastDeliveredVideo !== videoDesired) {
      reply(res, { snap: false, video: videoDesired });
      return;
    }
    const timer = schedule(() => {
      if (poller && poller.res === res) poller = null;
      reply(res, { snap: false, video: videoDesired });
    }, waitMs);
    poller = { res, timer };
    res.on('close', () => {
      if (poller && poller.res === res) {
        cancel(timer);
        poller = null;
      }
    });
  }

  function watch(body) {
    if (held) return 'Stream is stopped';
    const input = body && typeof body === 'object' ? /** @type {Record<string, unknown>} */ (body) : {};
    const id = input.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) return 'Invalid watch id';
    if (watchers.size >= MAX_WATCHERS && !watchers.has(id)) return 'Too many viewers';
    watchers.set(id, now() + WATCH_MS);
    if (stopTimer) {
      cancel(stopTimer);
      stopTimer = null;
    }
    setVideo(true);
    return null;
  }

  function release() {
    held = true;
    watchers.clear();
    if (stopTimer) {
      cancel(stopTimer);
      stopTimer = null;
    }
    setVideo(false);
  }

  function suspend() {
    watchers.clear();
    if (stopTimer) {
      cancel(stopTimer);
      stopTimer = null;
    }
    setVideo(false);
  }

  function resume() {
    held = false;
  }

  function applyStatus(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'Invalid status';
    const input = /** @type {Record<string, unknown>} */ (body);
    agentStreaming = input.streaming === true;
    if (typeof input.fps === 'number' && Number.isFinite(input.fps) && input.fps >= 0 && input.fps <= 240) {
      agentFps = Math.trunc(input.fps);
    }
    if (
      typeof input.bitrateKbps === 'number' &&
      Number.isFinite(input.bitrateKbps) &&
      input.bitrateKbps >= 0 &&
      input.bitrateKbps <= 100000
    ) {
      agentBitrateKbps = Math.trunc(input.bitrateKbps);
    }
    touch();
    return null;
  }

  function requestSnap() {
    if (!configured()) return Promise.resolve({ status: 503, error: 'Capture is not configured' });
    if (!online()) return Promise.resolve({ status: 409, error: 'Capture agent is offline' });
    if (snap) return Promise.resolve({ status: 409, error: 'A snapshot is already in progress' });
    return new Promise((resolve) => {
      const timer = schedule(() => {
        if (!snap || snap.resolve !== resolve) return;
        snap = null;
        resolve({ status: 504, error: 'Capture agent did not answer' });
      }, SNAP_MS);
      snap = { resolve, timer, sent: false, receiving: false };
      wake();
    });
  }

  /**
   * @param {Buffer} body
   */
  function acceptJpeg(body) {
    if (!snap || !snap.sent) return { status: 409, error: 'No snapshot is waiting' };
    if (snap.receiving) return { status: 409, error: 'A snapshot is already in progress' };
    if (!Buffer.isBuffer(body) || body.length < 4 || body.length > JPEG_MAX || body[0] !== 0xff || body[1] !== 0xd8) {
      return { status: 400, error: 'Expected a JPEG' };
    }
    snap.receiving = true;
    const current = snap;
    snap = null;
    cancel(current.timer);
    current.resolve({ status: 200, body });
    return { status: 200 };
  }

  function status(desk) {
    const isOnline = online();
    const isStreaming = Boolean(desk) || (isOnline && agentStreaming && videoDesired);
    return {
      configured: configured(),
      agent: isOnline ? 'online' : 'offline',
      video: videoDesired ? 'wanted' : 'off',
      streaming: isStreaming,
      desk: isStreaming,
      watching: liveWatchers() > 0,
      fps: isOnline ? agentFps : 0,
      bitrateKbps: isOnline ? agentBitrateKbps : 0,
    };
  }

  return {
    configured,
    authorize,
    poll,
    watch,
    release,
    suspend,
    resume,
    applyStatus,
    sweep,
    requestSnap,
    acceptJpeg,
    status,
    online,
  };
}

module.exports = { createCaptureControl, JPEG_MAX, AGENT_TTL_MS, WATCH_MS, STOP_GRACE_MS };
