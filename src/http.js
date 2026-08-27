'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const {
  verifyPassword,
  createSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  sessionFromCookieHeader,
  requireSession,
  PASTE_MAX_CHARS,
} = require('./auth');

/**
 * @param {{
 *   config: ReturnType<typeof import('./config').loadConfig>,
 *   forwarder: import('./forward').Forwarder,
 * }} opts
 */
function createApp(opts) {
  const { config, forwarder } = opts;
  const publicDir = path.join(__dirname, 'public');
  const indexHtml = path.join(publicDir, 'index.html');
  const app = express();

  if (config.trustProxy) {
    app.set('trust proxy', 1);
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'"],
          'img-src': ["'self'", 'data:'],
          // Stream-test WHIP/WHEP fetch + STUN for ICE (media plane is separate host).
          'connect-src': ["'self'", config.mediaOrigin, config.stunUrl],
          'media-src': ["'self'", 'blob:', 'mediastream:'],
          'frame-ancestors': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(express.json({ limit: '8kb' }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Invalid password' },
  });

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/api/login', loginLimiter, (req, res) => {
    const password =
      req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!verifyPassword(password, config.gatePassword)) {
      return res.status(401).json({ error: 'Invalid password' });
    }
    const token = createSessionToken(config.sessionSecret);
    res.setHeader(
      'Set-Cookie',
      sessionCookieHeader(token, { nodeEnv: config.nodeEnv })
    );
    return res.status(200).json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    res.setHeader(
      'Set-Cookie',
      clearSessionCookieHeader({ nodeEnv: config.nodeEnv })
    );
    return res.status(200).json({ ok: true });
  });

  app.get('/api/status', requireSession(config.sessionSecret), (_req, res) => {
    res.json({ deviceConnected: forwarder.isDeviceConnected() });
  });

  app.post('/api/paste', requireSession(config.sessionSecret), (req, res) => {
    const text = req.body && typeof req.body.text === 'string' ? req.body.text : '';
    if (!text) {
      return res.status(400).json({ error: 'Empty text' });
    }
    if (text.length > PASTE_MAX_CHARS) {
      return res.status(400).json({ error: 'Text too long' });
    }
    const result = forwarder.sendPasteText(text);
    if (!result.ok) {
      return res.status(409).json({ error: result.message });
    }
    return res.status(200).json({ ok: true, chars: result.chars });
  });

  app.get('/app', requireSession(config.sessionSecret), (_req, res) => {
    res.sendFile(indexHtml);
  });

  app.get('/', (req, res) => {
    if (sessionFromCookieHeader(req.headers.cookie, config.sessionSecret)) {
      return res.redirect('/app');
    }
    return res.sendFile(indexHtml);
  });

  // Vite build assets (hashed JS/CSS under /assets)
  app.use(
    express.static(publicDir, {
      maxAge: '1h',
      index: false,
      fallthrough: true,
    })
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}

module.exports = { createApp };
