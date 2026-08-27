import { DEFAULT_ICE_SERVERS } from './mediaConfig';

export type WhipSession = {
  pc: RTCPeerConnection;
  resourceUrl: string | null;
  stop: () => Promise<void>;
};

function waitIceComplete(pc: RTCPeerConnection, timeoutMs = 8000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = window.setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      reject(new Error('ICE gathering timed out'));
    }, timeoutMs);
    function onChange() {
      if (pc.iceGatheringState === 'complete') {
        window.clearTimeout(t);
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}

/**
 * Publish a MediaStream to a MediaMTX WHIP endpoint (no credentials).
 */
export async function startWhip(
  whipEndpoint: string,
  stream: MediaStream,
  opts?: {
    iceServers?: RTCIceServer[];
    onLog?: (msg: string) => void;
  }
): Promise<WhipSession> {
  const log = opts?.onLog ?? (() => {});
  const pc = new RTCPeerConnection({
    iceServers: opts?.iceServers ?? DEFAULT_ICE_SERVERS,
  });

  for (const track of stream.getTracks()) {
    pc.addTrack(track, stream);
    log(`WHIP: added ${track.kind} track (${track.label || track.id})`);
  }

  pc.addEventListener('iceconnectionstatechange', () => {
    log(`WHIP ICE: ${pc.iceConnectionState}`);
  });
  pc.addEventListener('connectionstatechange', () => {
    log(`WHIP PC: ${pc.connectionState}`);
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  try {
    await waitIceComplete(pc);
  } catch (err) {
    log(`WHIP: ${(err as Error).message} — posting offer anyway`);
  }

  const localSdp = pc.localDescription?.sdp;
  if (!localSdp) {
    pc.close();
    throw new Error('WHIP: missing local SDP');
  }

  log(`WHIP POST ${whipEndpoint}`);
  const res = await fetch(whipEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sdp',
      Accept: 'application/sdp',
    },
    body: localSdp,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    pc.close();
    throw new Error(`WHIP HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const answerSdp = await res.text();
  const location = res.headers.get('Location');
  let resourceUrl: string | null = null;
  if (location) {
    resourceUrl = new URL(location, whipEndpoint).toString();
  }
  log(`WHIP: answer OK${resourceUrl ? `; resource ${resourceUrl}` : ''}`);

  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  return {
    pc,
    resourceUrl,
    stop: async () => {
      for (const sender of pc.getSenders()) {
        try {
          sender.track?.stop();
        } catch {
          // ignore
        }
      }
      pc.close();
      if (resourceUrl) {
        try {
          log(`WHIP DELETE ${resourceUrl}`);
          await fetch(resourceUrl, { method: 'DELETE' });
        } catch (err) {
          log(`WHIP DELETE failed: ${(err as Error).message}`);
        }
      }
    },
  };
}
