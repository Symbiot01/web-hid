export type EditorTab = {
  id: string;
  name: string;
  value: string;
  dirty: boolean;
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

export type AgentView = {
  configured: boolean;
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
  running?: boolean;
};

export const INITIAL_MAIN = `#include <bits/stdc++.h>
using namespace std;

void solve() {
}

int main() {
  ios_base::sync_with_stdio(false);
  cin.tie(nullptr);
  solve();
  return 0;
}
`;
