'use strict';

(function () {
  const MAX_CHARS = 2000;
  const payloadEl = document.getElementById('payload');
  const sendBtn = document.getElementById('send-btn');
  const logoutBtn = document.getElementById('logout-btn');
  const charCount = document.getElementById('char-count');
  const lastAction = document.getElementById('last-action');
  const deviceBadge = document.getElementById('device-badge');
  const wsBadge = document.getElementById('ws-badge');

  let deviceConnected = false;
  let ws = null;
  let reconnectTimer = null;

  function updateCharCount() {
    const n = payloadEl.value.length;
    charCount.textContent = `${n} / ${MAX_CHARS}`;
  }

  function setDeviceStatus(connected) {
    deviceConnected = Boolean(connected);
    deviceBadge.textContent = deviceConnected ? 'Connected' : 'Disconnected';
    deviceBadge.classList.toggle('online', deviceConnected);
    deviceBadge.classList.toggle('offline', !deviceConnected);
    refreshSendEnabled();
  }

  function refreshSendEnabled() {
    const hasText = payloadEl.value.length > 0;
    sendBtn.disabled = !(deviceConnected && hasText && ws && ws.readyState === WebSocket.OPEN);
  }

  function setWsStatus(label) {
    wsBadge.textContent = label;
  }

  function setLastAction(text) {
    lastAction.textContent = text || '';
  }

  async function fetchStatus() {
    try {
      const res = await fetch('/api/status', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (res.status === 401) {
        window.location.assign('/');
        return;
      }
      if (!res.ok) {
        return;
      }
      const data = await res.json();
      setDeviceStatus(data.deviceConnected);
    } catch {
      // ignore; WS will update
    }
  }

  function connectWs() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws/ui`;
    setWsStatus('WS connecting…');

    ws = new WebSocket(wsUrl);

    ws.addEventListener('open', () => {
      setWsStatus('WS connected');
      refreshSendEnabled();
      ws.send(JSON.stringify({ type: 'ping' }));
    });

    ws.addEventListener('message', (event) => {
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
        setDeviceStatus(msg.deviceConnected);
      } else if (msg.type === 'sent') {
        setLastAction(`Sent ${msg.chars} characters`);
        payloadEl.value = '';
        updateCharCount();
        refreshSendEnabled();
      } else if (msg.type === 'error') {
        setLastAction(msg.message || 'Error');
      } else if (msg.type === 'pong') {
        // ok
      }
    });

    ws.addEventListener('close', () => {
      setWsStatus('WS disconnected');
      refreshSendEnabled();
      reconnectTimer = setTimeout(connectWs, 2000);
    });

    ws.addEventListener('error', () => {
      // close handler will reconnect
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  }

  function sendText() {
    if (sendBtn.disabled || !ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    const text = payloadEl.value;
    if (!text) {
      return;
    }
    if (text.length > MAX_CHARS) {
      setLastAction('Text too long');
      return;
    }
    ws.send(JSON.stringify({ type: 'send', text }));
  }

  payloadEl.addEventListener('input', () => {
    updateCharCount();
    refreshSendEnabled();
  });

  payloadEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendText();
    }
  });

  sendBtn.addEventListener('click', sendText);

  logoutBtn.addEventListener('click', async () => {
    try {
      await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch {
      // still leave
    }
    window.location.assign('/');
  });

  updateCharCount();
  setDeviceStatus(false);
  fetchStatus();
  connectWs();
})();
