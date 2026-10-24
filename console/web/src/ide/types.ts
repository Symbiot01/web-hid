export type ProblemType = 'cpp' | 'python' | 'sql' | 'bash' | 'dockerfile' | 'yaml' | 'javascript';

export type EditorTab = {
  id: string;
  name: string;
  value: string;
  dirty: boolean;
  language?: string;
};

export type TestStatus = 'idle' | 'pass' | 'fail';

export type TestReason = 'timeout' | 'output_limit' | 'runtime' | null;

export type TestCase = {
  id: string;
  input: string;
  expected: string;
  actual: string;
  stderr?: string;
  reason?: TestReason;
  timeMs?: number;
  status: TestStatus;
};

export type AgentMode = 'ask' | 'agent';

export type AgentPhase = 'idle' | 'working' | 'needs_human' | 'solved' | 'blocked';

export type AgentStep = 'idle' | 'identify' | 'cases' | 'harness' | 'solve' | 'test' | 'done';

export type AgentKind = 'user' | 'problem' | 'plan' | 'step';

export type AgentMessage = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  kind?: AgentKind;
};

export type AgentThoughtEntry = {
  id: string;
  task: string;
  label: string;
  text: string;
  draftChars?: number;
  draftPreview?: string;
  startedAt: number;
  elapsedMs: number;
  status: 'thinking' | 'drafting' | 'done' | 'error';
};

export type AgentView = {
  configured: boolean;
  problemId?: string | null;
  problemType?: ProblemType;
  fileName?: string;
  phase: AgentPhase;
  step?: AgentStep;
  attempt?: number;
  maxAttempts?: number;
  title?: string;
  entry?: string;
  signature?: string;
  format?: string;
  messages: Array<{ role: 'user' | 'assistant'; text: string; kind?: AgentKind }>;
  source: string | null;
  cases: Array<{
    id: string;
    input: string;
    expected: string;
    actual: string;
    stderr?: string;
    reason?: TestReason;
    timeMs?: number;
    status: TestStatus;
  }>;
  output: string;
  activity?: string;
  thinking?: string;
  thinkingLabel?: string;
  drafting?: string;
  draftChars?: number;
  startedAt?: number | null;
  elapsedMs?: number;
  thoughtLog?: AgentThoughtEntry[];
  running?: boolean;
};

export function languageForFile(name: string): string {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'shell';
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.ts')) return 'javascript';
  return 'cpp';
}

export function problemTypeForFile(name: string): ProblemType {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.sql')) return 'sql';
  if (lower.endsWith('.sh') || lower.endsWith('.bash')) return 'bash';
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.ts')) return 'javascript';
  return 'cpp';
}

export const PROBLEM_TYPE_LABELS: Record<ProblemType, string> = {
  cpp: 'C++17',
  python: 'Python 3',
  sql: 'SQL',
  bash: 'Bash',
  dockerfile: 'Dockerfile',
  yaml: 'YAML',
  javascript: 'JavaScript',
};

export const INITIAL_MAIN = `#include <bits/stdc++.h>
using namespace std;

void solve() {
}

int main() {
  long long t = 1;
  while (t--) {
    solve();
  }
  return 0;
}
`;
