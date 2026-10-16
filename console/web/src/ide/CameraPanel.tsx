import { useEffect, useState } from 'react';

type Check = { name: string; ok: boolean; detail: string };

type CameraStatus = {
  bridge: 'online' | 'offline';
  phase: string;
  attempt: number;
  detail: string;
  checks: Check[];
  video: 'wanted' | 'off';
  cameraVideo: 'off' | 'starting' | 'on';
  ingest: boolean;
  stream: 2 | 3;
  last: { name: string; ok: boolean; detail: string } | null;
};

type CommandResult = {
  ok?: boolean;
  detail?: string;
  body?: Record<string, unknown> | null;
  error?: string;
};

type AlarmForm = {
  sensitivity: number;
  goptime: number;
  audio: number;
  putalarm: number;
  osd: number;
  flag: number;
  starttime: string;
  endtime: string;
  twotime: string;
  twoend: string;
};

type LedForm = {
  control: number;
  flag: number;
  starttime: string;
  endtime: string;
  twotime: string;
  twoend: string;
};

const EMPTY_ALARM: AlarmForm = {
  sensitivity: 0,
  goptime: 30,
  audio: 0,
  putalarm: 0,
  osd: 1,
  flag: 1,
  starttime: '00:00',
  endtime: '15:00',
  twotime: '00:00',
  twoend: '00:00',
};

const EMPTY_LED: LedForm = {
  control: 0,
  flag: 1,
  starttime: '01:00',
  endtime: '11:00',
  twotime: '00:00',
  twoend: '00:00',
};

type Props = {
  active: boolean;
  stream: 2 | 3;
  onStream: (stream: 2 | 3) => void;
  onOpenStream: () => void;
  onStopStream: () => Promise<string>;
  streamStopped: boolean;
  onSnap: (kind: 'frame' | 'agent', target?: 'agent' | 'save', resetFirst?: boolean) => Promise<string>;
};

