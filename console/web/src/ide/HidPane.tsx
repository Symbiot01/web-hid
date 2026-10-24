import { useEffect, useMemo, useRef, useState } from 'react';
import { keyFrame, releaseFrame } from './hidKeys.ts';
import {
  buildHidPayload,
  estimateHidMs,
  formatHidTime,
  type HidIndent,
  type HidPlay,
  type HidScope,
} from './hidPayload.ts';
import type { LiveMode } from './useHidLink.ts';

type HidStatus = {
  configured?: boolean;
  deviceConnected?: boolean;
  error?: string;
};

type Progress = {
  state: string;
  sent: number;
  total: number;
  mode: string | null;
};

type LogLine = { id: number; text: string };

type Props = {
  active: boolean;
  continuous: boolean;
  liveMode: LiveMode | null;
  onContinuous: (enabled: boolean) => void;
  source: string;
  fileName: string;
  onSender: (send: (phase: 'down' | 'up' | 'release', code?: string) => void) => void;
  onPlay: (play: HidPlay | null) => void;
  status: HidStatus;
  socketOpen: boolean;
  log: LogLine[];
  pushLog: (text: string) => void;
  sendFrame: (buf: ArrayBuffer | null) => boolean;
};

const MAX_CHARS = 4000;

export function HidPane({
  active,
  continuous,
  liveMode,
  onContinuous,
  source,
  fileName,
  onSender,
  onPlay,
  status,
  socketOpen,
  log,
  pushLog,
  sendFrame,
}: Props) {
  const [wpm, setWpm] = useState(240);
  const [jitterPct, setJitterPct] = useState(25);
  const [scope, setScope] = useState<HidScope>('functions');
  const [indent, setIndent] = useState<HidIndent>('strip');
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('Choose what to send from the file, or paste text below.');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<Progress>({ state: 'idle', sent: 0, total: 0, mode: null });
  const senderRef = useRef(onSender);
  const sendRef = useRef(sendFrame);
  const playRef = useRef(onPlay);
  const mapRef = useRef<number[] | null>(null);
  const textRef = useRef('');
  const wasContinuous = useRef(false);
  senderRef.current = onSender;
  sendRef.current = sendFrame;
  playRef.current = onPlay;
  const [keysSent, setKeysSent] = useState(0);

  const built = useMemo(() => buildHidPayload(source, scope, indent), [source, scope, indent]);
  const fileEta = useMemo(() => formatHidTime(estimateHidMs(built.text, wpm)), [built.text, wpm]);
  const draftEta = useMemo(() => formatHidTime(estimateHidMs(draft, wpm)), [draft, wpm]);

  useEffect(() => {
    senderRef.current((phase, code) => {
      if (phase === 'release') {
        sendRef.current(releaseFrame());
        return;
      }
      if (!code) return;
      const sent = sendRef.current(keyFrame(phase, code));
      if (sent && phase === 'down') setKeysSent((count) => count + 1);
    });
  }, []);

  useEffect(() => {
    if ((!active && !busy) || status.configured === false) return;
    const events = new EventSource('/api/hid/paste/progress');
    events.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as Progress;
        setProgress(next);
        if (!mapRef.current) return;
        if (next.state === 'running' || next.state === 'paused') {
          const left = formatHidTime(estimateHidMs(textRef.current, wpm, next.sent));
          const holding = next.state === 'paused';
          playRef.current({ sent: next.sent, map: mapRef.current, eta: left, paused: holding });
          setNote(
            holding
              ? `Paused at ${next.sent}/${next.total} chars (~${left} left).`
              : `Sending ${next.sent}/${next.total} chars at ${wpm} WPM (~${left} left)…`,
          );
        } else if (next.state === 'complete' || next.state === 'cancelled' || next.state === 'error') {
          mapRef.current = null;
          textRef.current = '';
          playRef.current(null);
        }
      } catch {
        // ignore
      }
    };
    return () => events.close();
  }, [active, busy, status.configured, wpm]);

  useEffect(() => {
    if (wasContinuous.current && !continuous) sendFrame(releaseFrame());
    wasContinuous.current = continuous;
  }, [continuous, sendFrame]);

  async function sendPayload(text: string, label: string, map: number[] | null) {
    if (busy || text.length === 0) {
      if (text.length === 0 && map) setNote('No functions outside main() were found in this file.');
      return;
    }
    if (text.length > MAX_CHARS) {
      setNote(`${label} is longer than ${MAX_CHARS} characters.`);
      return;
    }
    if (!status.configured) {
      setNote('HID is not configured.');
      return;
    }
    if (!status.deviceConnected) {
      setNote('Keyboard is offline.');
      return;
    }
    if (continuous) onContinuous(false);
    const totalEta = formatHidTime(estimateHidMs(text, wpm));
    setBusy(true);
    mapRef.current = map;
    textRef.current = text;
    if (map) playRef.current({ sent: 0, map, eta: totalEta });
    setNote(`Sending 0/${text.length} chars at ${wpm} WPM (~${totalEta})…`);
    pushLog(`${label} ${text.length} chars @ ${wpm} WPM (~${totalEta})`);
    try {
      const res = await fetch('/api/hid/paste', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, mode: 'paced', wpm, jitterPct }),
      });
      const body = (await res.json()) as { error?: string; chars?: number; sent?: number };
      if (!res.ok) {
        const msg = body.error || 'Paste failed';
        setNote(typeof body.sent === 'number' ? `${msg} (${body.sent}/${text.length} sent).` : msg);
        pushLog(msg.toLowerCase());
        return;
      }
      const total = body.chars ?? text.length;
      setNote(`Sent ${total} characters.`);
      pushLog(`sent ${total} chars`);
      if (label === 'Paste') setDraft('');
    } catch {
      setNote('Paste failed');
    } finally {
      mapRef.current = null;
      textRef.current = '';
      playRef.current(null);
      setBusy(false);
    }
  }

  async function togglePause() {
    try {
      const path = progress.state === 'paused' ? '/api/hid/paste/resume' : '/api/hid/paste/pause';
      const res = await fetch(path, { method: 'POST', credentials: 'same-origin' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setNote(body.error || 'Pause failed');
      }
    } catch {
      setNote(progress.state === 'paused' ? 'Resume failed' : 'Pause failed');
    }
  }

  async function cancel() {
    try {
      await fetch('/api/hid/paste/cancel', { method: 'POST', credentials: 'same-origin' });
    } catch {
      // the button still clears the local busy flag
    }
    mapRef.current = null;
    textRef.current = '';
    playRef.current(null);
    setBusy(false);
    setNote('Cancelled');
    pushLog('paste cancelled');
  }

  const device = !status.configured ? 'Not configured' : status.deviceConnected ? 'Connected' : 'Offline';
  const paused = progress.state === 'paused';
  const sending = busy || progress.state === 'running' || paused;
  const pct = progress.total > 0 ? Math.min(100, Math.round((progress.sent / progress.total) * 100)) : 0;
  const remainingEta =
    sending && textRef.current
      ? formatHidTime(estimateHidMs(textRef.current, wpm, progress.sent))
      : fileEta;
  const targetName = fileName || 'main.cpp';
  const fileLabel = `${scope === 'functions' ? `${targetName} (functions)` : targetName}${indent === 'strip' ? ', trimmed' : ''}`;

  return (
    <div className="ide-hid">
      <section className="ide-hid-debug" aria-label="HID connection">
        <div className="ide-hid-head">
          <span className={`ide-hid-badge${status.deviceConnected ? ' ok' : ''}`}>
            <span className="ide-hid-dot" aria-hidden="true" />
            Keyboard {device}
          </span>
          <span className="ide-hid-stat">Keys {keysSent}</span>
        </div>
        <div className="ide-hid-pills">
          <span className={`ide-hid-pill${status.configured ? ' ok' : ''}`}>
            HID {status.configured ? 'ready' : 'off'}
          </span>
          <span className={`ide-hid-pill${socketOpen ? ' ok' : ''}`}>
            Socket {socketOpen ? 'open' : 'closed'}
          </span>
          <span className={`ide-hid-pill${continuous ? ' ok' : ''}`}>
            Continuous {continuous ? 'on' : 'off'}
          </span>
          <span className={`ide-hid-pill${liveMode ? ' ok' : ''}`}>
            Live {liveMode ? liveMode : 'off'}
          </span>
        </div>
        {sending || progress.total > 0 ? (
          <div className="ide-hid-meter" aria-live="polite">
            <div className="ide-hid-meter-top">
              <span>
                {paused
                  ? `Paused · ~${remainingEta} left`
                  : sending
                    ? `Sending · ~${remainingEta} left`
                    : progress.state === 'complete'
                      ? 'Sent'
                      : progress.state}
              </span>
              <span>
                {progress.sent}/{progress.total} ({pct}%)
              </span>
            </div>
            <div className="ide-hid-track">
              <div className="ide-hid-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        ) : null}
        {status.error ? <p className="ide-cam-sub">{status.error}</p> : null}
        <ol className="ide-hid-log">
          {log.length === 0 ? <li>No HID events yet.</li> : log.map((line) => <li key={line.id}>{line.text}</li>)}
        </ol>
      </section>
      <section className="ide-hid-send" aria-label="Send to HID">
        <div className="ide-hid-row">
          <label className="ide-check">
            <input
              type="checkbox"
              checked={continuous}
              onChange={(event) => onContinuous(event.target.checked)}
            />
            Continuous editor typing
          </label>
          <span className="ide-hid-pill ok">
            Est. time: ~{fileEta} ({built.text.length} chars @ {wpm} WPM)
          </span>
        </div>
        <div className="ide-hid-options">
          <div className="ide-hid-group" role="radiogroup" aria-label="Code to send">
            <span className="ide-hid-label">Code</span>
            <div className="ide-seg">
              <button
                type="button"
                role="radio"
                aria-checked={scope === 'file'}
                className={`ide-seg-btn${scope === 'file' ? ' active' : ''}`}
                disabled={sending}
                onClick={() => setScope('file')}
              >
                With wrapper
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={scope === 'functions'}
                className={`ide-seg-btn${scope === 'functions' ? ' active' : ''}`}
                disabled={sending}
                onClick={() => setScope('functions')}
              >
                Functions only
              </button>
            </div>
          </div>
          <div className="ide-hid-group" role="radiogroup" aria-label="Leading spaces">
            <span className="ide-hid-label">Indent</span>
            <div className="ide-seg">
              <button
                type="button"
                role="radio"
                aria-checked={indent === 'strip'}
                className={`ide-seg-btn${indent === 'strip' ? ' active' : ''}`}
                disabled={sending}
                onClick={() => setIndent('strip')}
              >
                No leading space
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={indent === 'keep'}
                className={`ide-seg-btn${indent === 'keep' ? ' active' : ''}`}
                disabled={sending}
                onClick={() => setIndent('keep')}
              >
                Keep spaces
              </button>
            </div>
          </div>
        </div>
        <div className="ide-hid-sliders">
          <label className="ide-cam-field">
            <span>
              Speed <strong>{wpm} WPM</strong>
            </span>
            <input
              type="range"
              min={20}
              max={300}
              step={5}
              value={wpm}
              disabled={sending}
              onChange={(event) => setWpm(Number(event.target.value))}
            />
          </label>
          <label className="ide-cam-field">
            <span>
              Jitter <strong>{jitterPct}%</strong>
            </span>
            <input
              type="range"
              min={0}
              max={50}
              step={5}
              value={jitterPct}
              disabled={sending}
              onChange={(event) => setJitterPct(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="ide-hid-actions">
          <button
            type="button"
            className="btn primary ide-mini"
            disabled={sending || built.text.length === 0}
            onClick={() => void sendPayload(built.text, fileLabel, built.map)}
          >
            Send {scope === 'functions' ? 'functions' : targetName} ({built.text.length} · ~{fileEta})
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={!sending}
            onClick={() => void togglePause()}
          >
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="btn ghost ide-mini" disabled={!sending} onClick={() => void cancel()}>
            Cancel
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={sending || !draft}
            onClick={() => void sendPayload(draft, 'Paste', null)}
          >
            Send paste{draft ? ` (${draft.length} · ~${draftEta})` : ''}
          </button>
        </div>
        <textarea
          className="ide-hid-draft"
          value={draft}
          maxLength={MAX_CHARS}
          disabled={sending}
          placeholder="Or paste custom text to type…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <p className="ide-cam-sub ide-hid-note">{note}</p>
      </section>
    </div>
  );
}
