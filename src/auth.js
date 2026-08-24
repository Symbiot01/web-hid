'use strict';

const crypto = require('crypto');
const cookie = require('cookie');
const signature = require('cookie-signature');

const COOKIE_NAME = 'hid_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_PAYLOAD_BYTES = 2048;

/**
 * Load and validate required environment. Exits process on failure.
 * @returns {{
 *   gatePassword: string,
 *   sessionSecret: string,
 *   port: number,
 *   host: string,
 *   nodeEnv: string,
 *   trustProxy: boolean,
 *   allowLegacyDevice: boolean,
 *   deviceToken: string|null,
 * }}
 */
function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const gatePassword = process.env.GATE_PASSWORD || '';
  const sessionSecret = process.env.SESSION_SECRET || '';
  const allowLegacyDevice = process.env.ALLOW_LEGACY_DEVICE === 'true';
  const deviceToken = process.env.DEVICE_TOKEN || null;

  if (!gatePassword || Buffer.byteLength(gatePassword, 'utf8') < 16) {
    console.error('[fatal] GATE_PASSWORD must be set and at least 16 characters');
    process.exit(1);
  }
  if (!sessionSecret || Buffer.byteLength(sessionSecret, 'utf8') < 32) {
    console.error('[fatal] SESSION_SECRET must be set and at least 32 characters');
    process.exit(1);
  }

  // Legacy device path is never on by default. Only ALLOW_LEGACY_DEVICE=true enables it.
  if (nodeEnv === 'production' && allowLegacyDevice) {
    console.warn(
      '[warn] ALLOW_LEGACY_DEVICE=true in production: unauthenticated device WS on "/". ' +
        'Do not expose this host publicly until firmware uses DEVICE_TOKEN.'
    );
  }

  if (nodeEnv === 'production' && !allowLegacyDevice && !deviceToken) {
    console.warn(
      '[warn] Production: ALLOW_LEGACY_DEVICE is false and DEVICE_TOKEN is unset. ' +
        'No ESP32 WebSocket path will accept connections.'
    );
  }

  const port = Number.parseInt(process.env.PORT || '8080', 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error('[fatal] PORT must be a valid TCP port');
    process.exit(1);
  }

  return {
    gatePassword,
    sessionSecret,
    port,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv,
    trustProxy: process.env.TRUST_PROXY === '1',
    allowLegacyDevice,
    deviceToken: deviceToken && deviceToken.length > 0 ? deviceToken : null,
  };
}

/**
 * Timing-safe password compare.
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function verifyPassword(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') {
    return false;
  }
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still run a compare against a dummy buffer of equal length to reduce
    // timing difference on length mismatch (best-effort).
    const dummy = Buffer.alloc(a.length);
    crypto.timingSafeEqual(a, dummy);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * Create a signed session cookie value.
 * @param {string} sessionSecret
 * @returns {string} unsigned payload before signing is handled by cookie-signature
 */
function createSessionToken(sessionSecret) {
  const payload = JSON.stringify({
    v: 1,
    exp: Date.now() + SESSION_TTL_MS,
    n: crypto.randomBytes(16).toString('hex'),
  });
  return signature.sign(payload, sessionSecret);
}

/**
 * Validate signed session cookie value.
 * @param {string|undefined} signedValue
 * @param {string} sessionSecret
 * @returns {boolean}
 */
function isValidSession(signedValue, sessionSecret) {
  if (!signedValue || typeof signedValue !== 'string') {
    return false;
  }
  const unsigned = signature.unsign(signedValue, sessionSecret);
  if (unsigned === false) {
    return false;
  }
  try {
    const data = JSON.parse(unsigned);
    if (!data || data.v !== 1 || typeof data.exp !== 'number') {
      return false;
    }
    if (Date.now() > data.exp) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Build Set-Cookie header for a new session.
 * @param {string} signedToken
 * @param {{ nodeEnv: string }} opts
 * @returns {string}
 */
function sessionCookieHeader(signedToken, opts) {
  return cookie.serialize(COOKIE_NAME, signedToken, {
    httpOnly: true,
    sameSite: 'strict',
    secure: opts.nodeEnv === 'production',
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

/**
 * Build Set-Cookie header that clears the session.
 * @param {{ nodeEnv: string }} opts
 * @returns {string}
 */
function clearSessionCookieHeader(opts) {
  return cookie.serialize(COOKIE_NAME, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: opts.nodeEnv === 'production',
    path: '/',
    maxAge: 0,
  });
}

/**
 * Read session cookie from a Cookie header string or Express req.
 * @param {string|undefined} cookieHeader
 * @param {string} sessionSecret
 * @returns {boolean}
 */
function sessionFromCookieHeader(cookieHeader, sessionSecret) {
  if (!cookieHeader) {
    return false;
  }
  const parsed = cookie.parse(cookieHeader);
  return isValidSession(parsed[COOKIE_NAME], sessionSecret);
}

/**
 * Express middleware: require valid session cookie.
 */
function requireSession(sessionSecret) {
  return function requireSessionMiddleware(req, res, next) {
    const header = req.headers.cookie;
    if (!sessionFromCookieHeader(header, sessionSecret)) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ error: 'Unauthorized' });
      }
      return res.redirect('/');
    }
    return next();
  };
}

/**
 * Timing-safe compare for DEVICE_TOKEN (future path).
 * @param {string} provided
 * @param {string} expected
 * @returns {boolean}
 */
function verifyDeviceToken(provided, expected) {
  return verifyPassword(provided, expected);
}

module.exports = {
  COOKIE_NAME,
  MAX_PAYLOAD_BYTES,
  SESSION_TTL_MS,
  loadConfig,
  verifyPassword,
  createSessionToken,
  isValidSession,
  sessionCookieHeader,
  clearSessionCookieHeader,
  sessionFromCookieHeader,
  requireSession,
  verifyDeviceToken,
};