export function CameraPanel({ active, stream, onStream, onOpenStream, onStopStream, streamStopped, onSnap }: Props) {
  const [status, setStatus] = useState<CameraStatus | null>(null);
  const [output, setOutput] = useState('Ready. Use the top bar to Snap Frame or Snap Agent directly into the Agent pane.');
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [resetOnCapture, setResetOnCapture] = useState(false);
  const [alarm, setAlarm] = useState<AlarmForm>(EMPTY_ALARM);
  const [led, setLed] = useState<LedForm>(EMPTY_LED);
  const [saturation, setSaturation] = useState(30);
  const [brightness, setBrightness] = useState(35);
  const [ssid, setSsid] = useState('');
  const [wifiPwd, setWifiPwd] = useState('');
  const [nextPwd, setNextPwd] = useState('');
  const [networks, setNetworks] = useState<{ ssid: string; sig?: number }[]>([]);

  useEffect(() => {
    if (!active) return;
    let stop = false;
    const pull = async () => {
      try {
        const res = await fetch('/api/camera', { credentials: 'same-origin' });
        if (!res.ok || stop) return;
        const body = (await res.json()) as CameraStatus;
        if (!stop) setStatus(body);
      } catch {
        if (!stop) setStatus(null);
      }
    };
    void pull();
    const timer = window.setInterval(() => void pull(), 2000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [active]);

  const run = async (name: string, args?: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await fetch('/api/camera/command', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args: args ?? {} }),
      });
      const body = (await res.json()) as CommandResult;
      if (!res.ok) {
        setOutput(body.error || `Command failed (${res.status})`);
        return null;
      }
      const text = body.body ? JSON.stringify(body.body, null, 2) : body.detail || (body.ok ? 'Done' : 'Failed');
      setOutput(text);
      return body;
    } catch {
      setOutput('Command failed');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const readPicture = async () => {
    const result = await run('GetDevVideoInfo');
    if (!result?.body) return;
    if (typeof result.body.saturation === 'number') setSaturation(result.body.saturation);
    if (typeof result.body.brightness === 'number') setBrightness(result.body.brightness);
  };

  const readAlarm = async () => {
    const result = await run('GetAlarmInfo');
    if (!result?.body) return;
    setAlarm((prev) => fill(prev, result.body));
  };

  const readLed = async () => {
    const result = await run('GetLedInfo');
    if (!result?.body) return;
    setLed((prev) => fill(prev, result.body));
  };

  const scan = async () => {
    const result = await run('searchWiFiList');
    const value = result?.body?.value;
    if (!Array.isArray(value)) return;
    setNetworks(
      value
        .filter((item): item is { ssid?: string; sig?: number } => Boolean(item) && typeof item === 'object')
        .map((item) => ({ ssid: typeof item.ssid === 'string' ? item.ssid : '', sig: item.sig }))
        .filter((item) => item.ssid),
    );
  };

  async function runSnap(kind: 'frame' | 'agent', target: 'agent' | 'save') {
    if (capturing) return;
    const key = `${kind}-${target}`;
    setCapturing(key);
    try {
      const shouldReset = target === 'agent' && resetOnCapture;
      const msg = await onSnap(kind, target, shouldReset);
      setOutput(msg);
      if (shouldReset && !msg.toLowerCase().includes('failed')) {
        setResetOnCapture(false);
      }
    } finally {
      setCapturing(null);
    }
  }

  const bridgeOnline = status?.bridge === 'online';
  const cameraOn = status?.cameraVideo === 'on';
  const ingestOn = Boolean(status?.ingest);

  return (
    <aside className="ide-cam">
      <section className="ide-cam-card" aria-label="Snap Frame and Snap Agent">
        <div className="ide-hid-head">
          <strong className="ide-cam-card-title">Capture & Send Directly to Agent</strong>
          <label className="ide-check" title="Reset Agent problem before attaching the next capture">
            <input
              type="checkbox"
              checked={resetOnCapture}
              onChange={(event) => setResetOnCapture(event.target.checked)}
            />
            Start new problem on capture
          </label>
        </div>
        <div className="ide-cam-actions" style={{ marginBottom: 0 }}>
          <button
            type="button"
            className="btn primary ide-mini"
            disabled={capturing !== null}
            onClick={() => void runSnap('frame', 'agent')}
            title="Grab still frame from live stream / RTSP and attach directly to Agent pane"
          >
            {capturing === 'frame-agent' ? 'Snapping Frame…' : '+ Snap Frame → Agent'}
          </button>
          <button
            type="button"
            className="btn primary ide-mini"
            disabled={capturing !== null}
            onClick={() => void runSnap('agent', 'agent')}
            title="Trigger remote Capture Agent still photo and attach directly to Agent pane"
          >
            {capturing === 'agent-agent' ? 'Snapping Agent…' : '+ Snap Agent → Agent'}
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={capturing !== null}
            onClick={() => void runSnap('frame', 'save')}
            title="Download live stream / RTSP frame to disk"
          >
            {capturing === 'frame-save' ? 'Saving…' : 'Snap Frame (Save Local)'}
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={capturing !== null}
            onClick={() => void runSnap('agent', 'save')}
            title="Download remote Capture Agent photo to disk"
          >
            {capturing === 'agent-save' ? 'Saving…' : 'Snap Agent (Save Local)'}
          </button>
        </div>
      </section>

      <div className="ide-cam-grid">
        <section className="ide-cam-card" aria-label="Connection and Recovery">
          <div className="ide-hid-head">
            <span className={`ide-hid-badge${bridgeOnline && ingestOn ? ' ok' : ''}`}>
              <span className="ide-hid-dot" aria-hidden="true" />
              {bridgeOnline ? (ingestOn ? 'Streaming Live' : status?.phase || 'Bridge Online') : 'Bridge Offline'}
            </span>
            <span className="ide-hid-stat">Attempt {status?.attempt ?? 0}</span>
          </div>
          <div className="ide-hid-pills">
            <span className={`ide-hid-pill${bridgeOnline ? ' ok' : ''}`}>
              Bridge {bridgeOnline ? 'online' : 'offline'}
            </span>
            <span className={`ide-hid-pill${cameraOn ? ' ok' : ''}`}>
              Camera {status?.cameraVideo ?? 'off'}
            </span>
            <span className={`ide-hid-pill${ingestOn ? ' ok' : ''}`}>
              Ingest {ingestOn ? 'publishing' : 'idle'}
            </span>
            {(status?.checks ?? []).map((check) => (
              <span key={check.name} className={`ide-hid-pill${check.ok ? ' ok' : ''}`} title={check.detail}>
                {check.name}: {check.detail || (check.ok ? 'ok' : 'wait')}
              </span>
            ))}
          </div>
          <div className="ide-cam-tier">
            <span className="ide-hid-label">Reconnect & Recovery</span>
            <div className="ide-cam-actions" style={{ marginBottom: 0 }}>
              <button
                type="button"
                className="btn primary ide-mini"
                onClick={onOpenStream}
                title="Open the Stream tab and reconnect WebRTC player"
              >
                1. Open / Reconnect Stream
              </button>
              <button
                type="button"
                className="btn danger ide-mini"
                disabled={stopping || streamStopped}
                onClick={() => {
                  setStopping(true);
                  void onStopStream()
                    .then((message) => setOutput(message))
                    .finally(() => setStopping(false));
                }}
                title="Stop the camera video and the player"
              >
                {stopping ? 'Stopping…' : 'Stop stream'}
              </button>
              <button
                type="button"
                className="btn ghost ide-mini"
                onClick={() => onStream(stream === 2 ? 3 : 2)}
                title="Switch between Stream 2 and Stream 3"
              >
                2. Stream {stream} → {stream === 2 ? 3 : 2}
              </button>
              <button
                type="button"
                className="btn ghost ide-mini"
                disabled={busy}
                onClick={() => void run('reconnect')}
                title="Tell camera bridge to reset UDP session and rebind socket"
              >
                3. Recover Bridge
              </button>
              <button
                type="button"
                className="btn ghost ide-mini"
                disabled={busy}
                onClick={() => void run('restart')}
                title="Stop and start the Android bridge engine cleanly (full reset)"
              >
                4. Stop & Start Bridge
              </button>
            </div>
          </div>
        </section>

        <section className="ide-cam-card" aria-label="Orientation and Brightness">
          <div className="ide-hid-head">
            <strong className="ide-cam-card-title">Orientation & Picture</strong>
            <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void readPicture()}>
              Read current
            </button>
          </div>
          <div className="ide-cam-tier">
            <span className="ide-hid-label">Flip Camera (Primary)</span>
            <div className="ide-cam-actions">
              <button
                type="button"
                className="btn primary ide-mini"
                disabled={busy}
                onClick={() => void run('LevelFlip')}
              >
                Flip Horizontal (Mirror)
              </button>
              <button
                type="button"
                className="btn primary ide-mini"
                disabled={busy}
                onClick={() => void run('VerticalFlip')}
              >
                Flip Vertical (Upside-Down)
              </button>
            </div>
          </div>
          <div className="ide-hid-sliders">
            <label className="ide-cam-field">
              <span>
                Brightness <strong>{brightness}</strong>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={brightness}
                disabled={busy}
                onChange={(event) => setBrightness(Number(event.target.value))}
              />
            </label>
            <label className="ide-cam-field">
              <span>
                Saturation <strong>{saturation}</strong>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={saturation}
                disabled={busy}
                onChange={(event) => setSaturation(Number(event.target.value))}
              />
            </label>
          </div>
          <div className="ide-cam-actions" style={{ marginBottom: 0 }}>
            {[20, 40, 60, 80].map((preset) => (
              <button
                key={preset}
                type="button"
                className="btn ghost ide-mini"
                disabled={busy}
                onClick={() => {
                  setBrightness(preset);
                  void run('SetDevVideoInfo', { brightness: preset, saturation });
                }}
              >
                Bright {preset}%
              </button>
            ))}
            <button
              type="button"
              className="btn primary ide-mini"
              disabled={busy}
              onClick={() => void run('SetDevVideoInfo', { saturation, brightness })}
            >
              Apply Picture
            </button>
          </div>
        </section>
      </div>

      <details className="ide-cam-advanced">
        <summary>Diagnostics, LED, Alarm & Wi-Fi (Advanced)</summary>
        <div className="ide-cam-actions" style={{ marginTop: '0.5rem' }}>
          <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('GetDevInfo')}>
            Device Info
          </button>
          <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('GetDevStream')}>
            Stream Info
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={busy}
            onClick={() => void run('SetLed', { ledstatus: 1 })}
          >
            LED On
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={busy}
            onClick={() => void run('SetLed', { ledstatus: 0 })}
          >
            LED Off
          </button>
        </div>
        <details>
          <summary>Alarm</summary>
          <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void readAlarm()}>
            Read alarm
          </button>
          <ClockFields value={alarm} onChange={setAlarm} />
          <label className="ide-cam-field">
            Sensitivity
            <input
              type="number"
              min={0}
              max={10}
              value={alarm.sensitivity}
              onChange={(event) => setAlarm({ ...alarm, sensitivity: Number(event.target.value) })}
            />
          </label>
          <label className="ide-cam-field">
            GOP
            <input
              type="number"
              min={1}
              max={120}
              value={alarm.goptime}
              onChange={(event) => setAlarm({ ...alarm, goptime: Number(event.target.value) })}
            />
          </label>
          <Bit label="Audio" value={alarm.audio} onChange={(audio) => setAlarm({ ...alarm, audio })} />
          <Bit label="Push" value={alarm.putalarm} onChange={(putalarm) => setAlarm({ ...alarm, putalarm })} />
          <Bit label="OSD" value={alarm.osd} onChange={(osd) => setAlarm({ ...alarm, osd })} />
          <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('SetAlarmInfo', alarm)}>
            Save alarm
          </button>
        </details>
        <details>
          <summary>LED schedule</summary>
          <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void readLed()}>
            Read schedule
          </button>
          <Bit label="Control" value={led.control} onChange={(control) => setLed({ ...led, control })} />
          <ClockFields value={led} onChange={setLed} />
          <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void run('SetLedInfo', led)}>
            Save schedule
          </button>
        </details>
        <details>
          <summary>Wi-Fi</summary>
          <p className="ide-cam-sub">Joining a network takes the camera off its access point.</p>
          <button type="button" className="btn ghost ide-mini" disabled={busy} onClick={() => void scan()}>
            Scan
          </button>
          <ul className="ide-cam-nets">
            {networks.map((network) => (
              <li key={network.ssid}>
                <button type="button" className="btn ghost ide-mini" onClick={() => setSsid(network.ssid)}>
                  {network.ssid}
                  {typeof network.sig === 'number' ? ` (${network.sig})` : ''}
                </button>
              </li>
            ))}
          </ul>
          <label className="ide-cam-field">
            Name
            <input value={ssid} maxLength={32} autoComplete="off" onChange={(event) => setSsid(event.target.value)} />
          </label>
          <label className="ide-cam-field">
            Password
            <input
              type="password"
              value={wifiPwd}
              maxLength={64}
              autoComplete="off"
              onChange={(event) => setWifiPwd(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={busy || !ssid}
            onClick={() => void run('OpenWifi', { sid: ssid, wifiPwd })}
          >
            Join network
          </button>
        </details>
        <details>
          <summary>Device password</summary>
          <label className="ide-cam-field">
            New password
            <input
              type="password"
              value={nextPwd}
              maxLength={64}
              autoComplete="new-password"
              onChange={(event) => setNextPwd(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={busy || !nextPwd}
            onClick={() => void run('ModifyPwd', { newpwd: nextPwd })}
          >
            Change password
          </button>
        </details>
      </details>

      <pre className="ide-cam-out">{output}</pre>
    </aside>
  );
}

function Bit({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="ide-cam-field">
      {label}
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        <option value={0}>0</option>
        <option value={1}>1</option>
      </select>
    </label>
  );
}

function ClockFields<T extends { starttime: string; endtime: string; twotime: string; twoend: string; flag: number }>({
  value,
  onChange,
}: {
  value: T;
  onChange: (value: T) => void;
}) {
  const set = (key: 'starttime' | 'endtime' | 'twotime' | 'twoend', next: string) => onChange({ ...value, [key]: next });
  return (
    <>
      <label className="ide-cam-field">
        From
        <input value={value.starttime} onChange={(event) => set('starttime', event.target.value)} />
      </label>
      <label className="ide-cam-field">
        Until
        <input value={value.endtime} onChange={(event) => set('endtime', event.target.value)} />
      </label>
      <label className="ide-cam-field">
        Second from
        <input value={value.twotime} onChange={(event) => set('twotime', event.target.value)} />
      </label>
      <label className="ide-cam-field">
        Second until
        <input value={value.twoend} onChange={(event) => set('twoend', event.target.value)} />
      </label>
      <Bit label="Flag" value={value.flag} onChange={(flag) => onChange({ ...value, flag })} />
    </>
  );
}

function fill<T extends Record<string, string | number>>(prev: T, body: Record<string, unknown> | null | undefined): T {
  if (!body) return prev;
  const next: Record<string, string | number> = { ...prev };
  for (const key of Object.keys(prev)) {
    const value = body[key];
    if (typeof prev[key] === 'number' && typeof value === 'number') next[key] = value;
    if (typeof prev[key] === 'string' && typeof value === 'string') next[key] = value;
  }
  return next as T;
}
