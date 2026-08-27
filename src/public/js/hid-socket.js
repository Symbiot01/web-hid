'use strict';

/**
 * Binary HID WebSocket to /ws/hid.
 */
(function (global) {
  function createHidSocket(handlers) {
    let ws = null;
    let reconnectTimer = null;
    const onStatus = handlers.onStatus || function () {};
    const onError = handlers.onError || function () {};
    const onOpen = handlers.onOpen || function () {};
    const onClose = handlers.onClose || function () {};

    function open() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws/hid`;
      ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.addEventListener('open', () => {
        onOpen();
        sendJson({ type: 'ping' });
      });

      ws.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          return;
        }
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') {
          return;
        }
        if (msg.type === 'status') {
          onStatus(Boolean(msg.deviceConnected));
        } else if (msg.type === 'error') {
          onError(msg.message || 'Error');
        }
      });

      ws.addEventListener('close', () => {
        onClose();
        reconnectTimer = setTimeout(open, 2000);
      });

      ws.addEventListener('error', () => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    }

    function isOpen() {
      return Boolean(ws && ws.readyState === WebSocket.OPEN);
    }

    function sendJson(msg) {
      if (!isOpen()) {
        return false;
      }
      ws.send(JSON.stringify(msg));
      return true;
    }

    function sendBinary(arrayBuffer) {
      if (!isOpen()) {
        return false;
      }
      ws.send(arrayBuffer);
      return true;
    }

    function close() {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    }

    return { open, isOpen, sendJson, sendBinary, close };
  }

  global.createHidSocket = createHidSocket;
})(window);
