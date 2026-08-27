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

  const mouseTestButtons = {
    focus: {
      square: document.getElementById('focus-mouse-square'),
      up: document.getElementById('focus-mouse-up'),
      down: document.getElementById('focus-mouse-down'),
      left: document.getElementById('focus-mouse-left'),
      right: document.getElementById('focus-mouse-right'),
    },
    split: {
      square: document.getElementById('split-mouse-square'),
      up: document.getElementById('split-mouse-up'),
      down: document.getElementById('split-mouse-down'),
      left: document.getElementById('split-mouse-left'),
      right: document.getElementById('split-mouse-right'),
    },
  };

  let deviceConnected = false;
  let liveActive = false;
  /** @type {'none'|'hid'|'measure'} */
  let inputTarget = 'none';
  let currentView = 'focus';
  const heldCodes = new Set();
  let mouseButtons = 0;
  let squareTimer = null;
  let squareRunning = false;
  /** @type {ReturnType<typeof window.createSelfTest>|null} */
  let selfTest = null;

  function isOperatorView() {
    return currentView === 'focus' || currentView === 'split';
  }

  const NUDGE_PX = 80;
  // Match a real pointer: tiny deltas at ~125 Hz (not one big jump).
  const SQUARE_SIDE = 240;
  const SQUARE_STEP = 3;
  const SQUARE_MS = 8;

  const {
    hidUsageFromCode,
    buildFrame,
    buildMouseFrame,
    OP_KEY_DOWN,
    OP_KEY_UP,
    OP_RELEASE_ALL,
  } = window.HidKeymap;

  function setDeviceStatus(connected) {
    deviceConnected = Boolean(connected);
    deviceBadge.textContent = deviceConnected ? 'Connected' : 'Disconnected';
    deviceBadge.classList.toggle('online', deviceConnected);
    deviceBadge.classList.toggle('offline', !deviceConnected);
    if (!deviceConnected && liveActive) {
      stopLive('Device disconnected');
    }
    if (!deviceConnected && selfTest) {
      selfTest.abort();
      selfTest.refresh();
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
    const canLive =
      deviceConnected &&
      socket.isOpen() &&
      !liveActive &&
      isOperatorView() &&
      !(selfTest && selfTest.isBusy());
    const canMouseTest =
      deviceConnected && socket.isOpen() && liveActive && isOperatorView();
    focusLiveStart.disabled = !canLive;
    splitLiveStart.disabled = !canLive;
    focusLiveStop.disabled = !liveActive;
    splitLiveStop.disabled = !liveActive;
    for (const group of Object.values(mouseTestButtons)) {
      for (const btn of Object.values(group)) {
        if (!btn) {
          continue;
        }
        btn.disabled = !canMouseTest || squareRunning;
      }
    }
    pasteSend.disabled = !(
      deviceConnected &&
      pasteText.value.length > 0 &&
      !liveActive &&
      currentView === 'paste'
    );
    if (selfTest) {
      selfTest.refresh();
    }
  }

  function sendReleaseAll() {
    heldCodes.clear();
    mouseButtons = 0;
    socket.sendBinary(buildFrame(OP_RELEASE_ALL));
  }

  function activeStage() {
    return currentView === 'split' ? splitStage : focusStage;
  }

  function hintEl() {
    return currentView === 'split' ? splitHint : focusHint;
  }

  /** Test / scripted mouse — no pointer lock required. */
  function canSendScriptedMouse() {
    return (
      liveActive &&
      inputTarget === 'hid' &&
      isOperatorView() &&
      deviceConnected &&
      socket.isOpen()
    );
  }

  function sendScriptedMouse(dx, dy, wheel, buttons) {
    if (!canSendScriptedMouse()) {
      return false;
    }
    mouseButtons = (buttons == null ? mouseButtons : buttons) & 0x07;
    socket.sendBinary(buildMouseFrame(mouseButtons, dx, dy, wheel || 0));
    return true;
  }

  function cancelSquare() {
    if (squareTimer != null) {
      clearTimeout(squareTimer);
      squareTimer = null;
    }
    squareRunning = false;
    refreshButtons();
  }

  /**
   * Emit relative moves along one axis as a stream of small frames.
   * @param {number} totalDx
   * @param {number} totalDy
   * @param {string} label
   * @param {() => void} [onDone]
   */
  function runMicroMoves(totalDx, totalDy, label, onDone) {
    const absX = Math.abs(totalDx);
    const absY = Math.abs(totalDy);
    if (absX === 0 && absY === 0) {
      if (onDone) {
        onDone();
      }
      return;
    }
    const signX = totalDx === 0 ? 0 : totalDx > 0 ? 1 : -1;
    const signY = totalDy === 0 ? 0 : totalDy > 0 ? 1 : -1;
    let remain = Math.max(absX, absY);
    const stepPx = SQUARE_STEP;
    const interval = SQUARE_MS;

    function step() {
      squareTimer = null;
      if (!canSendScriptedMouse()) {
        cancelSquare();
        setLastKey('Last key: (mouse move cancelled)');
        return;
      }
      if (remain <= 0) {
        squareRunning = false;
        refreshButtons();
        if (onDone) {
          onDone();
        }
        return;
      }
      const mag = Math.min(stepPx, remain);
      const dx = signX * (absX > 0 ? mag : 0);
      const dy = signY * (absY > 0 ? mag : 0);
      remain -= mag;
      if (!sendScriptedMouse(dx, dy, 0, 0)) {
        cancelSquare();
        return;
      }
      squareTimer = setTimeout(step, interval);
    }

    squareRunning = true;
    refreshButtons();
    if (label) {
      setLastKey(label);
    }
    step();
  }

  function nudgeMouse(dx, dy) {
    if (!canSendScriptedMouse() || squareRunning) {
      return;
    }
    runMicroMoves(dx, dy, `Last key: mouse nudge ${dx},${dy}`, () => {
      setLastKey(`Last key: mouse nudge ${dx},${dy} done`);
    });
  }

  /**
   * Walk a closed square with human-like micro moves: right → down → left → up.
   */
  function runMouseSquare() {
    if (!canSendScriptedMouse() || squareRunning) {
      return;
    }
    const sides = [
      { dx: SQUARE_SIDE, dy: 0 },
      { dx: 0, dy: SQUARE_SIDE },
      { dx: -SQUARE_SIDE, dy: 0 },
      { dx: 0, dy: -SQUARE_SIDE },
    ];
    let sideIdx = 0;
    squareRunning = true;
    refreshButtons();
    setLastKey('Last key: mouse square test…');

    function runSide() {
      if (!canSendScriptedMouse()) {
        cancelSquare();
        setLastKey('Last key: (square cancelled)');
        return;
      }
      if (sideIdx >= sides.length) {
        squareRunning = false;
        refreshButtons();
        setLastKey('Last key: mouse square done');
        return;
      }
      const side = sides[sideIdx];
      sideIdx += 1;
      // runMicroMoves sets squareRunning; chain sides via onDone
      squareRunning = false;
      runMicroMoves(side.dx, side.dy, null, runSide);
    }

    runSide();
  }

  async function lockKeyboard() {
    const el = hintEl();
    el.textContent = '';
    if (!window.isSecureContext) {
      el.textContent =
        'Keyboard Lock needs HTTPS or localhost. Some browser shortcuts stay local.';
      return;
    }
    if (!navigator.keyboard || typeof navigator.keyboard.lock !== 'function') {
      el.textContent = 'No Keyboard Lock in this browser. Use Chromium when possible.';
      return;
    }
    try {
      await navigator.keyboard.lock();
    } catch {
      el.textContent = 'Keyboard Lock denied. Some shortcuts may not forward.';
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

  function requestPointerLockOnStage() {
    const stage = activeStage();
    if (!stage || document.pointerLockElement === stage) {
      return;
    }
    if (typeof stage.requestPointerLock !== 'function') {
      hintEl().textContent = 'Pointer Lock unavailable. Mouse needs a Chromium browser.';
      return;
    }
    try {
      const ret = stage.requestPointerLock({ unadjustedMovement: true });
      if (ret && typeof ret.then === 'function') {
        ret.catch(() => {
          try {
            stage.requestPointerLock();
          } catch {
            // ignore
          }
        });
      }
    } catch {
      try {
        stage.requestPointerLock();
      } catch {
        // ignore
      }
    }
  }

  function exitPointerLock() {
    if (document.pointerLockElement && typeof document.exitPointerLock === 'function') {
      try {
        document.exitPointerLock();
      } catch {
        // ignore
      }
    }
  }

  function canSendMouse() {
    return liveActive && inputTarget === 'hid' && isOperatorView();
  }

  function sendMouse(dx, dy, wheel, buttons) {
    if (!canSendMouse()) {
      return;
    }
    mouseButtons = buttons & 0x07;
    socket.sendBinary(buildMouseFrame(mouseButtons, dx, dy, wheel));
  }

  function wheelDelta(event) {
    let steps = 0;
    if (event.deltaMode === 1) {
      steps = -event.deltaY;
    } else if (event.deltaMode === 2) {
      steps = -event.deltaY * 3;
    } else {
      steps = -event.deltaY / 40;
    }
    const n = Math.round(steps);
    if (n > 127) {
      return 127;
    }
    if (n < -127) {
      return -127;
    }
    return n;
  }

  async function startLive() {
    if (!deviceConnected || !socket.isOpen() || liveActive || !isOperatorView()) {
      return;
    }
    if (selfTest && selfTest.isBusy()) {
      return;
    }
    liveActive = true;
    inputTarget = 'hid';
    setLiveBadge(true);
    markVideoFocus(true);
    refreshButtons();
    setLastKey('Last key: (live on)');
    sendReleaseAll();
    const stage = activeStage();
    stage.focus();
    // Must request lock in the same user-gesture turn (before await).
    requestPointerLockOnStage();
    await lockKeyboard();
    hintEl().textContent =
      'Pointer locked — Esc exits lock. Move/click/scroll for target mouse.';
  }

  function stopLive(reason) {
    if (!liveActive) {
      unlockKeyboard();
      exitPointerLock();
      cancelSquare();
      refreshButtons();
      return;
    }
    liveActive = false;
    inputTarget = 'none';
    setLiveBadge(false);
    markVideoFocus(false);
    unlockKeyboard();
    exitPointerLock();
    cancelSquare();
    sendReleaseAll();
    refreshButtons();
    hintEl().textContent = '';
    setLastKey(reason ? `Last key: (${reason})` : 'Last key: —');
  }

  function markVideoFocus(on) {
    focusStage.classList.toggle('hid-focus', on && currentView === 'focus');
    splitStage.classList.toggle('hid-focus', on && currentView === 'split');
  }

  function onKeyEvent(event, action) {
    // Self-test / measure: never echo OS HID back to the device.
    if (currentView === 'selftest' || inputTarget === 'measure') {
      return;
    }
    if (!liveActive || inputTarget !== 'hid') {
      return;
    }
    if (currentView === 'paste') {
      return;
    }
    // While live, keys always go to HID (scratch must not keep them local).
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
    if (currentView === 'selftest' && selfTest) {
      selfTest.leave();
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

    if (name === 'selftest') {
      inputTarget = 'measure';
      if (selfTest) {
        selfTest.enter();
      }
    } else if (inputTarget === 'measure') {
      inputTarget = 'none';
    }

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
      if (selfTest) {
        selfTest.abort();
      }
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

  selfTest = window.createSelfTest({
    isDeviceReady() {
      return deviceConnected && socket.isOpen();
    },
    sendBinary(buf) {
      socket.sendBinary(buf);
    },
    sendReleaseAll() {
      sendReleaseAll();
    },
    onBusyChange() {
      refreshButtons();
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
    if (liveActive) {
      inputTarget = 'hid';
      markVideoFocus(true);
      focusStage.focus();
      requestPointerLockOnStage();
    }
  });

  splitStage.addEventListener('click', () => {
    if (liveActive) {
      inputTarget = 'hid';
      markVideoFocus(true);
      splitStage.focus();
      requestPointerLockOnStage();
    }
  });

  scratch.addEventListener('focus', () => {
    if (liveActive) {
      // Keep HID as the key target; only drop pointer lock so the operator can use the pad UI.
      inputTarget = 'hid';
      exitPointerLock();
      hintEl().textContent = 'Live on — keys still go to HID. Click video to re-lock mouse.';
    }
  });

  scratch.addEventListener('blur', () => {
    if (liveActive) {
      inputTarget = 'hid';
      markVideoFocus(true);
    }
  });

  function wireMouseTests(group) {
    group.square.addEventListener('click', (event) => {
      event.stopPropagation();
      runMouseSquare();
    });
    group.up.addEventListener('click', (event) => {
      event.stopPropagation();
      nudgeMouse(0, -NUDGE_PX);
    });
    group.down.addEventListener('click', (event) => {
      event.stopPropagation();
      nudgeMouse(0, NUDGE_PX);
    });
    group.left.addEventListener('click', (event) => {
      event.stopPropagation();
      nudgeMouse(-NUDGE_PX, 0);
    });
    group.right.addEventListener('click', (event) => {
      event.stopPropagation();
      nudgeMouse(NUDGE_PX, 0);
    });
  }

  wireMouseTests(mouseTestButtons.focus);
  wireMouseTests(mouseTestButtons.split);

  function onMouseMove(event) {
    if (!canSendMouse() || document.pointerLockElement !== activeStage()) {
      return;
    }
    const dx = event.movementX || 0;
    const dy = event.movementY || 0;
    if (dx === 0 && dy === 0) {
      return;
    }
    sendMouse(dx, dy, 0, event.buttons);
  }

  function onMouseButton(event) {
    if (!canSendMouse() || document.pointerLockElement !== activeStage()) {
      return;
    }
    event.preventDefault();
    sendMouse(0, 0, 0, event.buttons);
    setLastKey(`Last key: mouse buttons ${event.buttons}`);
  }

  function onWheel(event) {
    if (!canSendMouse() || document.pointerLockElement !== activeStage()) {
      return;
    }
    event.preventDefault();
    const w = wheelDelta(event);
    if (w === 0) {
      return;
    }
    sendMouse(0, 0, w, event.buttons);
  }

  function onContextMenu(event) {
    if (canSendMouse() && document.pointerLockElement === activeStage()) {
      event.preventDefault();
    }
  }

  document.addEventListener('pointerlockchange', () => {
    if (!liveActive) {
      return;
    }
    if (document.pointerLockElement === activeStage()) {
      inputTarget = 'hid';
      markVideoFocus(true);
      hintEl().textContent =
        'Pointer locked — Esc exits lock. Move/click/scroll for target mouse.';
    } else if (inputTarget === 'hid') {
      hintEl().textContent = 'Click the video stage to re-lock the pointer.';
      sendReleaseAll();
    }
  });

  focusStage.addEventListener('mousemove', onMouseMove);
  splitStage.addEventListener('mousemove', onMouseMove);
  focusStage.addEventListener('mousedown', onMouseButton);
  splitStage.addEventListener('mousedown', onMouseButton);
  focusStage.addEventListener('mouseup', onMouseButton);
  splitStage.addEventListener('mouseup', onMouseButton);
  focusStage.addEventListener('wheel', onWheel, { passive: false });
  splitStage.addEventListener('wheel', onWheel, { passive: false });
  focusStage.addEventListener('contextmenu', onContextMenu);
  splitStage.addEventListener('contextmenu', onContextMenu);

  pasteText.addEventListener('input', updatePasteCount);
  pasteSend.addEventListener('click', sendPaste);

  window.addEventListener('keydown', (event) => onKeyEvent(event, 'down'), true);
  window.addEventListener('keyup', (event) => onKeyEvent(event, 'up'), true);

  window.addEventListener('blur', () => {
    if (liveActive) {
      exitPointerLock();
      sendReleaseAll();
      setLastKey('Last key: (window blur — keys released)');
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && liveActive) {
      exitPointerLock();
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
