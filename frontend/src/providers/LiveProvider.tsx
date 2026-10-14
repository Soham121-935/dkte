import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { tokenStore } from '@/api/client';
import type { Alert, Device, LiveEvent, Reading } from '@/api/types';

type Listener = (event: LiveEvent) => void;

interface LiveCtx {
  /** WebSocket connection state between browser and backend. */
  connected: boolean;
  reconnecting: boolean;
  lastEventAt: string | null;
  subscribe: (listener: Listener) => () => void;
  /** Latest reading per device pushed over the socket. */
  latestReadings: Record<string, Reading>;
  devices: Record<string, Device>;
  recentAlerts: Alert[];
  dismissAlert: (id: number) => void;
}

const Ctx = createContext<LiveCtx | null>(null);

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  // The session token is only needed when PUBLIC_READ=false on the backend; it is sent
  // as a query parameter because browsers cannot set WebSocket headers.
  const token = tokenStore.get();
  return `${proto}://${window.location.host}/ws/live${token ? `?token=${encodeURIComponent(token)}` : ''}`;
}

export function LiveProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [latestReadings, setLatestReadings] = useState<Record<string, Reading>>({});
  const [devices, setDevices] = useState<Record<string, Device>>({});
  const [recentAlerts, setRecentAlerts] = useState<Alert[]>([]);
  const listeners = useRef(new Set<Listener>());
  const invalidateTimers = useRef<Record<string, number>>({});

  const scheduleInvalidate = useCallback(
    (key: string, queryKey: unknown[], delay = 400) => {
      if (invalidateTimers.current[key]) return;
      invalidateTimers.current[key] = window.setTimeout(() => {
        delete invalidateTimers.current[key];
        qc.invalidateQueries({ queryKey });
      }, delay);
    },
    [qc],
  );

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: number | undefined;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        schedule();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        setReconnecting(false);
        qc.invalidateQueries({ queryKey: ['system'] });
      };
      ws.onclose = () => {
        setConnected(false);
        schedule();
      };
      ws.onerror = () => {
        ws?.close();
      };
      ws.onmessage = (msg) => {
        let event: { type: string; payload: unknown; ts?: string };
        try {
          event = JSON.parse(msg.data);
        } catch {
          return;
        }
        if (event.type === 'ping' || event.type === 'hello') return;
        const live: LiveEvent = { type: event.type, ts: event.ts, data: event.payload };
        setLastEventAt(event.ts ?? new Date().toISOString());
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        switch (event.type) {
          case 'telemetry': {
            const reading = payload.reading as Reading | undefined;
            if (reading) setLatestReadings((prev) => ({ ...prev, [reading.device_id]: reading }));
            if (payload.device) setDevices((prev) => ({ ...prev, [(payload.device as Device).id]: payload.device as Device }));
            scheduleInvalidate('telemetry', ['telemetry'], 1500);
            scheduleInvalidate('series', ['telemetry', 'series'], 15000);
            break;
          }
          case 'device_status':
          case 'actuator_status':
          case 'control':
          case 'command': {
            if (payload.device) setDevices((prev) => ({ ...prev, [(payload.device as Device).id]: payload.device as Device }));
            scheduleInvalidate('control', ['control'], 600);
            scheduleInvalidate('devices', ['devices'], 1000);
            scheduleInvalidate('status', ['system'], 1500);
            break;
          }
          case 'alert': {
            const alert = payload.alert as Alert | undefined;
            const action = String(payload.action ?? '');
            if (alert && ['opened', 'escalated', 'reopened'].includes(action)) {
              setRecentAlerts((prev) => [alert, ...prev.filter((a) => a.id !== alert.id)].slice(0, 6));
            } else if (alert) {
              setRecentAlerts((prev) => prev.filter((a) => a.id !== alert.id));
            }
            scheduleInvalidate('alerts', ['alerts'], 300);
            scheduleInvalidate('status', ['system'], 1500);
            break;
          }
          case 'prediction':
            scheduleInvalidate('predictions', ['predictions'], 1000);
            break;
          case 'simulator':
            scheduleInvalidate('simulator', ['simulator'], 300);
            scheduleInvalidate('status', ['system'], 500);
            break;
          case 'transport':
            scheduleInvalidate('status', ['system'], 500);
            break;
          case 'telemetry_rejected':
            scheduleInvalidate('events', ['events'], 1000);
            break;
          default:
            break;
        }
        listeners.current.forEach((l) => {
          try {
            l(live);
          } catch {
            /* listener error must not break the stream */
          }
        });
      };
    };

    const schedule = () => {
      if (closed) return;
      setReconnecting(true);
      attempt += 1;
      const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt, 4));
      timer = window.setTimeout(connect, delay);
    };

    connect();
    // Reconnect immediately when the session changes so a private backend (PUBLIC_READ=false)
    // receives the new token instead of waiting for the back-off timer.
    const unsubscribeToken = tokenStore.subscribe(() => {
      attempt = 0;
      if (timer) window.clearTimeout(timer);
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
      else timer = window.setTimeout(connect, 200);
    });
    return () => {
      closed = true;
      unsubscribeToken();
      if (timer) window.clearTimeout(timer);
      ws?.close();
    };
  }, [qc, scheduleInvalidate]);

  const subscribe = useCallback((listener: Listener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const dismissAlert = useCallback((id: number) => setRecentAlerts((prev) => prev.filter((a) => a.id !== id)), []);

  const value = useMemo<LiveCtx>(
    () => ({ connected, reconnecting, lastEventAt, subscribe, latestReadings, devices, recentAlerts, dismissAlert }),
    [connected, reconnecting, lastEventAt, subscribe, latestReadings, devices, recentAlerts, dismissAlert],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLive() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useLive outside LiveProvider');
  return ctx;
}
