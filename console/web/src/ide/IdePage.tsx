import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AgentPane } from './AgentPane.tsx';
import { EditorPane } from './EditorPane.tsx';
import type { HidPlay } from './hidPayload.ts';
import './monacoSetup.ts';
import { SplitPane } from './SplitPane.tsx';
import { TerminalPane } from './TerminalPane.tsx';
import { TestsPane } from './TestsPane.tsx';
import {
  INITIAL_MAIN,
  type AgentMessage,
  type AgentMode,
  type AgentPhase,
  type AgentStep,
  type AgentView,
  type EditorTab,
  type TestCase,
} from './types.ts';
import { useHidLink, type LiveMode } from './useHidLink.ts';

function nextId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

const STARTER_TABS: EditorTab[] = [
  { id: 'main', name: 'main.cpp', value: INITIAL_MAIN, dirty: false },
];

type RunCase = {
  status: 'pass' | 'fail' | 'idle';
  actual: string;
  stderr?: string;
  timeMs: number;
  reason: 'timeout' | 'output_limit' | 'runtime' | null;
  exitCode?: number | null;
};

type ProgramResult = {
  stdout: string;
  stderr: string;
  timeMs: number;
  reason: 'timeout' | 'output_limit' | 'runtime' | null;
  exitCode: number | null;
};

type RunResponse = {
  status: 'ran' | 'compile_error';
  compile: { ok: boolean; stderr: string };
  program?: ProgramResult | null;
  cases: RunCase[];
};

function formatProgram(program: ProgramResult): string {
  const lines = ['$ ./main'];
  if (program.stdout.length > 0) lines.push(program.stdout.replace(/\n$/, ''));
  if (program.stderr.trim().length > 0) lines.push(program.stderr.trim());
  if (program.reason === 'timeout') lines.push('time limit');
  else if (program.reason === 'output_limit') lines.push('output limit');
  else if (program.reason === 'runtime') lines.push(`exited ${program.exitCode ?? '?'}`);
  else lines.push(`exit ${program.exitCode ?? 0}  ${program.timeMs}ms`);
  return lines.join('\n');
}

function formatCases(payload: RunResponse): string[] {
  return payload.cases.map((item, index) => {
    if (payload.status === 'compile_error') return `case ${index + 1}  idle`;
    const detail =
      item.reason === 'timeout'
        ? 'time limit'
        : item.reason === 'output_limit'
          ? 'output limit'
          : item.reason === 'runtime'
            ? `exited ${item.exitCode ?? '?'}`
            : item.status;
    const stderr = item.stderr?.trim() ? `\n${item.stderr.trim()}` : '';
    return `case ${index + 1}  ${detail}  ${item.timeMs}ms${stderr}`;
  });
}

const STARTER_CASES: TestCase[] = [
  { id: 'case-1', input: '2 3\n', expected: '5\n', actual: '', status: 'idle' },
  { id: 'case-2', input: '10 7\n', expected: '3\n', actual: '', status: 'idle' },
];

type Props = {
  busy: boolean;
  onLogout: () => void;
};

