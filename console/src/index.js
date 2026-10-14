'use strict';

const http = require('http');
const { loadConfig } = require('./config');
const { createApp } = require('./http');
const { createHidControl } = require('./hid');
const { attachHidSocket } = require('./hidProxy');

const config = loadConfig();
const hid = createHidControl({ deviceToken: config.deviceToken });
const app = createApp({ config, hid });
const server = http.createServer(app);
attachHidSocket(server, { config, hid });

server.listen(config.port, config.host, () => {
  console.log(`Operator console listening on ${config.host}:${config.port}`);
  console.log(hid.configured() ? 'HID device socket /ws/device enabled' : 'HID disabled (DEVICE_TOKEN empty)');
});

function shutdown() {
  hid.releaseAll();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
