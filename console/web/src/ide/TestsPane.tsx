import type { TestCase } from './types.ts';

type Props = {
  cases: TestCase[];
  activeId: string;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<Pick<TestCase, 'input' | 'expected'>>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  embedded?: boolean;
};

function statusLabel(item: TestCase): string {
  if (item.reason === 'timeout') return 'Time limit';
  if (item.reason === 'output_limit') return 'Output limit';
  if (item.reason === 'runtime') return 'Runtime error';
  if (item.status === 'pass') return 'Passed';
  if (item.status === 'fail') return 'Wrong answer';
  return 'Idle';
}

export function TestsPane({
  cases,
  activeId,
  onSelect,
  onChange,
  onAdd,
  onRemove,
  embedded = false,
}: Props) {
  const active = cases.find((item) => item.id === activeId) ?? cases[0];

  const content = (
    <>
      <div className="ide-subbar">
        <div className="ide-tabs" role="tablist" aria-label="Test cases">
          {cases.map((item, index) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className={`ide-tab${item.id === active?.id ? ' active' : ''}`}
              aria-selected={item.id === active?.id}
              onClick={() => onSelect(item.id)}
            >
              Case {index + 1}
              <span className={`ide-dot ide-dot-${item.status}`} aria-hidden="true" />
            </button>
          ))}
          <button type="button" className="btn ghost ide-mini" onClick={onAdd}>
            + Add
          </button>
        </div>
        {active ? (
          <div className="ide-case-meta">
            <span className={`ide-result ide-result-${active.status}`}>{statusLabel(active)}</span>
            {typeof active.timeMs === 'number' && active.status !== 'idle' ? (
              <span className="muted ide-case-time">{active.timeMs}ms</span>
            ) : null}
            {cases.length > 1 ? (
              <button type="button" className="btn ghost ide-mini" onClick={() => onRemove(active.id)}>
                Remove
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {active ? (
        <div className="ide-case">
          <div className="ide-case-grid">
            <label className="ide-field" htmlFor="case-input">
              <span>Input (stdin)</span>
              <textarea
                id="case-input"
                rows={3}
                value={active.input}
                spellCheck={false}
                placeholder="Sample stdin…"
                onChange={(event) => onChange(active.id, { input: event.target.value })}
              />
            </label>
            <label className="ide-field" htmlFor="case-expected">
              <span>Expected (stdout)</span>
              <textarea
                id="case-expected"
                rows={3}
                value={active.expected}
                spellCheck={false}
                placeholder="Expected stdout…"
                onChange={(event) => onChange(active.id, { expected: event.target.value })}
              />
            </label>
            <label className="ide-field" htmlFor="case-actual">
              <span>Actual (stdout)</span>
              <textarea
                id="case-actual"
                rows={3}
                value={active.actual}
                readOnly
                spellCheck={false}
                placeholder="Run tests to compare…"
              />
            </label>
          </div>
          {active.stderr && active.stderr.trim() ? (
            <label className="ide-field" htmlFor="case-stderr">
              <span>Stderr</span>
              <textarea id="case-stderr" rows={2} value={active.stderr} readOnly spellCheck={false} />
            </label>
          ) : null}
        </div>
      ) : null}
    </>
  );

  if (embedded) {
    return (
      <div className="ide-fill ide-tests-embedded" aria-label="Test cases">
        {content}
      </div>
    );
  }

  return (
    <section className="ide-panel" aria-label="Test cases">
      {content}
    </section>
  );
}
