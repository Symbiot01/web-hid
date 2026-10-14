import { useEffect, useRef, useState } from 'react';
import { isTypingCode, keyFrame, mouseFrame } from './hidKeys.ts';
import type { LiveMode } from './useHidLink.ts';
import { startWhep, type WhepSession } from './whep.ts';

type Status = 'connecting' | 'live' | 'offline';

const RETRY_MS = [3000, 8000, 15000];

type Props = {
  active: boolean;
  stream: 2 | 3;
  onStream: (stream: 2 | 3) => void;
  liveMode: LiveMode | null;
  onLive: (mode: LiveMode) => void;
  onLeave: () => void;
  sendFrame: (buf: ArrayBuffer | null) => boolean;
  onAttachAgent: (file: File, resetFirst: boolean) => void;
};

export function StreamPane({
  active,
  stream,
  onStream,
  liveMode,
  onLive,
  onLeave,
  sendFrame,
  onAttachAgent,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>('offline');
  const [detail, setDetail] = useState('No signal');
  const [nonce, setNonce] = useState(0);
  const [busyCmd, setBusyCmd] = useState(false);
  const [capturing, setCapturing] = useState<'save' | 'agent' | null>(null);
  const [brightness, setBrightness] = useState(35);
  const [showPicture, setShowPicture] = useState(false);
  const [resetOnCapture, setResetOnCapture] = useState(false);
  const [capturedCount, setCapturedCount] = useState(0);
  const [note, setNote] = useState('');
  const stageRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef(stream);
  const liveRef = useRef(liveMode);
  const sendRef = useRef(sendFrame);
  streamRef.current = stream;
  liveRef.current = liveMode;
  sendRef.current = sendFrame;

  useEffect(() => {
    if (!active) return;
    const id = crypto.randomUUID();
    let stop = false;
    const beat = () => {
      if (stop) return;
      void fetch('/api/camera/watch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, stream: streamRef.current }),
      }).catch(() => undefined);
    };
    beat();
    const timer = window.setInterval(beat, 4000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [active, stream]);

  useEffect(() => {
    if (!active) {
      setStatus('offline');
      setDetail('No signal');
      return;
    }

    const video = videoRef.current;
    const mediaStream = new MediaStream();
    let session: WhepSession | null = null;
    let timer = 0;
    let stopped = false;
    let retry = 0;

    const schedule = () => {
      if (stopped) return;
      const delay = RETRY_MS[Math.min(retry, RETRY_MS.length - 1)];
      retry += 1;
      timer = window.setTimeout(() => {
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (stopped) return;
      setStatus('connecting');
      setDetail('Connecting…');
      try {
        const next = await startWhep((event) => {
          if (stopped || mediaStream.getTracks().some((track) => track.id === event.track.id)) return;
          mediaStream.addTrack(event.track);
          if (video && video.srcObject !== mediaStream) {
            video.srcObject = mediaStream;
            void video.play().catch(() => undefined);
          }
        });
        if (stopped) {
          await next.stop();
          return;
        }
        session = next;
        const onState = () => {
          if (stopped || session !== next) return;
          const state = next.pc.connectionState;
          if (state === 'connected') {
            retry = 0;
            setStatus('live');
            setDetail(`Live · Stream ${streamRef.current}`);
            return;
          }
          if (state === 'disconnected') {
            window.setTimeout(() => {
              if (stopped || session !== next) return;
              if (next.pc.connectionState === 'connected' || next.pc.connectionState === 'connecting') return;
              next.pc.removeEventListener('connectionstatechange', onState);
              setStatus('offline');
              setDetail('No signal');
              void next.stop();
              session = null;
              schedule();
            }, 2000);
            return;
          }
          if (state !== 'failed') return;
          setStatus('offline');
          setDetail('No signal');
          next.pc.removeEventListener('connectionstatechange', onState);
          void next.stop();
          if (session === next) session = null;
          schedule();
        };
        next.pc.addEventListener('connectionstatechange', onState);
        if (next.pc.connectionState === 'connected') onState();
      } catch (error) {
        if (stopped) return;
        setStatus('offline');
        setDetail(error instanceof Error ? error.message : 'No signal');
        schedule();
      }
    };

    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (video) video.srcObject = null;
      for (const track of mediaStream.getTracks()) track.stop();
      void session?.stop();
    };
  }, [active, nonce]);

  useEffect(() => {
    if (!active || !liveMode) return;
    const stage = stageRef.current;
    if (!stage) return;

    const sendKey = (event: KeyboardEvent, phase: 'down' | 'up') => {
      const mode = liveRef.current;
      if (!mode || event.repeat) return;
      if (mode === 'typing' && !isTypingCode(event.code)) return;
      const frame = keyFrame(phase, event.code);
      if (!frame) return;
      event.preventDefault();
      sendRef.current(frame);
    };
    const onDown = (event: KeyboardEvent) => sendKey(event, 'down');
    const onUp = (event: KeyboardEvent) => sendKey(event, 'up');
    const onMove = (event: MouseEvent) => {
      if (document.pointerLockElement !== stage) return;
      sendRef.current(mouseFrame(event.buttons & 7, event.movementX, event.movementY, 0));
    };
    const onButton = (event: MouseEvent) => {
      if (document.pointerLockElement !== stage) return;
      event.preventDefault();
      sendRef.current(mouseFrame(event.buttons & 7, 0, 0, 0));
    };
    const onWheel = (event: WheelEvent) => {
      if (document.pointerLockElement !== stage) return;
      event.preventDefault();
      const wheel = event.deltaY > 0 ? -1 : event.deltaY < 0 ? 1 : 0;
      if (wheel) sendRef.current(mouseFrame(event.buttons & 7, 0, 0, wheel));
    };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    stage.addEventListener('mousemove', onMove);
    stage.addEventListener('mousedown', onButton);
    stage.addEventListener('mouseup', onButton);
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      stage.removeEventListener('mousemove', onMove);
      stage.removeEventListener('mousedown', onButton);
      stage.removeEventListener('mouseup', onButton);
      stage.removeEventListener('wheel', onWheel);
      if (document.pointerLockElement === stage) document.exitPointerLock();
    };
  }, [active, liveMode]);

  function lockPointer() {
    const stage = stageRef.current;
    if (!liveMode || !stage || document.pointerLockElement === stage) return;
    void stage.requestPointerLock();
  }

  async function runCameraCommand(name: string, args?: Record<string, unknown>, label?: string) {
    if (busyCmd) return;
    setBusyCmd(true);
    setNote(label ? `${label}…` : `${name}…`);
    try {
      const res = await fetch('/api/camera/command', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args: args ?? {} }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; detail?: string; error?: string };
      if (!res.ok) {
        setNote(body.error || `${label || name} failed`);
        return;
      }
      setNote(body.detail || `${label || name} applied`);
      if (name === 'reconnect') {
        window.setTimeout(() => setNonce((n) => n + 1), 1200);
      }
    } catch {
      setNote(`${label || name} failed`);
    } finally {
      setBusyCmd(false);
    }
  }

  async function grabBestQualityBlob(): Promise<{ blob: Blob; sourceLabel: string } | null> {
    const video = videoRef.current;
    if (video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (blob && blob.size > 0) {
          return { blob, sourceLabel: `${canvas.width}×${canvas.height} PNG` };
        }
      }
    }
    try {
      const frameRes = await fetch('/api/capture/frame', { method: 'POST', credentials: 'same-origin' });
      if (frameRes.ok) {
        const blob = await frameRes.blob();
        if (blob.size > 0) return { blob, sourceLabel: 'RTSP JPEG' };
      }
    } catch {
      // try capture agent next
    }
    try {
      const snapRes = await fetch('/api/capture/snap', { method: 'POST', credentials: 'same-origin' });
      if (snapRes.ok) {
        const blob = await snapRes.blob();
        if (blob.size > 0) return { blob, sourceLabel: 'Agent JPEG' };
      }
    } catch {
      // return null
    }
    return null;
  }

  async function handleCapture(target: 'save' | 'agent') {
    if (capturing) return;
    setCapturing(target);
    setNote(target === 'agent' ? 'Capturing to Agent…' : 'Capturing to disk…');
    try {
      const result = await grabBestQualityBlob();
      if (!result) {
        setNote('Capture failed (no video or server frame)');
        return;
      }
      const ext = result.blob.type === 'image/png' ? 'png' : 'jpg';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19);
      const filename = `capture-${stamp}.${ext}`;
      if (target === 'save') {
        const url = URL.createObjectURL(result.blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1500);
        setNote(`Saved ${filename} (${result.sourceLabel})`);
      } else {
        const file = new File([result.blob], filename, { type: result.blob.type || 'image/png' });
        const shouldReset = resetOnCapture;
        onAttachAgent(file, shouldReset);
        if (shouldReset) {
          setResetOnCapture(false);
          setCapturedCount(1);
          setNote(`Started new problem with ${filename} (${result.sourceLabel})`);
        } else {
          const nextCount = capturedCount + 1;
          setCapturedCount(nextCount);
          setNote(`Queued #${nextCount} in Agent (${result.sourceLabel})`);
        }
      }
    } finally {
      setCapturing(null);
    }
  }

  function switchStream(nextStream: 2 | 3) {
    onStream(nextStream);
    setNote(`Switched to Stream ${nextStream}`);
    window.setTimeout(() => setNonce((n) => n + 1), 350);
  }

  return (
    <div
      ref={stageRef}
      className={`ide-stream${liveMode ? ' ide-stream-live-mode' : ''}`}
      onClick={lockPointer}
    >
      <video ref={videoRef} autoPlay playsInline muted />

      <div className="ide-stream-hud" onClick={(event) => event.stopPropagation()}>
        <div className="ide-stream-hud-group" role="group" aria-label="Capture controls">
          <button
            type="button"
            className="btn primary ide-mini"
            disabled={capturing !== null}
            onClick={() => void handleCapture('agent')}
            title="Capture lossless frame and attach to Agent pane"
          >
            {capturing === 'agent' ? 'Capturing…' : `+ Capture to Agent${capturedCount > 0 ? ` (${capturedCount})` : ''}`}
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={capturing !== null}
            onClick={() => void handleCapture('save')}
            title="Download full-resolution capture to your computer"
          >
            {capturing === 'save' ? 'Saving…' : 'Save Local'}
          </button>
          <label className="ide-stream-hud-check" title="Reset Agent problem before attaching the next capture">
            <input
              type="checkbox"
              checked={resetOnCapture}
              onChange={(event) => setResetOnCapture(event.target.checked)}
            />
            New problem
          </label>
        </div>

        <div className="ide-stream-hud-group" role="group" aria-label="Orientation and picture">
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={busyCmd}
            onClick={() => void runCameraCommand('LevelFlip', {}, 'Flip H')}
            title="Flip camera horizontally (mirror)"
          >
            Flip H
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={busyCmd}
            onClick={() => void runCameraCommand('VerticalFlip', {}, 'Flip V')}
            title="Flip camera vertically (upside down)"
          >
            Flip V
          </button>
          <button
            type="button"
            className={`btn ghost ide-mini${showPicture ? ' active' : ''}`}
            onClick={() => setShowPicture((open) => !open)}
            title="Adjust camera brightness"
          >
            Brightness ({brightness})
          </button>
        </div>

        <div className="ide-stream-hud-group" role="group" aria-label="Reconnect and recovery">
          <button
            type="button"
            className="btn ghost ide-mini"
            onClick={() => {
              setNote('Reconnecting WebRTC player…');
              setNonce((value) => value + 1);
            }}
            title="Step 1: Reconnect WebRTC video player"
          >
            Reconnect Player
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            onClick={() => switchStream(stream === 2 ? 3 : 2)}
            title="Step 2: Switch between camera Stream 2 and Stream 3"
          >
            Stream {stream} → {stream === 2 ? 3 : 2}
          </button>
          <button
            type="button"
            className="btn ghost ide-mini"
            disabled={busyCmd}
            onClick={() => void runCameraCommand('reconnect', {}, 'Recover Bridge')}
            title="Step 3: Tell camera bridge to drop and re-establish UDP session"
          >
            Recover Bridge
          </button>
          {liveMode ? (
            <button type="button" className="btn ghost ide-mini" onClick={onLeave}>
              Leave Live ({liveMode})
            </button>
          ) : (
            <button type="button" className="btn ghost ide-mini" onClick={() => onLive('typing')}>
              Live Keys
            </button>
          )}
        </div>
      </div>

      {showPicture ? (
        <div className="ide-stream-popover" onClick={(event) => event.stopPropagation()}>
          <label className="ide-stream-slider">
            <span>
              Brightness <strong>{brightness}</strong>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={brightness}
              disabled={busyCmd}
              onChange={(event) => setBrightness(Number(event.target.value))}
            />
          </label>
          <div className="ide-stream-popover-actions">
            {[20, 40, 60, 80].map((preset) => (
              <button
                key={preset}
                type="button"
                className="btn ghost ide-mini"
                disabled={busyCmd}
                onClick={() => {
                  setBrightness(preset);
                  void runCameraCommand('SetDevVideoInfo', { brightness: preset }, `Brightness ${preset}`);
                }}
              >
                {preset}%
              </button>
            ))}
            <button
              type="button"
              className="btn primary ide-mini"
              disabled={busyCmd}
              onClick={() => void runCameraCommand('SetDevVideoInfo', { brightness }, `Brightness ${brightness}`)}
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}

      <div className="ide-stream-footer" onClick={(event) => event.stopPropagation()}>
        <span className={`ide-stream-status ide-stream-${status}`}>
          <span className="ide-stream-dot" aria-hidden="true" />
          {detail}
        </span>
        {note ? <span className="ide-stream-note">{note}</span> : null}
        {liveMode ? (
          <span className="ide-stream-note">Click video to lock mouse pointer · Esc unlocks</span>
        ) : null}
      </div>
    </div>
  );
}
