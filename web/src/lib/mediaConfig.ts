const DEFAULT_MEDIA_BASE = 'https://mediarelay.sahilpatel.online';
const PATH = 'desk';

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** Public MediaMTX HTTPS origin (Coolify domain). No credentials. */
export function mediaBaseUrl(): string {
  const raw = import.meta.env.VITE_MEDIA_BASE_URL as string | undefined;
  const base = (raw && raw.trim()) || DEFAULT_MEDIA_BASE;
  return trimSlash(base);
}

export function mediaPath(): string {
  return PATH;
}

export function whipUrl(): string {
  return `${mediaBaseUrl()}/${PATH}/whip`;
}

export function whepUrl(): string {
  return `${mediaBaseUrl()}/${PATH}/whep`;
}

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];
