import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { AgentKind, AgentMessage, AgentMode, AgentPhase, AgentStep, TestCase } from './types.ts';

type ImagePayload = { mime: string; base64: string };

type Props = {
  mode: AgentMode;
  phase: AgentPhase;
  step?: AgentStep;
  attempt?: number;
  maxAttempts?: number;
  title?: string;
  entry?: string;
  signature?: string;
  cases: TestCase[];
  configured: boolean;
  messages: AgentMessage[];
  onMode: (mode: AgentMode) => void;
  onSend: (text: string, image: ImagePayload | null) => void;
  onAction: (action: 'retry' | 'cases_wrong' | 'more_cases' | 'reset') => void;
};

function renderInline(line: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = tokenRegex.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(<strong key={`b-${key++}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code key={`c-${key++}`} className="ide-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    }
    lastIndex = tokenRegex.lastIndex;
  }
  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }
  return parts;
}

function renderFormattedText(text: string): ReactNode {
  const blocks = text.split(/```(?:[a-zA-Z0-9_-]*\n)?/);
  return blocks.map((segment, index) => {
    if (index % 2 === 1) {
      return (
        <pre key={`code-${index}`} className="ide-md-pre">
          {segment.trim()}
        </pre>
      );
    }
    const lines = segment.split('\n');
    return (
      <div key={`txt-${index}`} className="ide-md-block">
        {lines.map((line, lineIdx) => {
          const trimmed = line.trim();
          if (!trimmed) return <div key={`sp-${lineIdx}`} className="ide-md-spacer" />;
          if (/^[-*]\s+/.test(trimmed)) {
            return (
              <div key={`li-${lineIdx}`} className="ide-md-bullet">
                <span>•</span>
                <span>{renderInline(trimmed.replace(/^[-*]\s+/, ''))}</span>
              </div>
            );
          }
          return (
            <p key={`p-${lineIdx}`} className="ide-md-line">
              {renderInline(line)}
            </p>
          );
        })}
      </div>
    );
  });
}

const PIPELINE: Array<{ key: AgentStep; label: string }> = [
  { key: 'identify', label: '1. Problem' },
  { key: 'cases', label: '2. Cases' },
  { key: 'harness', label: '3. Wrapper' },
  { key: 'solve', label: '4. Solve & Test' },
];

function stageRank(step: AgentStep | undefined, phase: AgentPhase): number {
  if (phase === 'solved' || step === 'done') return 5;
  if (step === 'test' || step === 'solve') return 4;
  if (step === 'harness') return 3;
  if (step === 'cases') return 2;
  if (step === 'identify') return 1;
  return 0;
}

export function AgentPane({
  mode,
  phase,
  step = 'idle',
  attempt = 0,
  maxAttempts = 3,
  title = '',
  entry = 'solve',
  signature = '',
  cases,
  configured,
  messages,
  onMode,
  onSend,
  onAction,
}: Props) {
  const [draft, setDraft] = useState('');
  const [imageName, setImageName] = useState('');
  const [image, setImage] = useState<ImagePayload | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const feedRef = useRef<HTMLOListElement>(null);
  const working = phase === 'working';

  const phaseLabel: Record<AgentPhase, string> = {
    idle: 'Ready',
    working: 'Working…',
    needs_human: 'Needs guidance',
    solved: 'Solved',
    blocked: 'Check cases',
  };

  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, phase]);

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

  function chooseImage(file: File | undefined, fallbackName?: string) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) {
      setImage(null);
      setImageName('Use a JPEG, PNG, or WebP under 4 MB');
      return;
    }
    if (mode !== 'agent') {
      onMode('agent');
    }
    const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
    const label = file.name && file.name !== 'image.png' ? file.name : fallbackName || `clipboard.${ext}`;
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const base64 = value.slice(value.indexOf(',') + 1);
      setImage({ mime: file.type, base64 });
      setImageName(label);
    };
    reader.readAsDataURL(file);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!configured) return;
    const items = event.clipboardData?.items;
    if (items) {
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            const ext = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/webp' ? 'webp' : 'png';
            chooseImage(file, `pasted-image.${ext}`);
            return;
          }
        }
      }
    }
    const files = event.clipboardData?.files;
    if (files && files.length > 0 && files[0].type.startsWith('image/')) {
      event.preventDefault();
      chooseImage(files[0], 'pasted-image.png');
    }
  }

  function hasFilePayload(event: DragEvent<HTMLElement>): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes('Files');
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!configured || !hasFilePayload(event)) return;
    event.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!configured || !hasFilePayload(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!hasFilePayload(event)) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    if (!configured) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const imgFile = Array.from(files).find((item) => item.type.startsWith('image/')) ?? files[0];
    chooseImage(imgFile, imgFile.name || 'dropped-image.png');
  }

  function body(message: AgentMessage) {
    const kind: AgentKind | 'note' = message.kind || (message.role === 'user' ? 'user' : 'note');
    if (kind === 'problem' || kind === 'plan') {
      const summaryText =
        kind === 'problem' ? (title ? `Problem · ${title}` : 'Problem Statement') : 'Algorithm & Complexity';
      return (
        <details className={`ide-agent-card ide-agent-${kind}`} open={kind === 'plan' || phase !== 'solved'}>
          <summary>{summaryText}</summary>
          <div className="ide-agent-card-body">{renderFormattedText(message.text)}</div>
        </details>
      );
    }
    return <div className="ide-msg-body">{renderFormattedText(message.text)}</div>;
  }

  const rank = stageRank(step, phase);
  const passCount = cases.filter((item) => item.status === 'pass').length;
  const hasRunCases = cases.some((item) => item.status !== 'idle');

  return (
    <section
      className={`ide-panel${dragging ? ' ide-panel-drop' : ''}`}
      aria-label="Agent"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
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
        <div className="ide-bar-actions">
          {mode === 'agent' && phase !== 'idle' && !working ? (
            <button type="button" className="btn ghost ide-mini" onClick={() => onAction('reset')}>
              New problem
            </button>
          ) : null}
          <span className={`ide-agent-phase ide-agent-phase-${phase}`}>
            {configured ? phaseLabel[phase] : 'Not configured'}
          </span>
        </div>
      </header>
      {mode === 'agent' && phase !== 'idle' ? (
        <div className="ide-agent-status" aria-label="Agent progress">
          <div className="ide-agent-steps">
            {PIPELINE.map((item, idx) => {
              const stepIdx = idx + 1;
              const stateClass = rank > stepIdx ? 'done' : rank === stepIdx ? 'current' : 'pending';
              return (
                <span key={item.key} className={`ide-step-pill ide-step-${stateClass}`}>
                  {item.label}
                </span>
              );
            })}
          </div>
          <div className="ide-agent-meta">
            <code className="ide-meta-chip" title={signature || `${entry}()`}>
              fn: {entry}()
            </code>
            <span className="ide-meta-chip">wrapper: main()</span>
            {attempt > 0 ? (
              <span className="ide-meta-chip">
                try {attempt}/{maxAttempts}
              </span>
            ) : null}
            {hasRunCases ? (
              <span className={`ide-meta-chip ${passCount === cases.length ? 'ide-meta-pass' : 'ide-meta-fail'}`}>
                {passCount}/{cases.length} pass
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
      <ol ref={feedRef} className="ide-feed">
        {messages.length === 0 ? (
          <li className="ide-empty-card">
            <p className="ide-empty-title">
              {mode === 'ask' ? 'Ask about the open C++ file' : 'Harness-First Coding Agent'}
            </p>
            <p className="muted ide-empty">
              {mode === 'ask'
                ? 'Ask how the current program works, check time complexity, or debug an edge case without modifying the editor.'
                : 'Paste a problem statement or attach a screenshot. The agent extracts the signature & sample format, builds a main() test wrapper first, and solves inside the target function or solve().'}
            </p>
          </li>
        ) : (
          messages.map((message) => {
            const kind: AgentKind | 'note' = message.kind || (message.role === 'user' ? 'user' : 'note');
            const label = message.role === 'user' ? 'You' : kind === 'step' ? 'Status' : 'Agent';
            return (
              <li key={message.id} className={`ide-msg ide-msg-${message.role} ide-msg-${kind}`}>
                {kind === 'problem' || kind === 'plan' ? null : <span className="ide-msg-role">{label}</span>}
                {body(message)}
              </li>
            );
          })
        )}
      </ol>
      {mode === 'agent' && (phase === 'needs_human' || phase === 'blocked' || phase === 'solved') ? (
        <div className="ide-agent-actions">
          <p className="muted ide-agent-hint">
            {phase === 'solved'
              ? `All ${cases.length} test case${cases.length === 1 ? '' : 's'} passed. You can ask for another approach or start a new problem.`
              : phase === 'blocked'
                ? 'A sample output contradicts the statement. Edit the case below or send guidance, then retry.'
                : 'Paused for your input. Edit the code or cases if needed, suggest an approach, or retry.'}
          </p>
          <button type="button" className="btn ghost ide-mini" disabled={working} onClick={() => onAction('more_cases')}>
            + Edge cases
          </button>
          <button type="button" className="btn ghost ide-mini" disabled={working} onClick={() => onAction('retry')}>
            Another approach
          </button>
          <button type="button" className="btn ghost ide-mini" disabled={working} onClick={() => onAction('cases_wrong')}>
            Cases are wrong
          </button>
        </div>
      ) : null}
      <form className={`ide-compose${dragging ? ' ide-compose-drop' : ''}`} onSubmit={submit}>
        <label className="sr-only" htmlFor="agent-draft">
          Message
        </label>
        <textarea
          id="agent-draft"
          rows={3}
          value={draft}
          disabled={!configured || (working && mode === 'ask')}
          placeholder={
            dragging
              ? 'Drop image (PNG, JPEG, WebP) here to attach…'
              : mode === 'ask'
                ? 'Ask about this code, or Ctrl+V / drop a problem screenshot…'
                : phase === 'working'
                  ? 'Send a hint or approach for the next attempt…'
                  : phase === 'idle'
                    ? 'Paste a problem or screenshot (Ctrl+V), or drag & drop an image…'
                    : 'Give guidance, specify an algorithm, or paste/drop a new image…'
          }
          onChange={(event) => setDraft(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
              event.preventDefault();
              const text = draft.trim();
              if (!text && !image) return;
              onSend(text, image);
              setDraft('');
              setImage(null);
              setImageName('');
              if (fileRef.current) fileRef.current.value = '';
            }
          }}
        />
        <div className="ide-compose-bar">
          {mode === 'agent' ? (
            <div className="ide-compose-left">
              <input
                ref={fileRef}
                className="sr-only"
                id="agent-image"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(event) => chooseImage(event.target.files?.[0])}
              />
              <label className="btn ghost ide-mini" htmlFor="agent-image">
                + Image
              </label>
              {imageName ? (
                <span className="ide-agent-file-pill">
                  {image ? (
                    <img
                      className="ide-agent-thumb"
                      src={`data:${image.mime};base64,${image.base64}`}
                      alt=""
                    />
                  ) : null}
                  <span className="ide-agent-file">{imageName}</span>
                  {image ? (
                    <button
                      type="button"
                      className="ide-file-clear"
                      aria-label="Remove attached image"
                      onClick={() => {
                        setImage(null);
                        setImageName('');
                        if (fileRef.current) fileRef.current.value = '';
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              ) : null}
            </div>
          ) : (
            <span className="muted ide-compose-shortcut">Ctrl+V image or Ctrl+Enter to send</span>
          )}
          <button
            type="submit"
            className="btn primary ide-mini"
            disabled={!configured || (draft.trim().length === 0 && !image) || (working && mode === 'ask')}
          >
            {mode === 'agent' && phase !== 'idle' && !image ? 'Guide' : 'Send'}
          </button>
        </div>
      </form>
    </section>
  );
}
