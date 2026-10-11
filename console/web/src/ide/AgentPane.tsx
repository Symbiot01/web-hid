import { useRef, useState, type FormEvent } from 'react';
import type { AgentMessage, AgentMode, AgentPhase } from './types.ts';

type ImagePayload = { mime: string; base64: string };

type Props = {
  mode: AgentMode;
  phase: AgentPhase;
  configured: boolean;
  messages: AgentMessage[];
  onMode: (mode: AgentMode) => void;
  onSend: (text: string, image: ImagePayload | null) => void;
  onAction: (action: 'retry' | 'cases_wrong') => void;
};

export function AgentPane({ mode, phase, configured, messages, onMode, onSend, onAction }: Props) {
  const [draft, setDraft] = useState('');
  const [imageName, setImageName] = useState('');
  const [image, setImage] = useState<ImagePayload | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const working = phase === 'working';

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text && !image) return;
    onSend(text, image);
    setDraft('');
    setImage(null);
    setImageName('');
    if (fileRef.current) fileRef.current.value = '';
  }

  function chooseImage(file: File | undefined) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) {
      setImage(null);
      setImageName('Use a JPEG, PNG, or WebP under 4 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const base64 = value.slice(value.indexOf(',') + 1);
      setImage({ mime: file.type, base64 });
      setImageName(file.name);
    };
    reader.readAsDataURL(file);
  }

  return (
    <section className="ide-panel" aria-label="Agent">
      <header className="ide-bar">
        <div className="ide-modes" role="radiogroup" aria-label="Agent mode">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'ask'}
            className={`ide-tab${mode === 'ask' ? ' active' : ''}`}
            onClick={() => onMode('ask')}
          >
            Ask
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'agent'}
            className={`ide-tab${mode === 'agent' ? ' active' : ''}`}
            onClick={() => onMode('agent')}
          >
            Agent
          </button>
        </div>
        <span className="muted ide-agent-phase">{configured ? phase.replace('_', ' ') : 'not configured'}</span>
      </header>
      <ol className="ide-feed">
        {messages.length === 0 ? (
          <li className="muted ide-empty">
            {mode === 'ask'
              ? 'Ask about the open file.'
              : 'Upload a problem image or paste the question. You can send an approach while it runs.'}
          </li>
        ) : (
          messages.map((message) => (
            <li key={message.id} className={`ide-msg ide-msg-${message.role}`}>
              <span className="ide-msg-role">{message.role === 'user' ? 'You' : 'Agent'}</span>
              <p>{message.text}</p>
            </li>
          ))
        )}
      </ol>
      {mode === 'agent' && (phase === 'needs_human' || phase === 'blocked' || phase === 'solved') ? (
        <div className="ide-agent-actions">
          <button type="button" className="btn ghost ide-mini" disabled={working} onClick={() => onAction('retry')}>
            Another approach
          </button>
          <button type="button" className="btn ghost ide-mini" disabled={working} onClick={() => onAction('cases_wrong')}>
            Cases are wrong
          </button>
        </div>
      ) : null}
      <form className="ide-compose" onSubmit={submit}>
        <label className="sr-only" htmlFor="agent-draft">
          Message
        </label>
        <textarea
          id="agent-draft"
          rows={3}
          value={draft}
          disabled={!configured || working && mode === 'ask'}
          placeholder={
            mode === 'ask'
              ? 'Ask about this code'
              : phase === 'working'
                ? 'Send an approach for the next attempt'
                : 'Question, context, or an approach'
          }
          onChange={(event) => setDraft(event.target.value)}
        />
        {mode === 'agent' ? (
          <div className="ide-agent-actions">
            <input
              ref={fileRef}
              className="sr-only"
              id="agent-image"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => chooseImage(event.target.files?.[0])}
            />
            <label className="btn ghost ide-mini" htmlFor="agent-image">
              Image
            </label>
            {imageName ? <span className="muted ide-agent-file">{imageName}</span> : null}
          </div>
        ) : null}
        <button
          type="submit"
          className="btn primary ide-mini"
          disabled={!configured || (draft.trim().length === 0 && !image) || (working && mode === 'ask')}
        >
          Send
        </button>
      </form>
    </section>
  );
}
