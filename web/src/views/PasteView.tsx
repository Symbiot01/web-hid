import { useState } from 'react';

type Props = {
  deviceConnected: boolean;
  liveActive: boolean;
  active: boolean;
};

export function PasteView({ deviceConnected, liveActive, active }: Props) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');

  const canSend =
    active && deviceConnected && text.length > 0 && !liveActive;

  async function sendPaste() {
    if (!canSend) return;
    setStatus('Sending…');
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
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        chars?: number;
      };
      if (res.status === 401) {
        window.location.assign('/');
        return;
      }
      if (!res.ok) {
        setStatus(data.error || 'Paste failed');
        return;
      }
      setStatus(`Sent ${data.chars} characters`);
      setText('');
    } catch {
      setStatus('Paste failed');
    }
  }

  return (
    <section className="card">
      <label className="field" htmlFor="paste-text">
        <span>Dump paste (sent as text to the device)</span>
        <textarea
          id="paste-text"
          rows={8}
          maxLength={2000}
          placeholder="Paste a block to type on the target…"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="meta-row">
        <span className="muted">
          {text.length} / 2000
        </span>
        <span className="muted" aria-live="polite">
          {status}
        </span>
      </div>
      <div className="actions">
        <button type="button" className="btn primary" disabled={!canSend} onClick={() => void sendPaste()}>
          Send
        </button>
        <span className="hint muted">Disabled while live keys are on</span>
      </div>
    </section>
  );
}
