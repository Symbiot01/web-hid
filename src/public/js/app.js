'use strict';

(function () {
  const deviceBadge = document.getElementById('device-badge');
  const wsBadge = document.getElementById('ws-badge');
  const liveBadge = document.getElementById('live-badge');
  const logoutBtn = document.getElementById('logout-btn');

  const focusStage = document.getElementById('focus-stage');
  const splitStage = document.getElementById('split-stage');
  const scratch = document.getElementById('scratch');
  const pasteText = document.getElementById('paste-text');
  const pasteCount = document.getElementById('paste-count');
  const pasteStatus = document.getElementById('paste-status');
  const pasteSend = document.getElementById('paste-send');

  const focusLiveStart = document.getElementById('focus-live-start');
  const focusLiveStop = document.getElementById('focus-live-stop');
  const splitLiveStart = document.getElementById('split-live-start');
  const splitLiveStop = document.getElementById('split-live-stop');
  const focusHint = document.getElementById('focus-hint');
  const splitHint = document.getElementById('split-hint');
  const focusLast = document.getElementById('focus-last');
  const splitLast = document.getElementById('split-last');

  let deviceConnected = false;
  let liveActive = false;
  /** @type {'none'|'hid'|'scratch'} */
  let inputTarget = 'none';
  let currentView = 'focus';
  const heldCodes = new Set();

  const { hidUsageFromCode, buildFrame, OP_KEY_DOWN, OP_KEY_UP, OP_RELEASE_ALL } =
    window.HidKeymap;

  function setDeviceStatus(connected) {
    deviceConnected = Boolean(connected);
    deviceBadge.textContent = deviceConnected ? 'Connected' : 'Disconnected';
    deviceBadge.classList.toggle('online', deviceConnected);
    deviceBadge.classList.toggle('offline', !deviceConnected);
    if (!deviceConnected && liveActive) {
      stopLive('Device disconnected');
    }
    refreshButtons();
  }

  function setLiveBadge(on) {
    liveBadge.textContent = on ? 'Live' : 'Idle';
    liveBadge.classList.toggle('live', on);
    liveBadge.classList.toggle('muted-badge', !on);
  }

  function setLastKey(text) {
    focusLast.textContent = text;
    splitLast.textContent = text;
  }

  function refreshButtons() {
    const canLive = deviceConnected && socket.isOpen() && !liveActive && currentView !== 'paste';
    focusLiveStart.disabled = !canLive;
    splitLiveStart.disabled = !canLive;
    focusLiveStop.disabled = !liveActive;
    splitLiveStop.disabled = !liveActive;
    pasteSend.disabled = !(
      deviceConnected &&
      pasteText.value.length > 0 &&
      !liveActive &&
      currentView === 'paste'
    );
  }

  function sendReleaseAll() {
    heldCodes.clear();
    socket.sendBinary(buildFrame(OP_RELEASE_ALL));
  }

  async function lockKeyboard() {
    const hintEl = currentView === 'split' ? splitHint : focusHint;
    hintEl.textContent = '';
    if (!window.isSecureContext) {
      hintEl.textContent =
        'Keyboard Lock needs HTTPS or localhost. Some browser shortcuts stay local.';
      return;
    }
    if (!navigator.keyboard || typeof navigator.keyboard.lock !== 'function') {
      hintEl.textContent = 'No Keyboard Lock in this browser. Use Chromium when possible.';
      return;
    }
    try {
      await navigator.keyboard.lock();
    } catch {
      hintEl.textContent = 'Keyboard Lock denied. Some shortcuts may not forward.';
    }
  }

  function unlockKeyboard() {
    if (navigator.keyboard && typeof navigator.keyboard.unlock === 'function') {
      try {
        navigator.keyboard.unlock();
      } catch {
        // ignore
      }
    }
  }

  async function startLive() {
    if (!deviceConnected || !socket.isOpen() || liveActive || currentView === 'paste') {
      return;
    }
    liveActive = true;
    inputTarget = 'hid';
    setLiveBadge(true);
    markVideoFocus(true);
    refreshButtons();
    setLastKey('Last key: (live on)');
    sendReleaseAll();
    await lockKeyboard();
    const stage = currentView === 'split' ? splitStage : focusStage;
    stage.focus();
  }

  function stopLive(reason) {
    if (!liveActive) {
      unlockKeyboard();
      refreshButtons();
      return;
    }
    liveActive = false;
    inputTarget = 'none';
    setLiveBadge(false);
    markVideoFocus(false);
    unlockKeyboard();
    sendReleaseAll();
    refreshButtons();
    setLastKey(reason ? `Last key: (${reason})` : 'Last key: —');
  }

  function markVideoFocus(on) {
    focusStage.classList.toggle('hid-focus', on && currentView === 'focus');
    splitStage.classList.toggle('hid-focus', on && currentView === 'split');
  }

  function onKeyEvent(event, action) {
    if (!liveActive || inputTarget !== 'hid') {
      return;
    }
    if (currentView === 'paste') {
      return;
    }
    // Scratch has focus: do not steal keys
    if (document.activeElement === scratch) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (action === 'down' && event.repeat) {
      return;
    }
    const code = event.code;
    if (typeof code !== 'string' || !code) {
      return;
    }
    const usage = hidUsageFromCode(code);
    if (usage === null) {
      return;
    }
    if (action === 'down') {
      if (heldCodes.has(code)) {
        return;
      }
      heldCodes.add(code);
      socket.sendBinary(buildFrame(OP_KEY_DOWN, usage));
    } else {
      if (!heldCodes.has(code)) {
        return;
      }
      heldCodes.delete(code);
      socket.sendBinary(buildFrame(OP_KEY_UP, usage));
    }
    setLastKey(`Last key: ${code} ${action}`);
  }

  function switchView(name) {
    if (name === currentView) {
      return;
    }
    if (liveActive) {
      stopLive('view switch');
    }
    currentView = name;
    document.querySelectorAll('.view').forEach((el) => {
      const match = el.getAttribute('data-view') === name;
      el.hidden = !match;
      el.classList.toggle('active', match);
    });
    document.querySelectorAll('.tab').forEach((tab) => {
      const match = tab.getAttribute('data-view') === name;
      tab.classList.toggle('active', match);
      tab.setAttribute('aria-selected', match ? 'true' : 'false');
    });
    refreshButtons();
  }

  function updatePasteCount() {
    pasteCount.textContent = `${pasteText.value.length} / 2000`;
    refreshButtons();
  }

  async function sendPaste() {
    if (pasteSend.disabled) {
      return;
    }
    const text = pasteText.value;
    if (!text) {
      return;
    }
    pasteStatus.textContent = 'Sending…';
    try {
      const res = await fetch('/api/paste', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        window.location.assign('/');
        return;
      }
      if (!res.ok) {
        pasteStatus.textContent = data.error || 'Paste failed';
        return;
      }
      pasteStatus.textContent = `Sent ${data.chars} characters`;
      pasteText.value = '';
      updatePasteCount();
    } catch {
      pasteStatus.textContent = 'Paste failed';
    }
  }

  const socket = window.createHidSocket({
    onOpen() {
      wsBadge.textContent = 'WS connected';
      refreshButtons();
    },
    onClose() {
      wsBadge.textContent = 'WS disconnected';
      stopLive('WebSocket disconnected');
      refreshButtons();
    },
    onStatus(connected) {
      setDeviceStatus(connected);
    },
    onError(message) {
      if (liveActive && message === 'Key not supported') {
        return;
      }
      setLastKey(`Last key: (${message})`);
      if (currentView === 'paste') {
        pasteStatus.textContent = message;
      }
    },
  });

  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      switchView(tab.getAttribute('data-view'));
    });
  });

  focusLiveStart.addEventListener('click', () => startLive());
  splitLiveStart.addEventListener('click', () => startLive());
  focusLiveStop.addEventListener('click', () => stopLive('Live keys off'));
  splitLiveStop.addEventListener('click', () => stopLive('Live keys off'));

  focusStage.addEventListener('click', () => {
    inputTarget = liveActive ? 'hid' : 'none';
    markVideoFocus(liveActive);
    focusStage.focus();
  });

  splitStage.addEventListener('click', () => {
    inputTarget = liveActive ? 'hid' : 'none';
    markVideoFocus(liveActive);
    splitStage.focus();
  });

  scratch.addEventListener('focus', () => {
    if (liveActive) {
      // Scratch focus: stop stealing keys to target
      inputTarget = 'scratch';
      markVideoFocus(false);
    }
  });

  scratch.addEventListener('blur', () => {
    if (liveActive) {
      inputTarget = 'hid';
      markVideoFocus(true);
    }
  });

  pasteText.addEventListener('input', updatePasteCount);
  pasteSend.addEventListener('click', sendPaste);

  window.addEventListener('keydown', (event) => onKeyEvent(event, 'down'), true);
  window.addEventListener('keyup', (event) => onKeyEvent(event, 'up'), true);

  window.addEventListener('blur', () => {
    if (liveActive) {
      sendReleaseAll();
      setLastKey('Last key: (window blur — keys released)');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && liveActive) {
      sendReleaseAll();
    }
  });

  logoutBtn.addEventListener('click', async () => {
    stopLive();
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
      // WS will update
    }
  }

  setDeviceStatus(false);
  setLiveBadge(false);
  updatePasteCount();
  fetchStatus();
  socket.open();
})();
