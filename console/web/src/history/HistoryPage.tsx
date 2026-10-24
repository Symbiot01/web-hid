import Editor from '@monaco-editor/react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import '../ide/monacoSetup.ts';
import {
  languageForFile,
  PROBLEM_TYPE_LABELS,
  type AgentKind,
  type ProblemType,
  type TestReason,
  type TestStatus,
} from '../ide/types.ts';
import './history.css';

type HistorySummary = {
  id: string;
  title: string;
  problemType: ProblemType;
  fileName: string;
  entry: string;
  signature: string;
  format: string;
  phase: string;
  statementPreview: string;
  approach: string;
  passCount: number;
  caseCount: number;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

type HistoryDetail = {
  id: string;
  title: string;
  problemType: ProblemType;
  fileName: string;
  entry: string;
  signature: string;
  format: string;
  phase: string;
  statement: string;
  approach: string;
  source: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string; kind?: AgentKind }>;
  cases: Array<{
    input: string;
    expected: string;
    actual: string;
    stderr?: string;
    reason?: TestReason;
    timeMs?: number;
    status: TestStatus;
  }>;
  output: string;
  passCount: number;
  caseCount: number;
  createdAt: number;
  updatedAt: number;
};

const TYPE_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'cpp', label: 'C++17' },
  { key: 'python', label: 'Python' },
  { key: 'sql', label: 'SQL' },
  { key: 'bash', label: 'Bash' },
  { key: 'dockerfile', label: 'Docker' },
  { key: 'yaml', label: 'YAML' },
  { key: 'javascript', label: 'JS' },
];

type DetailTab = 'overview' | 'code' | 'chat' | 'cases';

