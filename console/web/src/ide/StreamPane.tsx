import { useEffect, useRef, useState } from 'react';
import { isTypingCode, keyFrame, mouseFrame } from './hidKeys.ts';
import type { LiveMode } from './useHidLink.ts';
import { startWhep, type WhepSession } from './whep.ts';

type Status = 'connecting' | 'live' | 'offline';

const RETRY_MS = [1000, 2000, 3500];

type Props = {
  active: boolean;
  keepWarm: boolean;
  source: 'cam' | 'desk';
  onSource: (source: 'cam' | 'desk') => void;
  stream: 2 | 3;
  reconnectSeq: number;
  liveMode: LiveMode | null;
  suspended: boolean;
  onLive: (mode: LiveMode) => void;
  onLeaveLive: () => void;
  sendFrame: (buf: ArrayBuffer | null) => boolean;
  onBindVideoGrabber: (fn: (() => Promise<Blob | null>) | null) => void;
};

type RecentKey = { id: number; label: string };

type SourceAvailability = {
  camOnline: boolean;
  deskOnline: boolean;
};

function typingHudLabel(event: KeyboardEvent): string | null {
  if (!isTypingCode(event.code)) return null;
  if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') return null;
  if (event.code === 'Space') return 'Space';
  if (event.code === 'Enter') return 'Enter';
  if (event.code === 'Backspace') return '⌫';
  if (event.code === 'Tab') return 'Tab';
  if (event.key.length === 1) return event.key;
  return null;
}

export function StreamPane({
  active,
  keepWarm,
  source,
  onSource,
  stream,
  reconnectSeq,
  liveMode,
  suspended,
  onLive,
  onLeaveLive,
  sendFrame,
  onBindVideoGrabber,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>('offline');
  const [detail, setDetail] = useState('No signal');
  const [recentKeys, setRecentKeys] = useState<RecentKey[]>([]);
  const [availability, setAvailability] = useState<SourceAvailability>({
    camOnline: false,
    deskOnline: false,
  });
  const keySeq = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const streamRef = useRef(stream);
  const sourceRef = useRef(source);
  const liveRef = useRef(liveMode);
  const sendRef = useRef(sendFrame);
  streamRef.current = stream;
  sourceRef.current = source;
  liveRef.current = liveMode;
  sendRef.current = sendFrame;

  useEffect(() => {
    onBindVideoGrabber(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
        return null;
      }
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
      return blob && blob.size > 0 ? blob : null;
    });
    return () => onBindVideoGrabber(null);
  }, [onBindVideoGrabber]);

  useEffect(() => {
    if (!active && !keepWarm) return;
    const id = crypto.randomUUID();
    let stop = false;
    const beat = () => {
      if (stop) return;
      const endpoint = source === 'desk' ? '/api/capture/watch' : '/api/camera/watch';
      const payload = source === 'desk' ? { id } : { id, stream: streamRef.current };
      void fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }).catch(() => undefined);
    };
    const pollAvailability = async () => {
      try {
        const res = await fetch('/api/camera', { credentials: 'same-origin' });
        if (!res.ok || stop) return;
        const body = (await res.json()) as {
          bridge?: string;
          ingest?: boolean;
          capture?: { agent?: string; desk?: boolean };
        };
        if (stop) return;
        setAvailability({
          camOnline: body.bridge === 'online' || Boolean(body.ingest),
          deskOnline: body.capture?.agent === 'online' || Boolean(body.capture?.desk),
        });
      } catch {
        // ignore transient poll error
      }
    };
    beat();
    void pollAvailability();
    const timer = window.setInterval(() => {
      beat();
      void pollAvailability();
    }, 3000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [active, keepWarm, source, stream]);

  useEffect(() => {
    if (!active) {
      setStatus('offline');
      setDetail(suspended ? 'Stopped' : 'No signal');
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
      setDetail(sourceRef.current === 'desk' ? 'Connecting to Capture App…' : 'Connecting to Camera…');
      try {
        const next = await startWhep((event) => {
          if (stopped || mediaStream.getTracks().some((track) => track.id === event.track.id)) return;
          mediaStream.addTrack(event.track);
          if (video && video.srcObject !== mediaStream) {
            video.srcObject = mediaStream;
            void video.play().catch(() => undefined);
          }
        }, sourceRef.current);
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
            setDetail(
              sourceRef.current === 'desk'
                ? 'Live · Capture App (Screen)'
                : `Live · Camera (Stream ${streamRef.current})`,
            );
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
  }, [active, reconnectSeq, source, stream, suspended]);

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
      if (phase !== 'down' || mode !== 'typing') return;
      const label = typingHudLabel(event);
      if (!label) return;
      keySeq.current += 1;
      const id = keySeq.current;
      setRecentKeys((prev) => [...prev, { id, label }].slice(-6));
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

  useEffect(() => {
    if (active && liveMode === 'typing') return;
    setRecentKeys([]);
  }, [active, liveMode]);

  function lockPointer() {
    const stage = stageRef.current;
    if (!liveMode || !stage || document.pointerLockElement === stage) return;
    void stage.requestPointerLock();
  }

  return (
    <div
      ref={stageRef}
      className={`ide-stream${liveMode ? ' ide-stream-live-mode' : ''}`}
      onClick={lockPointer}
    >
      <video ref={videoRef} autoPlay playsInline muted />

      <div
        className="ide-stream-key-overlay"
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <label className="ide-stream-key-toggle">
          <input
            type="checkbox"
            checked={liveMode === 'typing'}
            onChange={(event) => {
              if (event.target.checked) onLive('typing');
              else onLeaveLive();
            }}
          />
          Live key capture
        </label>
        {liveMode === 'typing' && recentKeys.length > 0 ? (
          <div className="ide-stream-keyhud" aria-live="polite" aria-label="Last typing keys">
            {recentKeys.map((key) => (
              <span key={key.id} className="ide-stream-keychip">
                {key.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="ide-stream-footer" onClick={(event) => event.stopPropagation()}>
        <span className={`ide-stream-status ide-stream-${status}`}>
          <span className="ide-stream-dot" aria-hidden="true" />
          {detail}
        </span>
        <div
          className="ide-stream-source-switch"
          role="group"
          aria-label="Select video source (only one streams at a time to save Wi-Fi bandwidth)"
          style={{ display: 'inline-flex', gap: '0.35rem', alignItems: 'center', marginLeft: '0.5rem' }}
        >
          <button
            type="button"
            className={`btn ${source === 'cam' ? 'primary' : 'ghost'} ide-mini`}
            onClick={() => onSource('cam')}
            title="Switch to LookCam Camera (pauses Capture App stream to save Wi-Fi bandwidth)"
          >
            Camera ({availability.camOnline ? 'Available' : 'Offline'})
          </button>
          <button
            type="button"
            className={`btn ${source === 'desk' ? 'primary' : 'ghost'} ide-mini`}
            onClick={() => onSource('desk')}
            title="Switch to Capture App Screen Stream (pauses Camera stream to save Wi-Fi bandwidth)"
          >
            Capture App ({availability.deskOnline ? 'Available' : 'Offline'})
          </button>
        </div>
        {liveMode ? (
          <span className="ide-stream-note">Click video to lock mouse pointer · Esc unlocks</span>
        ) : null}
      </div>
    </div>
  );
}
