import { CameraPanel } from './CameraPanel.tsx';
import { HidPane } from './HidPane.tsx';
import { TestsPane } from './TestsPane.tsx';
import type { HidPlay } from './hidPayload.ts';
import type { TestCase } from './types.ts';
import type { LiveMode } from './useHidLink.ts';

export type BottomTab = 'cases' | 'terminal' | 'camera' | 'hid';

type HidStatus = {
  configured?: boolean;
  deviceConnected?: boolean;
  error?: string;
};

type LogLine = { id: number; text: string };

type Props = {
  output: string;
  tab: BottomTab;
  onTab: (tab: BottomTab) => void;
  cases: TestCase[];
  activeCaseId: string;
  onSelectCase: (id: string) => void;
  onAddCase: () => void;
  onRemoveCase: (id: string) => void;
  onChangeCase: (id: string, patch: Partial<Pick<TestCase, 'input' | 'expected'>>) => void;
  streamSource: 'cam' | 'desk';
  onStreamSource: (source: 'cam' | 'desk') => void;
  stream: 2 | 3;
  onStream: (stream: 2 | 3) => void;
  onOpenStream: () => void;
  onStopStream: () => Promise<string>;
  streamStopped: boolean;
  onSnap: (kind: 'frame' | 'agent', target?: 'agent' | 'save', resetFirst?: boolean) => Promise<string>;
  continuous: boolean;
  liveMode: LiveMode | null;
  onContinuous: (enabled: boolean) => void;
  source: string;
  fileName: string;
  onSender: (send: (phase: 'down' | 'up' | 'release', code?: string) => void) => void;
  onPlay: (play: HidPlay | null) => void;
  hidStatus: HidStatus;
  socketOpen: boolean;
  hidLog: LogLine[];
  pushLog: (text: string) => void;
  sendFrame: (buf: ArrayBuffer | null) => boolean;
};

export function TerminalPane({
  output,
  tab,
  onTab,
  cases,
  activeCaseId,
  onSelectCase,
  onAddCase,
  onRemoveCase,
  onChangeCase,
  streamSource,
  onStreamSource,
  stream,
  onStream,
  onOpenStream,
  onStopStream,
  streamStopped,
  onSnap,
  continuous,
  liveMode,
  onContinuous,
  source,
  fileName,
  onSender,
  onPlay,
  hidStatus,
  socketOpen,
  hidLog,
  pushLog,
  sendFrame,
}: Props) {
  const passCount = cases.filter((item) => item.status === 'pass').length;
  const hasFail = cases.some((item) => item.status === 'fail');
  const hasRun = cases.some((item) => item.status !== 'idle');
  const overallStatus = hasFail ? 'fail' : hasRun && passCount === cases.length ? 'pass' : 'idle';

  return (
    <section className="ide-panel" aria-label="Workspace panels">
      <header className="ide-bar">
        <div className="ide-tabs" role="tablist" aria-label="Bottom panels">
          <button
            type="button"
            role="tab"
            className={`ide-tab${tab === 'cases' ? ' active' : ''}`}
            aria-selected={tab === 'cases'}
            onClick={() => onTab('cases')}
          >
            Test Cases
            <span className="ide-tab-count">
              {hasRun ? `${passCount}/${cases.length}` : cases.length}
            </span>
            <span className={`ide-dot ide-dot-${overallStatus}`} aria-hidden="true" />
          </button>
          <button
            type="button"
            role="tab"
            className={`ide-tab${tab === 'terminal' ? ' active' : ''}`}
            aria-selected={tab === 'terminal'}
            onClick={() => onTab('terminal')}
          >
            Terminal
          </button>
          <button
            type="button"
            role="tab"
            className={`ide-tab${tab === 'camera' ? ' active' : ''}`}
            aria-selected={tab === 'camera'}
            onClick={() => onTab('camera')}
          >
            Camera
          </button>
          <button
            type="button"
            role="tab"
            className={`ide-tab${tab === 'hid' ? ' active' : ''}`}
            aria-selected={tab === 'hid'}
            onClick={() => onTab('hid')}
          >
            HID
          </button>
        </div>
      </header>
      <div className={tab === 'cases' ? 'ide-fill' : 'ide-hidden'}>
        <TestsPane
          embedded
          cases={cases}
          activeId={activeCaseId}
          onSelect={onSelectCase}
          onAdd={onAddCase}
          onRemove={onRemoveCase}
          onChange={onChangeCase}
        />
      </div>
      <pre className={tab === 'terminal' ? 'ide-output' : 'ide-hidden'}>
        {output || 'Run has not produced output yet.'}
      </pre>
      <div className={tab === 'camera' ? 'ide-fill' : 'ide-hidden'}>
        <CameraPanel
          active={tab === 'camera'}
          streamSource={streamSource}
          onStreamSource={onStreamSource}
          stream={stream}
          onStream={onStream}
          onOpenStream={onOpenStream}
          onStopStream={onStopStream}
          streamStopped={streamStopped}
          onSnap={onSnap}
        />
      </div>
      <div className={tab === 'hid' ? 'ide-fill' : 'ide-hidden'}>
        <HidPane
          active={tab === 'hid'}
          continuous={continuous}
          liveMode={liveMode}
          onContinuous={onContinuous}
          source={source}
          fileName={fileName}
          onSender={onSender}
          onPlay={onPlay}
          status={hidStatus}
          socketOpen={socketOpen}
          log={hidLog}
          pushLog={pushLog}
          sendFrame={sendFrame}
        />
      </div>
    </section>
  );
}
