'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const url = require('url');

const {
  loadConfig,
  verifyPassword,
  createSessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  sessionFromCookieHeader,
  requireSession,
  verifyDeviceToken,
  MAX_PAYLOAD_BYTES,
} = require('./auth');
const { Relay } = require('./relay');

const config = loadConfig();
const relay = new Relay();
const publicDir = path.join(__dirname, 'public');

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
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
        'form-action': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '4kb' }));

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
  const password = req.body && typeof req.body.password === 'string' ? req.body.password : '';
  if (!verifyPassword(password, config.gatePassword)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = createSessionToken(config.sessionSecret);
  res.setHeader('Set-Cookie', sessionCookieHeader(token, { nodeEnv: config.nodeEnv }));
  return res.status(200).json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', clearSessionCookieHeader({ nodeEnv: config.nodeEnv }));
  return res.status(200).json({ ok: true });
});

app.get('/api/status', requireSession(config.sessionSecret), (_req, res) => {
  res.json({ deviceConnected: relay.isDeviceConnected() });
});

app.get('/app', requireSession(config.sessionSecret), (_req, res) => {
  res.sendFile(path.join(publicDir, 'app.html'));
});

// Static assets (css/js). Do not serve index via static root for "/" —
// we need WebSocket upgrade on "/" for legacy ESP32.
app.use('/css', express.static(path.join(publicDir, 'css'), { maxAge: '1h' }));
app.use('/js', express.static(path.join(publicDir, 'js'), { maxAge: '1h' }));

app.get('/', (req, res) => {
  // If already logged in, send them to the console
  if (sessionFromCookieHeader(req.headers.cookie, config.sessionSecret)) {
    return res.redirect('/app');
  }
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

const server = http.createServer(app);

const wssUi = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
const wssDevice = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
const wssLegacy = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

/**
 * Origin check for browser WebSocket upgrades.
 * Allows missing Origin (some proxies) only in development.
 * @param {import('http').IncomingMessage} req
 * @returns {boolean}
 */
function isAllowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) {
    return config.nodeEnv !== 'production';
  }
  try {
    const o = new URL(origin);
    const hostHeader = req.headers.host;
    if (!hostHeader) {
      return false;
    }
    // Compare host:port from Origin to Host header
    return o.host === hostHeader;
  } catch {
    return false;
  }
}

server.on('upgrade', (req, socket, head) => {
  const pathname = url.parse(req.url || '').pathname || '/';

  if (pathname === '/ws/ui') {
    if (!isAllowedOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!sessionFromCookieHeader(req.headers.cookie, config.sessionSecret)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssUi.handleUpgrade(req, socket, head, (ws) => {
      wssUi.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/ws/device') {
    // Future authenticated device path
    if (!config.deviceToken) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
    const parsed = url.parse(req.url || '', true);
    const token = typeof parsed.query.token === 'string' ? parsed.query.token : '';
    if (!verifyDeviceToken(token, config.deviceToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wssDevice.handleUpgrade(req, socket, head, (ws) => {
      wssDevice.emit('connection', ws, req);
    });
    return;
  }

  if (pathname === '/' || pathname === '') {
    if (!config.allowLegacyDevice) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    wssLegacy.handleUpgrade(req, socket, head, (ws) => {
      wssLegacy.emit('connection', ws, req);
    });
    return;
  }

  socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
  socket.destroy();
});

function attachDeviceHandlers(ws) {
  relay.setDevice(ws);

  ws.on('message', (data) => {
    // Device may send device_ready JSON; never log payload body, never forward to UI.
    const raw = typeof data === 'string' ? data : data.toString('utf8');
    if (raw.length > MAX_PAYLOAD_BYTES) {
      return;
    }
    // Identify / keep session; already set on connection. Ignore content.
  });

  ws.on('close', () => {
    relay.clearDevice(ws);
  });

  ws.on('error', () => {
    relay.clearDevice(ws);
  });
}

wssLegacy.on('connection', (ws) => {
  attachDeviceHandlers(ws);
});

wssDevice.on('connection', (ws) => {
  attachDeviceHandlers(ws);
});

wssUi.on('connection', (ws) => {
  relay.addUiClient(ws);

  ws.on('message', (data) => {
    let text;
    if (Buffer.isBuffer(data)) {
      if (data.length > MAX_PAYLOAD_BYTES) {
        relay.sendUi(ws, { type: 'error', message: 'Payload too large' });
        return;
      }
      text = data.toString('utf8');
    } else if (typeof data === 'string') {
      if (Buffer.byteLength(data, 'utf8') > MAX_PAYLOAD_BYTES) {
        relay.sendUi(ws, { type: 'error', message: 'Payload too large' });
        return;
      }
      text = data;
    } else {
      relay.sendUi(ws, { type: 'error', message: 'Invalid payload' });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      relay.sendUi(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (!msg || typeof msg !== 'object') {
      relay.sendUi(ws, { type: 'error', message: 'Invalid message' });
      return;
    }

    if (msg.type === 'ping') {
      relay.sendUi(ws, { type: 'pong' });
      return;
    }

    if (msg.type === 'send') {
      if (typeof msg.text !== 'string') {
        relay.sendUi(ws, { type: 'error', message: 'Invalid payload' });
        return;
      }
      if (Buffer.byteLength(msg.text, 'utf8') > MAX_PAYLOAD_BYTES) {
        relay.sendUi(ws, { type: 'error', message: 'Payload too large' });
        return;
      }
      const result = relay.sendToDevice(msg.text);
      if (result.ok) {
        relay.sendUi(ws, { type: 'sent', chars: result.chars });
      } else {
        relay.sendUi(ws, { type: 'error', message: result.message });
      }
      return;
    }

    relay.sendUi(ws, { type: 'error', message: 'Unknown type' });
  });

  ws.on('close', () => {
    relay.removeUiClient(ws);
  });

  ws.on('error', () => {
    relay.removeUiClient(ws);
  });
});

server.listen(config.port, config.host, () => {
  console.log('==============================================');
  console.log(` HID Web Relay listening on ${config.host}:${config.port}`);
  console.log(` NODE_ENV=${config.nodeEnv}`);
  console.log(` ALLOW_LEGACY_DEVICE=${config.allowLegacyDevice}`);
  console.log(` DEVICE_TOKEN configured=${Boolean(config.deviceToken)}`);
  console.log('==============================================');
});

function shutdown() {
  console.log('[server] shutting down');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