function formatTimestamp(ms: number): string {
  if (!ms) return '';
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function HistoryPage() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [items, setItems] = useState<HistorySummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [openingIde, setOpeningIde] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/session', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok) {
          navigate('/', { replace: true });
          return;
        }
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) navigate('/', { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const fetchList = useCallback(async (search: string, domain: string) => {
    setLoadingList(true);
    setErrorMsg('');
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set('q', search.trim());
      if (domain && domain !== 'all') params.set('type', domain);
      params.set('limit', '80');
      const res = await fetch(`/api/history?${params.toString()}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        setErrorMsg('Could not load history');
        return;
      }
      const data = (await res.json()) as { total: number; items: HistorySummary[] };
      setItems(data.items || []);
      setTotal(data.total || 0);
      setSelectedId((prev) => {
        if (prev && data.items.some((item) => item.id === prev)) return prev;
        return data.items[0]?.id ?? null;
      });
    } catch {
      setErrorMsg('Network error loading history');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      void fetchList(query, typeFilter);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [ready, query, typeFilter, fetchList]);

  useEffect(() => {
    if (!ready || !selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    fetch(`/api/history/${encodeURIComponent(selectedId)}`, {
      credentials: 'same-origin',
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((payload: HistoryDetail | null) => {
        if (!cancelled) setDetail(payload);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, selectedId]);

  async function handleOpenInIde() {
    if (!detail || openingIde) return;
    setOpeningIde(true);
    setErrorMsg('');
    try {
      const res = await fetch(`/api/history/${encodeURIComponent(detail.id)}/open`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(body.error || 'Could not restore problem into IDE');
        return;
      }
      navigate('/app');
    } catch {
      setErrorMsg('Could not restore problem into IDE');
    } finally {
      setOpeningIde(false);
    }
  }

  async function handleDelete(id: string) {
    try {
      const res = await fetch(`/api/history/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!res.ok) return;
      void fetchList(query, typeFilter);
    } catch {
      // ignore
    }
  }

  function handleCopyCode() {
    if (!detail?.source || !navigator.clipboard) return;
    void navigator.clipboard.writeText(detail.source).then(() => {
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1400);
    });
  }

  if (!ready) {
    return (
      <main className="ide-app">
        <p className="muted ide-check">Checking session</p>
      </main>
    );
  }

  return (
    <div className="hist-page">
      <header className="hist-topbar">
        <div className="hist-brand">
          <span className="hist-brand-title">Operator Console · Solved Questions &amp; Chat History</span>
          <span className="hist-badge">{total} saved</span>
        </div>
        <div className="hist-top-actions">
          <Link to="/tutorial" className="btn ghost ide-mini" style={{ textDecoration: 'none' }}>
            Tutorial
          </Link>
          <Link to="/app" className="btn primary ide-mini" style={{ textDecoration: 'none' }}>
            Back to IDE
          </Link>
        </div>
      </header>

      <div className="hist-layout">
        <aside className="hist-sidebar" aria-label="Saved problems list">
          <div className="hist-filters">
            <input
              type="search"
              className="hist-search"
              placeholder="Search title, statement, file, or plan…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search solved problems"
            />
            <div className="hist-type-pills" role="tablist" aria-label="Filter by problem domain">
              {TYPE_FILTERS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  role="tab"
                  aria-selected={typeFilter === item.key}
                  className={`hist-type-pill${typeFilter === item.key ? ' active' : ''}`}
                  onClick={() => setTypeFilter(item.key)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {loadingList && items.length === 0 ? (
            <div className="hist-empty">Loading history…</div>
          ) : items.length === 0 ? (
            <div className="hist-empty">
              No solved problems match your filter yet. Solve a problem in the IDE to see it archived here automatically.
            </div>
          ) : (
            <ul className="hist-list">
              {items.map((item) => {
                const isSelected = item.id === selectedId;
                const badgeLabel = PROBLEM_TYPE_LABELS[item.problemType] || item.problemType;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`hist-item${isSelected ? ' active' : ''}`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      <div className="hist-item-top">
                        <span className="hist-item-title">{item.title || 'Untitled Problem'}</span>
                        <span className={`hist-badge${item.phase === 'solved' ? ' hist-badge-ok' : ''}`}>
                          {badgeLabel}
                        </span>
                      </div>
                      <p className="hist-item-preview">{item.statementPreview}</p>
                      <div className="hist-item-meta">
                        <code>{item.fileName}</code>
                        <span>·</span>
                        <span>
                          {item.passCount}/{item.caseCount} pass
                        </span>
                        <span>·</span>
                        <span>{item.messageCount} msgs</span>
                        <span>·</span>
                        <span>{formatTimestamp(item.updatedAt)}</span>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>

        <main className="hist-detail" aria-label="Selected problem details">
          {errorMsg ? (
            <div className="hist-card" style={{ margin: '1rem', borderColor: 'var(--danger)' }}>
              {errorMsg}
            </div>
          ) : null}

          {!selectedId ? (
            <div className="hist-empty">Select a question on the left to inspect its statement, solution, cases, and chat transcript.</div>
          ) : loadingDetail || !detail ? (
            <div className="hist-empty">Loading problem details…</div>
          ) : (
            <>
              <div className="hist-detail-header">
                <div>
                  <h1 className="hist-detail-title">{detail.title || 'Untitled Problem'}</h1>
                  <div className="hist-detail-chips">
                    <span className={`hist-badge${detail.phase === 'solved' ? ' hist-badge-ok' : ' hist-badge-warn'}`}>
                      {detail.phase === 'solved' ? 'Solved' : detail.phase}
                    </span>
                    <span className="hist-badge">
                      {PROBLEM_TYPE_LABELS[detail.problemType] || detail.problemType} · {detail.fileName}
                    </span>
                    {detail.signature ? <code className="ide-meta-chip">{detail.signature}</code> : null}
                    <span className="ide-meta-chip">
                      {detail.passCount}/{detail.caseCount} cases passed
                    </span>
                    <span className="muted" style={{ fontSize: '0.75rem' }}>
                      Updated {formatTimestamp(detail.updatedAt)}
                    </span>
                  </div>
                </div>
                <div className="hist-detail-actions">
                  <button
                    type="button"
                    className="btn ghost ide-mini"
                    onClick={handleCopyCode}
                  >
                    {copiedCode ? 'Copied!' : 'Copy Code'}
                  </button>
                  <button
                    type="button"
                    className="btn primary ide-mini"
                    disabled={openingIde}
                    onClick={() => void handleOpenInIde()}
                  >
                    {openingIde ? 'Opening…' : 'Open in IDE'}
                  </button>
                  <button
                    type="button"
                    className="btn danger ide-mini"
                    onClick={() => void handleDelete(detail.id)}
                  >
                    Delete
                  </button>
                </div>
              </div>

              <div className="hist-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'overview'}
                  className={`ide-tab${activeTab === 'overview' ? ' active' : ''}`}
                  onClick={() => setActiveTab('overview')}
                >
                  Overview &amp; Solution
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'code'}
                  className={`ide-tab${activeTab === 'code' ? ' active' : ''}`}
                  onClick={() => setActiveTab('code')}
                >
                  Code ({detail.fileName})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'chat'}
                  className={`ide-tab${activeTab === 'chat' ? ' active' : ''}`}
                  onClick={() => setActiveTab('chat')}
                >
                  Chat Transcript ({detail.messages.length})
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'cases'}
                  className={`ide-tab${activeTab === 'cases' ? ' active' : ''}`}
                  onClick={() => setActiveTab('cases')}
                >
                  Verification Cases ({detail.passCount}/{detail.caseCount})
                </button>
              </div>

              <div className="hist-body">
                {activeTab === 'overview' ? (
                  <>
                    <section className="hist-card">
                      <h3>Problem Specification</h3>
                      {detail.format ? (
                        <p className="muted" style={{ fontSize: '0.8rem', marginTop: 0 }}>
                          <strong>Format:</strong> {detail.format}
                        </p>
                      ) : null}
                      <pre className="hist-pre">{detail.statement}</pre>
                    </section>
                    {detail.approach ? (
                      <section className="hist-card">
                        <h3>Algorithm / Strategy &amp; Complexity</h3>
                        <pre className="hist-pre">{detail.approach}</pre>
                      </section>
                    ) : null}
                    <section className="hist-card" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                      <h3>Solution ({detail.fileName})</h3>
                      <div className="hist-editor-wrap">
                        <Editor
                          height="420px"
                          language={languageForFile(detail.fileName)}
                          theme="vs-dark"
                          value={detail.source}
                          options={{
                            readOnly: true,
                            minimap: { enabled: false },
                            fontSize: 13,
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            padding: { top: 8 },
                          }}
                        />
                      </div>
                    </section>
                  </>
                ) : null}

                {activeTab === 'code' ? (
                  <div className="hist-editor-wrap" style={{ height: '100%' }}>
                    <Editor
                      height="100%"
                      language={languageForFile(detail.fileName)}
                      theme="vs-dark"
                      value={detail.source}
                      options={{
                        readOnly: true,
                        minimap: { enabled: false },
                        fontSize: 13,
                        scrollBeyondLastLine: false,
                        automaticLayout: true,
                        padding: { top: 8 },
                      }}
                    />
                  </div>
                ) : null}

                {activeTab === 'chat' ? (
                  <section className="hist-card">
                    <h3>Full Conversation &amp; Agent Steps</h3>
                    <ol className="ide-feed" style={{ maxHeight: 'none', padding: 0 }}>
                      {detail.messages.map((msg, idx) => {
                        const kind = msg.kind || (msg.role === 'user' ? 'user' : 'step');
                        const label = msg.role === 'user' ? 'You' : kind === 'problem' ? 'Problem' : kind === 'plan' ? 'Plan' : 'Agent';
                        return (
                          <li key={`m-${idx}`} className={`ide-msg ide-msg-${msg.role} ide-msg-${kind}`}>
                            <span className="ide-msg-role">{label}</span>
                            <div className="ide-msg-body">
                              <pre className="hist-pre">{msg.text}</pre>
                            </div>
                          </li>
                        );
                      })}
                    </ol>
                  </section>
                ) : null}

                {activeTab === 'cases' ? (
                  <>
                    <div className="hist-cases-grid">
                      {detail.cases.map((c, idx) => (
                        <div key={`case-${idx}`} className="hist-case-card">
                          <div className="hist-case-head">
                            <span>Case #{idx + 1}</span>
                            <span className={`hist-badge${c.status === 'pass' ? ' hist-badge-ok' : ' hist-badge-warn'}`}>
                              {c.status}
                              {c.timeMs ? ` · ${c.timeMs}ms` : ''}
                            </span>
                          </div>
                          <div>
                            <span className="muted" style={{ fontSize: '0.72rem' }}>Input / Scenario</span>
                            <pre className="hist-pre">{c.input || '(empty)'}</pre>
                          </div>
                          <div>
                            <span className="muted" style={{ fontSize: '0.72rem' }}>Expected</span>
                            <pre className="hist-pre">{c.expected || '(empty)'}</pre>
                          </div>
                          {c.actual ? (
                            <div>
                              <span className="muted" style={{ fontSize: '0.72rem' }}>Actual / Verified</span>
                              <pre className="hist-pre">{c.actual}</pre>
                            </div>
                          ) : null}
                          {c.stderr ? (
                            <div>
                              <span className="muted" style={{ fontSize: '0.72rem' }}>Notes / Stderr</span>
                              <pre className="hist-pre">{c.stderr}</pre>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                    {detail.output ? (
                      <section className="hist-card">
                        <h3>Compiler / Checker Output</h3>
                        <pre className="hist-pre">{detail.output}</pre>
                      </section>
                    ) : null}
                  </>
                ) : null}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
