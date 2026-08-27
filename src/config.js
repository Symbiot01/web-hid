'use strict';

require('dotenv').config();

/**
 * Load and validate required environment. Exits process on failure.
 * @returns {{
 *   gatePassword: string,
 *   sessionSecret: string,
 *   deviceToken: string,
 *   port: number,
 *   host: string,
 *   nodeEnv: string,
 *   trustProxy: boolean,
 * }}
 */
function loadConfig() {
  const nodeEnv = process.env.NODE_ENV || 'development';
  const gatePassword = process.env.GATE_PASSWORD || '';
  const sessionSecret = process.env.SESSION_SECRET || '';
  const deviceToken = process.env.DEVICE_TOKEN || '';

  if (!gatePassword || Buffer.byteLength(gatePassword, 'utf8') < 16) {
    console.error('[fatal] GATE_PASSWORD must be set and at least 16 characters');
    process.exit(1);
  }
  if (!sessionSecret || Buffer.byteLength(sessionSecret, 'utf8') < 32) {
    console.error('[fatal] SESSION_SECRET must be set and at least 32 characters');
    process.exit(1);
  }
  if (!deviceToken || Buffer.byteLength(deviceToken, 'utf8') < 16) {
    console.error('[fatal] DEVICE_TOKEN must be set and at least 16 characters');
    process.exit(1);
  }

  const port = Number.parseInt(process.env.PORT || '8080', 10);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error('[fatal] PORT must be a valid TCP port');
    process.exit(1);
  }

  return {
    gatePassword,
    sessionSecret,
    deviceToken,
    port,
    host: process.env.HOST || '0.0.0.0',
    nodeEnv,
    trustProxy: process.env.TRUST_PROXY === '1',
  };
}

module.exports = { loadConfig };
