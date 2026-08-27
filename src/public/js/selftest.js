'use strict';

/**
 * Same-PC HID loopback self-test (inject-only; never echo received events).
 */
(function (global) {
  const KEY_CODE = 'KeyF';
  const KEYBOARD_N = 100;
  const KEYBOARD_GAP_MS = 40;
  const CLICK_N = 50;
  const CLICK_GAP_MS = 80;
  const BURST_N = 100;
  const TIMEOUT_MS = 2000;
  const SQUARE_SIDE = 240;
  const SQUARE_STEP = 3;
  const SQUARE_MS = 8;

  /**
   * @param {object} api
   * @param {() => boolean} api.isDeviceReady
   * @param {(buf: ArrayBuffer) => void} api.sendBinary
   * @param {() => void} api.sendReleaseAll
   * @param {() => void} [api.onBusyChange]
   */
  function createSelfTest(api) {
    const pad = document.getElementById('selftest-pad');
    const padLabel = document.getElementById('selftest-pad-label');
    const armInput = document.getElementById('selftest-arm');
    const statusEl = document.getElementById('selftest-status');
    const resultsBody = document.getElementById('selftest-results-body');
    const btnKeyboard = document.getElementById('selftest-run-keyboard');
    const btnClick = document.getElementById('selftest-run-click');
    const btnBurst100 = document.getElementById('selftest-run-burst-100');
    const btnBurst250 = document.getElementById('selftest-run-burst-250');
    const btnSquare = document.getElementById('selftest-run-square');
    const btnAbort = document.getElementById('selftest-abort');
    const btnCopy = document.getElementById('selftest-copy');

    const {
      hidUsageFromCode,
      buildFrame,
      buildMouseFrame,
      OP_KEY_DOWN,
      OP_KEY_UP,
      OP_RELEASE_ALL,
    } = global.HidKeymap;

    const keyUsage = hidUsageFromCode(KEY_CODE);

    let armed = false;
    let busy = false;
    let abortFlag = false;
    /** @type {Array<object>} */
    let results = [];
    let squareTimer = null;

    function setStatus(text) {
      statusEl.textContent = text;
    }

    function notifyBusy() {
      if (typeof api.onBusyChange === 'function') {
        api.onBusyChange();
      }
    }

    function refreshControls() {
      const ready = armed && !busy && api.isDeviceReady();
      armInput.disabled = busy;
      btnKeyboard.disabled = !ready;
      btnClick.disabled = !ready;
      btnBurst100.disabled = !ready;
      btnBurst250.disabled = !ready;
      btnSquare.disabled = !ready;
      btnAbort.disabled = !busy;
      btnCopy.disabled = results.length === 0;
      pad.classList.toggle('armed', armed && !busy);
      pad.classList.toggle('running', busy);
      if (!busy) {
        padLabel.textContent = armed
          ? 'Armed — keep focus here; run a test'
          : 'Hit pad — click here, then Arm';
      }
    }

    function sleep(ms) {
      return new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }

    function percentile(sorted, p) {
      if (!sorted.length) {
        return null;
      }
      const idx = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
      );
      return sorted[idx];
    }

    function summarize(samples, attempted) {
      const sorted = samples.slice().sort((a, b) => a - b);
      const hits = sorted.length;
      const loss = attempted > 0 ? ((attempted - hits) / attempted) * 100 : 0;
      return {
        n: hits,
        attempted,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        lossPct: loss,
        samples: sorted,
      };
    }

    function fmtMs(v) {
      if (v == null || Number.isNaN(v)) {
        return '—';
      }
      return `${v.toFixed(1)} ms`;
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function renderResults() {
      resultsBody.innerHTML = '';
      if (!results.length) {
        const tr = document.createElement('tr');
        tr.className = 'empty';
        tr.innerHTML = '<td colspan="7">No runs yet</td>';
        resultsBody.appendChild(tr);
        return;
      }
      for (const row of results) {
        const tr = document.createElement('tr');
        tr.innerHTML = [
          `<td>${escapeHtml(row.metric)}</td>`,
          `<td>${row.n}/${row.attempted}</td>`,
          `<td>${fmtMs(row.p50)}</td>`,
          `<td>${fmtMs(row.p95)}</td>`,
          `<td>${fmtMs(row.p99)}</td>`,
          `<td>${row.lossPct.toFixed(1)}</td>`,
          `<td>${escapeHtml(row.notes || '')}</td>`,
        ].join('');
        resultsBody.appendChild(tr);
      }
    }

    function pushResult(metric, summary, notes) {
      results.push({
        metric,
        n: summary.n,
        attempted: summary.attempted,
        p50: summary.p50,
        p95: summary.p95,
        p99: summary.p99,
        lossPct: summary.lossPct,
        notes: notes || '',
      });
      renderResults();
      refreshControls();
    }

    function injectBinary(buf) {
      if (!api.isDeviceReady() || abortFlag) {
        return false;
      }
      if (!busy && !armed) {
        return false;
      }
      api.sendBinary(buf);
      return true;
    }

    function releaseAll() {
      api.sendReleaseAll();
    }

    function cancelSquareTimer() {
      if (squareTimer != null) {
        clearTimeout(squareTimer);
        squareTimer = null;
      }
    }

    async function beginRun(label) {
      if (!armed || busy || !api.isDeviceReady()) {
        return false;
      }
      abortFlag = false;
      busy = true;
      notifyBusy();
      refreshControls();
      pad.focus();
      padLabel.textContent = label;
      setStatus(label);
      releaseAll();
      await sleep(30);
      return true;
    }

    async function endRun() {
      cancelSquareTimer();
      releaseAll();
      busy = false;
      abortFlag = false;
      notifyBusy();
      refreshControls();
    }

    /** Arm listener, then inject; latency from inject instant. */
    function probeKey(type, code, frame) {
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => finish(null), TIMEOUT_MS);

        function onEvent(event) {
          if (event.code !== code || event.repeat) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          finish(performance.now() - t0);
        }

        function finish(value) {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          window.removeEventListener(type, onEvent, true);
          resolve(abortFlag ? null : value);
        }

        window.addEventListener(type, onEvent, true);
        const t0 = performance.now();
        if (!injectBinary(frame)) {
          finish(null);
        }
      });
    }

    function probePadMouse(type, buttons) {
      return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => finish(null), TIMEOUT_MS);

        function onEvent(event) {
          if (event.button !== 0) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          finish(performance.now() - t0);
        }

        function finish(value) {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          pad.removeEventListener(type, onEvent, true);
          resolve(abortFlag ? null : value);
        }

        pad.addEventListener(type, onEvent, true);
        const t0 = performance.now();
        if (!injectBinary(buildMouseFrame(buttons, 0, 0, 0))) {
          finish(null);
        }
      });
    }

    async function runKeyboardRtt() {
      if (!(await beginRun('Keyboard RTT running…'))) {
        return;
      }
      if (keyUsage == null) {
        setStatus('KeyF usage missing from keymap');
        await endRun();
        return;
      }
      const downSamples = [];
      const upSamples = [];

      for (let i = 0; i < KEYBOARD_N; i += 1) {
        if (abortFlag || !api.isDeviceReady()) {
          break;
        }
        setStatus(`Keyboard RTT ${i + 1}/${KEYBOARD_N}`);
        padLabel.textContent = `Keyboard ${i + 1}/${KEYBOARD_N}`;

        const downMs = await probeKey(
          'keydown',
          KEY_CODE,
          buildFrame(OP_KEY_DOWN, keyUsage)
        );
        if (downMs == null) {
          injectBinary(buildFrame(OP_KEY_UP, keyUsage));
          releaseAll();
          await sleep(KEYBOARD_GAP_MS);
          continue;
        }
        downSamples.push(downMs);

        const upMs = await probeKey('keyup', KEY_CODE, buildFrame(OP_KEY_UP, keyUsage));
        if (upMs == null) {
          releaseAll();
        } else {
          upSamples.push(upMs);
        }
        await sleep(KEYBOARD_GAP_MS);
      }

      const downSummary = summarize(downSamples, KEYBOARD_N);
      const upSummary = summarize(upSamples, KEYBOARD_N);
      pushResult('Keyboard down RTT', downSummary, `KeyF; gap ${KEYBOARD_GAP_MS}ms`);
      pushResult('Keyboard up RTT', upSummary, 'KeyF');
      setStatus(
        abortFlag
          ? 'Keyboard RTT aborted'
          : `Keyboard RTT done — down p50 ${fmtMs(downSummary.p50)}, loss ${downSummary.lossPct.toFixed(1)}%`
      );
      await endRun();
    }

    async function runClickRtt() {
      if (!(await beginRun('Click RTT — keep cursor on hit pad…'))) {
        return;
      }
      setStatus('Click RTT — move system cursor onto the hit pad, then waiting…');
      await sleep(800);
      const downSamples = [];
      const upSamples = [];

      for (let i = 0; i < CLICK_N; i += 1) {
        if (abortFlag || !api.isDeviceReady()) {
          break;
        }
        setStatus(`Click RTT ${i + 1}/${CLICK_N}`);
        padLabel.textContent = `Click ${i + 1}/${CLICK_N}`;
        pad.focus();

        const downMs = await probePadMouse('mousedown', 0x01);
        if (downMs == null) {
          injectBinary(buildMouseFrame(0, 0, 0, 0));
          releaseAll();
          await sleep(CLICK_GAP_MS);
          continue;
        }
        downSamples.push(downMs);

        const upMs = await probePadMouse('mouseup', 0x00);
        if (upMs == null) {
          releaseAll();
        } else {
          upSamples.push(upMs);
        }
        await sleep(CLICK_GAP_MS);
      }

      const downSummary = summarize(downSamples, CLICK_N);
      const upSummary = summarize(upSamples, CLICK_N);
      pushResult('Click down RTT', downSummary, 'left button on hit pad');
      pushResult('Click up RTT', upSummary, 'left button');
      setStatus(
        abortFlag
          ? 'Click RTT aborted'
          : `Click RTT done — down p50 ${fmtMs(downSummary.p50)}, loss ${downSummary.lossPct.toFixed(1)}%`
      );
      await endRun();
    }

    async function runBurst(ratePerSec) {
      if (!(await beginRun(`Burst ${ratePerSec}/s running…`))) {
        return;
      }
      if (keyUsage == null) {
        setStatus('KeyF usage missing from keymap');
        await endRun();
        return;
      }
      const intervalMs = 1000 / ratePerSec;
      let received = 0;

      function onKeyDown(event) {
        if (event.code !== KEY_CODE || event.repeat) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        received += 1;
      }

      window.addEventListener('keydown', onKeyDown, true);
      const tStart = performance.now();

      for (let i = 0; i < BURST_N; i += 1) {
        if (abortFlag || !api.isDeviceReady()) {
          break;
        }
        setStatus(`Burst ${ratePerSec}/s ${i + 1}/${BURST_N}`);
        padLabel.textContent = `Burst ${i + 1}/${BURST_N}`;
        injectBinary(buildFrame(OP_KEY_DOWN, keyUsage));
        injectBinary(buildFrame(OP_KEY_UP, keyUsage));
        const target = tStart + (i + 1) * intervalMs;
        const wait = target - performance.now();
        if (wait > 0) {
          await sleep(wait);
        }
      }

      const drainUntil = performance.now() + TIMEOUT_MS;
      while (performance.now() < drainUntil && !abortFlag) {
        setStatus(`Burst ${ratePerSec}/s draining… (${received}/${BURST_N})`);
        await sleep(50);
        if (received >= BURST_N) {
          break;
        }
      }
      window.removeEventListener('keydown', onKeyDown, true);

      const got = Math.min(received, BURST_N);
      const loss = BURST_N > 0 ? ((BURST_N - got) / BURST_N) * 100 : 0;
      const elapsed = performance.now() - tStart;
      pushResult(
        `Burst ${ratePerSec}/s`,
        {
          n: got,
          attempted: BURST_N,
          p50: null,
          p95: null,
          p99: null,
          lossPct: loss,
          samples: [],
        },
        `${received} keydowns in ${elapsed.toFixed(0)}ms`
      );
      setStatus(
        abortFlag
          ? `Burst ${ratePerSec}/s aborted`
          : `Burst ${ratePerSec}/s done — got ${received}/${BURST_N}, loss ${loss.toFixed(1)}%`
      );
      await endRun();
    }

    function runMicroSide(dxTotal, dyTotal) {
      return new Promise((resolve) => {
        const signX = dxTotal === 0 ? 0 : dxTotal > 0 ? 1 : -1;
        const signY = dyTotal === 0 ? 0 : dyTotal > 0 ? 1 : -1;
        let remain = Math.max(Math.abs(dxTotal), Math.abs(dyTotal));

        function step() {
          squareTimer = null;
          if (abortFlag || !api.isDeviceReady()) {
            resolve(false);
            return;
          }
          if (remain <= 0) {
            resolve(true);
            return;
          }
          const mag = Math.min(SQUARE_STEP, remain);
          const dx = signX * (dxTotal !== 0 ? mag : 0);
          const dy = signY * (dyTotal !== 0 ? mag : 0);
          remain -= mag;
          injectBinary(buildMouseFrame(0, dx, dy, 0));
          squareTimer = setTimeout(step, SQUARE_MS);
        }

        step();
      });
    }

    async function runSquareSmoke() {
      if (!(await beginRun('Square smoke running…'))) {
        return;
      }
      const t0 = performance.now();
      const sides = [
        [SQUARE_SIDE, 0],
        [0, SQUARE_SIDE],
        [-SQUARE_SIDE, 0],
        [0, -SQUARE_SIDE],
      ];
      let ok = true;
      for (let i = 0; i < sides.length; i += 1) {
        if (abortFlag) {
          ok = false;
          break;
        }
        setStatus(`Square smoke side ${i + 1}/4`);
        padLabel.textContent = `Square side ${i + 1}/4`;
        const sideOk = await runMicroSide(sides[i][0], sides[i][1]);
        if (!sideOk) {
          ok = false;
          break;
        }
      }
      cancelSquareTimer();
      const elapsed = performance.now() - t0;
      pushResult(
        'Square smoke',
        {
          n: ok ? 1 : 0,
          attempted: 1,
          p50: elapsed,
          p95: elapsed,
          p99: elapsed,
          lossPct: ok ? 0 : 100,
          samples: ok ? [elapsed] : [],
        },
        'wall-clock; move accuracy qualitative'
      );
      setStatus(abortFlag || !ok ? 'Square smoke aborted' : `Square smoke done in ${elapsed.toFixed(0)} ms`);
      await endRun();
    }

    function abort() {
      if (!busy) {
        refreshControls();
        return;
      }
      abortFlag = true;
      cancelSquareTimer();
      releaseAll();
      setStatus('Aborting…');
    }

    async function copyJson() {
      const payload = {
        when: new Date().toISOString(),
        pathHint: global.location.host,
        tests: results.map((r) => ({
          metric: r.metric,
          n: r.n,
          attempted: r.attempted,
          p50: r.p50,
          p95: r.p95,
          p99: r.p99,
          lossPct: r.lossPct,
          notes: r.notes,
        })),
      };
      const text = JSON.stringify(payload, null, 2);
      try {
        await navigator.clipboard.writeText(text);
        setStatus('Results copied to clipboard');
      } catch {
        setStatus('Clipboard failed — see console');
        console.log(text);
      }
    }

    function enter() {
      abortFlag = false;
      pad.focus();
      setStatus(
        api.isDeviceReady()
          ? 'Self-test ready — Arm, then run a probe. Do not type during runs.'
          : 'Waiting for device + WebSocket…'
      );
      refreshControls();
    }

    function leave() {
      abortFlag = true;
      cancelSquareTimer();
      armed = false;
      armInput.checked = false;
      busy = false;
      try {
        if (api.isDeviceReady()) {
          api.sendBinary(buildFrame(OP_RELEASE_ALL));
        }
      } catch {
        // ignore
      }
      notifyBusy();
      setStatus('Idle — Arm to enable inject tests.');
      refreshControls();
    }

    armInput.addEventListener('change', () => {
      armed = Boolean(armInput.checked);
      if (armed) {
        pad.focus();
        setStatus('Armed — inject tests enabled. Keep hit pad focused.');
        if (api.isDeviceReady()) {
          releaseAll();
        }
      } else {
        abortFlag = true;
        cancelSquareTimer();
        if (busy) {
          releaseAll();
          busy = false;
          notifyBusy();
        }
        setStatus('Disarmed.');
      }
      refreshControls();
    });

    pad.addEventListener('click', () => {
      pad.focus();
    });

    window.addEventListener(
      'keydown',
      (event) => {
        if (!armed || event.code !== KEY_CODE) {
          return;
        }
        const view = document.getElementById('view-selftest');
        if (!view || view.hidden) {
          return;
        }
        event.preventDefault();
      },
      true
    );

    btnKeyboard.addEventListener('click', () => {
      void runKeyboardRtt();
    });
    btnClick.addEventListener('click', () => {
      void runClickRtt();
    });
    btnBurst100.addEventListener('click', () => {
      void runBurst(100);
    });
    btnBurst250.addEventListener('click', () => {
      void runBurst(250);
    });
    btnSquare.addEventListener('click', () => {
      void runSquareSmoke();
    });
    btnAbort.addEventListener('click', () => {
      abort();
    });
    btnCopy.addEventListener('click', () => {
      void copyJson();
    });

    refreshControls();

    return {
      enter,
      leave,
      abort,
      refresh: refreshControls,
      isArmed: () => armed,
      isBusy: () => busy,
    };
  }

  global.createSelfTest = createSelfTest;
})(window);
