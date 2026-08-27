import { useNavigate } from 'react-router-dom';
import { useRef, useState } from 'react';
import { useHidSocket } from '../hooks/useHidSocket';
import { useLiveHid, type ConsoleViewName } from '../hooks/useLiveHid';
import { PasteView } from './PasteView';
import { SelfTestView } from './SelfTestView';
import { StreamTestView } from './StreamTestView';

const TABS: { id: ConsoleViewName; label: string }[] = [
  { id: 'focus', label: 'Focus' },
  { id: 'split', label: 'Split' },
  { id: 'paste', label: 'Paste' },
  { id: 'selftest', label: 'Self-test' },
  { id: 'streamtest', label: 'Stream-test' },
];

export function ConsoleView() {
  const navigate = useNavigate();
  const [view, setView] = useState<ConsoleViewName>('focus');
  const stageRef = useRef<HTMLDivElement>(null);
  const scratchRef = useRef<HTMLTextAreaElement>(null);

  const {
    wsConnected,
    deviceConnected,
    lastError,
    clearError,
    sendBinary,
    isOpen,
  } = useHidSocket();

  const live = useLiveHid({
    view,
    deviceConnected,
    wsConnected,
    sendBinary,
    isOpen,
    stageRef,
    scratchRef,
  });

  if (lastError && live.liveActive && lastError !== 'Key not supported') {
    // surface once via lastKey path in hook; clear sticky
    clearError();
  }

  async function logout() {
    live.stopLive();
    try {
      await fetch('/api/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
    } catch {
      // still leave
    }
    navigate('/', { replace: true });
  }

  function switchView(next: ConsoleViewName) {
    setView(next);
  }

  const stageClass =
    'video-stage' +
    (live.liveActive && (view === 'focus' || view === 'split') ? ' hid-focus' : '');

  function mouseChrome() {
    return (
      <>
        <span className="chrome-sep" aria-hidden="true" />
        <button
          type="button"
          className="btn ghost"
          disabled={!live.canMouseTest}
          title="Move target cursor in a square"
          onClick={(e) => {
            e.stopPropagation();
            live.runMouseSquare();
          }}
        >
          Square
        </button>
        <button
          type="button"
          className="btn ghost btn-icon"
          disabled={!live.canMouseTest}
          title="Nudge up"
          onClick={(e) => {
            e.stopPropagation();
            live.nudgeMouse(0, -80);
          }}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn ghost btn-icon"
          disabled={!live.canMouseTest}
          title="Nudge left"
          onClick={(e) => {
            e.stopPropagation();
            live.nudgeMouse(-80, 0);
          }}
        >
          ←
        </button>
        <button
          type="button"
          className="btn ghost btn-icon"
          disabled={!live.canMouseTest}
          title="Nudge down"
          onClick={(e) => {
            e.stopPropagation();
            live.nudgeMouse(0, 80);
          }}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn ghost btn-icon"
          disabled={!live.canMouseTest}
          title="Nudge right"
          onClick={(e) => {
            e.stopPropagation();
            live.nudgeMouse(80, 0);
          }}
        >
          →
        </button>
      </>
    );
  }

  return (
    <main className="shell wide">
      <header className="topbar">
        <div>
          <h1>Operator Console</h1>
          <p className="muted">
            Live keys and relative mouse go to the ESP32 over USB HID. Camera feed is a
            placeholder until capture is wired.
          </p>
        </div>
        <div className="topbar-actions">
          <div className="status-row compact">
            <span className="label">Device</span>
            <span
              className={`badge ${deviceConnected ? 'online' : 'offline'}`}
              aria-live="polite"
            >
              {deviceConnected ? 'Connected' : 'Disconnected'}
            </span>
            <span className={`badge ${wsConnected ? 'online' : 'muted-badge'}`} aria-live="polite">
              {wsConnected ? 'WS connected' : 'WS disconnected'}
            </span>
            <span className={`badge ${live.liveActive ? 'live' : 'muted-badge'}`}>
              {live.liveActive ? 'Live' : 'Idle'}
            </span>
          </div>
          <button type="button" className="btn ghost" onClick={() => void logout()}>
            Logout
          </button>
        </div>
      </header>

      <nav className="view-tabs" role="tablist" aria-label="Views">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab${view === tab.id ? ' active' : ''}`}
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => switchView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {view === 'focus' ? (
        <section className="view active">
          <div
            ref={stageRef}
            className={stageClass}
            tabIndex={0}
            onClick={live.onStageClick}
          >
            <div className="video-placeholder" aria-hidden="true">
              <span>Camera placeholder</span>
              <span className="muted">Click here, then Start live (keys + mouse)</span>
            </div>
            <div className="video-chrome">
              <button
                type="button"
                className="btn primary"
                disabled={!live.canLive}
                onClick={(e) => {
                  e.stopPropagation();
                  void live.startLive();
                }}
              >
                Start live
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={!live.liveActive}
                onClick={(e) => {
                  e.stopPropagation();
                  live.stopLive('Live keys off');
                }}
              >
                Stop
              </button>
              {mouseChrome()}
              <span className="hint muted">{live.hint}</span>
            </div>
          </div>
          <p className="muted live-last">{live.lastKey}</p>
        </section>
      ) : null}

      {view === 'split' ? (
        <section className="view active">
          <div className="split-grid">
            <div
              ref={stageRef}
              className={stageClass}
              tabIndex={0}
              onClick={live.onStageClick}
            >
              <div className="video-placeholder" aria-hidden="true">
                <span>Camera placeholder</span>
                <span className="muted">Focus this pane for keys + mouse</span>
              </div>
              <div className="video-chrome">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!live.canLive}
                  onClick={(e) => {
                    e.stopPropagation();
                    void live.startLive();
                  }}
                >
                  Start live
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={!live.liveActive}
                  onClick={(e) => {
                    e.stopPropagation();
                    live.stopLive('Live keys off');
                  }}
                >
                  Stop
                </button>
                {mouseChrome()}
              </div>
            </div>
            <div className="scratch-pane">
              <label className="field" htmlFor="scratch">
                <span>Scratch notes (while live, keystrokes still go to HID)</span>
                <textarea
                  id="scratch"
                  ref={scratchRef}
                  rows={16}
                  placeholder="Local notes — typing while live is forwarded to the target…"
                  spellCheck={false}
                  onFocus={live.onScratchFocus}
                />
              </label>
            </div>
          </div>
          <p className="muted live-last">{live.lastKey}</p>
          <p className="hint muted">{live.hint}</p>
        </section>
      ) : null}

      {view === 'paste' ? (
        <PasteView
          deviceConnected={deviceConnected}
          liveActive={live.liveActive}
          active={view === 'paste'}
        />
      ) : null}

      {view === 'selftest' ? (
        <SelfTestView
          deviceReady={deviceConnected && wsConnected}
          sendBinary={sendBinary}
          active={view === 'selftest'}
        />
      ) : null}

      {view === 'streamtest' ? <StreamTestView active={view === 'streamtest'} /> : null}
    </main>
  );
}
