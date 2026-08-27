import { useCallback, useEffect, useRef, useState } from 'react';
import { createHidSocket, type HidSocket } from '../lib/hidSocket';

export function useHidSocket() {
  const socketRef = useRef<HidSocket | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [deviceConnected, setDeviceConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    const socket = createHidSocket({
      onOpen() {
        setWsConnected(true);
      },
      onClose() {
        setWsConnected(false);
      },
      onStatus(connected) {
        setDeviceConnected(connected);
      },
      onError(message) {
        setLastError(message);
      },
    });
    socketRef.current = socket;
    socket.open();

    void fetch('/api/status', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (res.status === 401) {
          window.location.assign('/');
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as { deviceConnected?: boolean };
        setDeviceConnected(Boolean(data.deviceConnected));
      })
      .catch(() => undefined);

    return () => {
      socket.close();
      socketRef.current = null;
    };
  }, []);

  const sendBinary = useCallback((buf: ArrayBuffer) => {
    return socketRef.current?.sendBinary(buf) ?? false;
  }, []);

  const isOpen = useCallback(() => {
    return socketRef.current?.isOpen() ?? false;
  }, []);

  const clearError = useCallback(() => setLastError(null), []);

  return {
    wsConnected,
    deviceConnected,
    lastError,
    clearError,
    sendBinary,
    isOpen,
    socketRef,
  };
}