export function IdePage({ busy, onLogout }: Props) {
  const [leftRatio, setLeftRatio] = useState(34);
  const [sideRatio, setSideRatio] = useState(58);
  const [editorRatio, setEditorRatio] = useState(68);
  const [tabs, setTabs] = useState<EditorTab[]>(STARTER_TABS);
  const [activeTabId, setActiveTabId] = useState(STARTER_TABS[0].id);
  const [cases, setCases] = useState<TestCase[]>(STARTER_CASES);
  const [activeCaseId, setActiveCaseId] = useState(STARTER_CASES[0].id);
  const [output, setOutput] = useState('');
  const [mode, setMode] = useState<AgentMode>('ask');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [agentPhase, setAgentPhase] = useState<AgentPhase>('idle');
  const [agentStep, setAgentStep] = useState<AgentStep>('idle');
  const [agentAttempt, setAgentAttempt] = useState(0);
  const [agentMaxAttempts, setAgentMaxAttempts] = useState(3);
  const [agentTitle, setAgentTitle] = useState('');
  const [agentEntry, setAgentEntry] = useState('solve');
  const [agentSignature, setAgentSignature] = useState('');
  const [agentReady, setAgentReady] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [running, setRunning] = useState<'program' | 'tests' | null>(null);
  const [editorView, setEditorView] = useState<'editor' | 'stream'>('editor');
  const [cameraStream, setCameraStream] = useState<2 | 3>(2);
  const [streamReconnectSeq, setStreamReconnectSeq] = useState(0);
  const [streamStopped, setStreamStopped] = useState(false);
  const [hidContinuous, setHidContinuous] = useState(false);
  const [bottomTab, setBottomTab] = useState<'terminal' | 'camera' | 'hid'>('terminal');
  const [liveMode, setLiveMode] = useState<LiveMode | null>(null);
  const [snapNote, setSnapNote] = useState('');
  const [hidPlay, setHidPlay] = useState<HidPlay | null>(null);
  const [incomingFiles, setIncomingFiles] = useState<File[]>([]);
  const videoGrabberRef = useRef<(() => Promise<Blob | null>) | null>(null);
  const bindVideoGrabber = useCallback((fn: (() => Promise<Blob | null>) | null) => {
    videoGrabberRef.current = fn;
  }, []);
  const hid = useHidLink({
    connect: bottomTab === 'hid' || hidContinuous || liveMode !== null,
    watch: bottomTab === 'hid' || hidContinuous || liveMode !== null,
    liveMode,
  });
  const hidSend = useRef<(phase: 'down' | 'up' | 'release', code?: string) => void>(() => {});
  const bindHid = useCallback((send: (phase: 'down' | 'up' | 'release', code?: string) => void) => {
    hidSend.current = send;
  }, []);
  const menuRef = useRef<HTMLDivElement>(null);
  const runSeq = useRef(0);

  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setConfirmLogout(false);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        setConfirmLogout(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function updateTab(id: string, value: string) {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === id ? { ...tab, value, dirty: value !== INITIAL_MAIN } : tab)),
    );
  }

  function reorder(from: number, to: number) {
    setTabs((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      if (!moved) return prev;
      next.splice(to, 0, moved);
      return next;
    });
  }

  function addTab() {
    const id = nextId('file');
    const tab: EditorTab = {
      id,
      name: `file-${tabs.length + 1}.cpp`,
      value: INITIAL_MAIN,
      dirty: false,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  }

  function closeTab(id: string) {
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (remaining.length === 0 || remaining.length === tabs.length) return;
    setTabs(remaining);
    if (activeTabId === id) setActiveTabId(remaining[0].id);
  }

  async function run(kind: 'program' | 'tests') {
    if (running) return;
    const active = tabs.find((tab) => tab.id === activeTabId);
    const source = active?.value ?? '';
    const fileName = active?.name ?? 'main.cpp';
    const submitted = cases.map((item) => ({ id: item.id, input: item.input, expected: item.expected }));
    const seq = runSeq.current + 1;
    runSeq.current = seq;
    setRunning(kind);
    const header = `$ g++ -std=c++17 -O2 -pipe -Wall -Wextra -o main ${fileName}`;
    setOutput((prev) => (prev ? `${prev}\n${header}\n` : `${header}\n`));
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          kind === 'program'
            ? { source, mode: 'program' }
            : {
                source,
                mode: 'tests',
                cases: submitted.map((item) => ({ input: item.input, expected: item.expected })),
              },
        ),
      });
      const payload = (await response.json()) as RunResponse | { error?: string };
      if (seq !== runSeq.current) return;
      if (!response.ok || !('status' in payload)) {
        const message = 'error' in payload && payload.error ? payload.error : `Run failed (${response.status})`;
        setOutput((prev) => `${prev}${message}\n`);
        return;
      }
      if (kind === 'program') {
        const lines = [payload.compile.stderr, payload.program ? formatProgram(payload.program) : ''].filter(
          (line) => line.length > 0,
        );
        setOutput((prev) => `${prev}${lines.join('\n')}\n`);
        return;
      }
      const lines = [payload.compile.stderr, ...formatCases(payload)].filter((line) => line.length > 0);
      setOutput((prev) => `${prev}${lines.join('\n')}\n`);
      if (payload.status === 'compile_error') {
        setCases((prev) => prev.map((item) => ({ ...item, status: 'idle', actual: '' })));
        return;
      }
      setCases((prev) =>
        prev.map((item, index) => {
          const result = payload.cases[index];
          if (!result || submitted[index]?.id !== item.id) return item;
          return {
            ...item,
            status: result.status,
            actual: result.actual,
            stderr: result.stderr,
            reason: result.reason,
            timeMs: result.timeMs,
          };
        }),
      );
    } catch {
      if (seq !== runSeq.current) return;
      setOutput((prev) => `${prev}Runner is unreachable.\n`);
    } finally {
      if (seq === runSeq.current) setRunning(null);
    }
  }

  function enterLive(mode: LiveMode) {
    setHidContinuous(false);
    setLiveMode(mode);
    setSnapNote('');
    if (streamStopped) void resumeStream(false);
    else setEditorView('stream');
  }

  function leaveLive() {
    setLiveMode(null);
  }

  function showView(next: 'editor' | 'stream') {
    setEditorView(next);
    if (next !== 'stream') {
      setLiveMode(null);
      return;
    }
    if (streamStopped) void resumeStream(false);
  }

  async function resumeStream(reconnect: boolean) {
    try {
      await fetch('/api/camera/resume', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch {
      // The next watch heartbeat reports the failure if the server is still held.
    }
    setStreamStopped(false);
    setEditorView('stream');
    if (reconnect) setStreamReconnectSeq((seq) => seq + 1);
  }

  async function stopStream() {
    setStreamStopped(true);
    setLiveMode(null);
    try {
      const response = await fetch('/api/camera/stop', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        return payload?.error || 'Could not stop the stream';
      }
      return 'Stream stopped';
    } catch {
      return 'Could not stop the stream';
    }
  }

  function attachToAgent(file: File, resetFirst: boolean) {
    if (resetFirst) guide('reset');
    setMode('agent');
    setIncomingFiles((prev) => [...prev, file]);
  }

  async function snap(
    kind: 'frame' | 'agent',
    target: 'agent' | 'save' = 'agent',
    resetFirst = false,
  ): Promise<string> {
    const startMsg =
      kind === 'frame'
        ? target === 'agent'
          ? 'Snapping stream frame to Agent…'
          : 'Saving stream frame…'
        : target === 'agent'
          ? 'Snapping via capture agent to Agent…'
          : 'Asking capture agent…';
    setSnapNote(startMsg);
    try {
      let blob: Blob | null = null;
      let sourceLabel = kind === 'frame' ? 'RTSP frame' : 'Capture agent';
      if (kind === 'frame' && videoGrabberRef.current) {
        blob = await videoGrabberRef.current();
        if (blob) sourceLabel = 'Live stream PNG';
      }
      if (!blob) {
        const response = await fetch(kind === 'frame' ? '/api/capture/frame' : '/api/capture/snap', {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          const err = body.error || 'Snap failed';
          setSnapNote(err);
          return err;
        }
        blob = await response.blob();
      }
      const ext = blob.type === 'image/png' ? 'png' : 'jpg';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
      const prefix = kind === 'frame' ? 'frame' : 'capture';
      const filename = `${prefix}-${stamp}.${ext}`;
      if (target === 'save') {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1500);
        const msg = `Saved ${filename} (${sourceLabel})`;
        setSnapNote(msg);
        return msg;
      }
      const file = new File([blob], filename, { type: blob.type || 'image/jpeg' });
      attachToAgent(file, resetFirst);
      const msg = resetFirst
        ? `New problem with ${filename} (${sourceLabel})`
        : `Attached ${filename} to Agent (${sourceLabel})`;
      setSnapNote(msg);
      return msg;
    } catch {
      setSnapNote('Snap failed');
      return 'Snap failed';
    }
  }

  const agentOutput = useRef('');

  function applyAgent(view: AgentView) {
    setAgentReady(view.configured);
    setAgentPhase(view.phase);
    setAgentStep(view.step ?? 'idle');
    setAgentAttempt(view.attempt ?? 0);
    setAgentMaxAttempts(view.maxAttempts ?? 3);
    setAgentTitle(view.title ?? '');
    setAgentEntry(view.entry ?? 'solve');
    setAgentSignature(view.signature ?? '');
    setMessages(
      view.messages.map((item, index) => ({
        id: `agent-msg-${index}`,
        role: item.role,
        text: item.text,
        kind: item.kind,
      })),
    );
    if (typeof view.source === 'string' && view.source.length > 0) {
      setTabs((prev) => {
        const target = prev.find((tab) => tab.name === 'main.cpp') ?? prev.find((tab) => tab.id === activeTabId) ?? prev[0];
        if (!target) return prev;
        return prev.map((tab) => (tab.id === target.id ? { ...tab, value: view.source as string, dirty: true } : tab));
      });
      setEditorView('editor');
    }
    if (Array.isArray(view.cases) && view.cases.length > 0) {
      setCases(
        view.cases.map((item) => ({
          id: item.id,
          input: item.input,
          expected: item.expected,
          actual: item.actual,
          stderr: item.stderr,
          reason: item.reason,
          timeMs: item.timeMs,
          status: item.status,
        })),
      );
      const firstFailed = view.cases.find((item) => item.status === 'fail');
      setActiveCaseId((prev) => {
        if (firstFailed) return firstFailed.id;
        if (view.cases.some((item) => item.id === prev)) return prev;
        return view.cases[0].id;
      });
    }
    if (view.output && view.output !== agentOutput.current) {
      const next = view.output.startsWith(agentOutput.current)
        ? view.output.slice(agentOutput.current.length)
        : view.output;
      agentOutput.current = view.output;
      if (next.trim()) setOutput((prev) => (prev ? `${prev}\n${next}` : next));
    }
  }

  useEffect(() => {
    let stop = false;
    async function load() {
      try {
        const response = await fetch('/api/agent', { credentials: 'same-origin' });
        if (!response.ok) return;
        const view = (await response.json()) as AgentView;
        if (!stop) applyAgent(view);
      } catch {
        // The pane stays quiet until the next send.
      }
    }
    void load();
    return () => {
      stop = true;
    };
    // Load the agent once. Later updates come from send and the working poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (agentPhase !== 'working') return;
    const timer = window.setInterval(() => {
      void fetch('/api/agent', { credentials: 'same-origin' })
        .then((response) => (response.ok ? response.json() : null))
        .then((view: AgentView | null) => {
          if (view) applyAgent(view);
        })
        .catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [agentPhase]);

  async function send(text: string, images: { mime: string; base64: string }[]) {
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (mode === 'agent') setAgentPhase('working');
    try {
      if (mode === 'ask') {
        const response = await fetch('/api/agent/ask', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, source: active?.value ?? '' }),
        });
        const payload = (await response.json()) as { text?: string; error?: string };
        setMessages((prev) => [
          ...prev,
          { id: nextId('msg'), role: 'user', text },
          { id: nextId('msg'), role: 'assistant', text: payload.text || payload.error || 'No answer.' },
        ]);
        setAgentPhase('idle');
        return;
      }
      const starting = agentPhase === 'idle';
      const serializedImages = images.map((item) => ({ mime: item.mime, data: item.base64 }));
      const response = await fetch(starting ? '/api/agent' : '/api/agent/guide', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          starting
            ? {
                text,
                hint: '',
                source: active?.value ?? '',
                images: serializedImages,
                imageBase64: images[0]?.base64,
                mime: images[0]?.mime,
              }
            : {
                text,
                source: active?.value ?? '',
                cases: cases.map((item) => ({ input: item.input, expected: item.expected })),
                images: serializedImages,
                imageBase64: images[0]?.base64,
                mime: images[0]?.mime,
              },
        ),
      });
      const payload = (await response.json()) as AgentView & { error?: string };
      if (!response.ok || payload.error) {
        setAgentPhase(agentPhase === 'working' ? 'needs_human' : agentPhase);
        setMessages((prev) => [...prev, { id: nextId('msg'), role: 'assistant', text: payload.error || 'The agent stopped' }]);
        return;
      }
      applyAgent(payload);
    } catch {
      setAgentPhase('needs_human');
      setMessages((prev) => [...prev, { id: nextId('msg'), role: 'assistant', text: 'The agent is unreachable.' }]);
    }
  }

  function guide(action: 'retry' | 'cases_wrong' | 'more_cases' | 'reset') {
    if (action === 'reset') {
      agentOutput.current = '';
      void fetch('/api/agent/guide', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload: AgentView | null) => {
          if (payload) applyAgent(payload);
        })
        .catch(() => undefined);
      return;
    }
    const active = tabs.find((tab) => tab.id === activeTabId);
    setAgentPhase('working');
    void fetch('/api/agent/guide', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action,
        source: active?.value ?? '',
        cases: cases.map((item) => ({ input: item.input, expected: item.expected })),
      }),
    })
      .then((response) => response.json())
      .then((payload: AgentView & { error?: string }) => {
        if (payload.error) {
          setAgentPhase('needs_human');
          setMessages((prev) => [...prev, { id: nextId('msg'), role: 'assistant', text: payload.error as string }]);
          return;
        }
        applyAgent(payload);
      })
      .catch(() => setAgentPhase('needs_human'));
  }

  return (
    <div className="ide-app">
      <header className="ide-top">
        <strong>Operator</strong>
        <span className="muted">IDE</span>
        <div className="ide-menu" ref={menuRef}>
          <button
            type="button"
            className="btn ghost ide-mini"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => {
              setMenuOpen((open) => !open);
              setConfirmLogout(false);
            }}
          >
            Menu
          </button>
          {menuOpen ? (
            <div className="ide-menu-panel" role="menu">
              {confirmLogout ? (
                <>
                  <p className="ide-menu-note">Everything here will be lost</p>
                  <button
                    type="button"
                    role="menuitem"
                    className="btn danger ide-mini"
                    disabled={busy}
                    onClick={onLogout}
                  >
                    Logout
                  </button>
                  <button
                    type="button"
                    className="btn ghost ide-mini"
                    disabled={busy}
                    onClick={() => setConfirmLogout(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <Link
                    to="/tutorial"
                    role="menuitem"
                    className="ide-menu-item"
                    style={{ textDecoration: 'none' }}
                    onClick={() => setMenuOpen(false)}
                  >
                    Tutorial &amp; Guide
                  </Link>
                  <button
                    type="button"
                    role="menuitem"
                    className="ide-menu-item"
                    onClick={() => setConfirmLogout(true)}
                  >
                    Logout
                  </button>
                </>
              )}
            </div>
          ) : null}
        </div>
      </header>
      <SplitPane
        direction="row"
        ratio={leftRatio}
        min={22}
        max={48}
        onRatio={setLeftRatio}
        label="Resize side panels and editor"
        first={
          <SplitPane
            direction="column"
            ratio={sideRatio}
            min={28}
            max={78}
            onRatio={setSideRatio}
            label="Resize agent and test cases"
            first={
              <AgentPane
                mode={mode}
                phase={agentPhase}
                step={agentStep}
                attempt={agentAttempt}
                maxAttempts={agentMaxAttempts}
                title={agentTitle}
                entry={agentEntry}
                signature={agentSignature}
                cases={cases}
                configured={agentReady}
                messages={messages}
                incomingFiles={incomingFiles}
                onClearIncoming={() => setIncomingFiles([])}
                onMode={setMode}
                onSend={(text, image) => {
                  void send(text, image);
                }}
                onAction={guide}
              />
            }
            second={
              <TestsPane
                cases={cases}
                activeId={activeCaseId}
                onSelect={setActiveCaseId}
                onAdd={() => {
                  const id = nextId('case');
                  setCases((prev) => [...prev, { id, input: '', expected: '', actual: '', status: 'idle' }]);
                  setActiveCaseId(id);
                }}
                onRemove={(id) => {
                  const remaining = cases.filter((item) => item.id !== id);
                  if (remaining.length === 0 || remaining.length === cases.length) return;
                  setCases(remaining);
                  if (activeCaseId === id) setActiveCaseId(remaining[0].id);
                }}
                onChange={(id, patch) => {
                  setCases((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch, status: 'idle', actual: '' } : item)));
                }}
              />
            }
          />
        }
        second={
          <SplitPane
            direction="column"
            ratio={editorRatio}
            min={32}
            max={82}
            onRatio={setEditorRatio}
            label="Resize editor and terminal"
            first={
              <EditorPane
                tabs={tabs}
                activeId={activeTabId}
                onSelect={setActiveTabId}
                onChange={updateTab}
                onReorder={reorder}
                onAdd={addTab}
                onClose={closeTab}
                onRun={() => {
                  void run('program');
                }}
                onTest={() => {
                  void run('tests');
                }}
                running={running}
                view={editorView}
                keepStreamWarm={bottomTab === 'camera'}
                streamSuspended={streamStopped}
                onView={showView}
                stream={cameraStream}
                reconnectSeq={streamReconnectSeq}
                continuous={hidContinuous}
                onHidKey={(phase, code) => hidSend.current(phase, code)}
                liveMode={liveMode}
                onLive={enterLive}
                onLeaveLive={leaveLive}
                onSnap={snap}
                onBindVideoGrabber={bindVideoGrabber}
                sendFrame={hid.sendFrame}
                snapNote={snapNote}
                onClearNote={() => setSnapNote('')}
                hidPlay={hidPlay}
              />
            }
            second={
              <TerminalPane
                output={output}
                tab={bottomTab}
                onTab={setBottomTab}
                stream={cameraStream}
                onStream={setCameraStream}
                onOpenStream={() => {
                  void resumeStream(true);
                }}
                onStopStream={stopStream}
                streamStopped={streamStopped}
                onSnap={snap}
                continuous={hidContinuous}
                liveMode={liveMode}
                onContinuous={(enabled) => {
                  if (enabled) setLiveMode(null);
                  setHidContinuous(enabled);
                }}
                source={(tabs.find((tab) => tab.id === activeTabId) ?? tabs[0])?.value ?? ''}
                fileName={(tabs.find((tab) => tab.id === activeTabId) ?? tabs[0])?.name ?? 'main.cpp'}
                onSender={bindHid}
                onPlay={setHidPlay}
                hidStatus={hid.status}
                socketOpen={hid.socketOpen}
                hidLog={hid.log}
                pushLog={hid.pushLog}
                sendFrame={hid.sendFrame}
              />
            }
          />
        }
      />
    </div>
  );
}
