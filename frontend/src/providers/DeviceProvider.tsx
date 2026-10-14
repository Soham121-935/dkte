import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useDevices } from '@/lib/queries';
import type { Device } from '@/api/types';

interface DeviceCtx {
  devices: Device[];
  deviceId: string | null;
  device: Device | null;
  setDeviceId: (id: string) => void;
  isLoading: boolean;
  error: unknown;
}

const Ctx = createContext<DeviceCtx | null>(null);
const KEY = 'myco.selected-device';

function pickDefault(devices: Device[]): string | null {
  if (!devices.length) return null;
  const hardwareOnline = devices.find((d) => d.kind === 'hardware' && d.connection_status === 'online');
  if (hardwareOnline) return hardwareOnline.id;
  const online = devices.find((d) => d.connection_status === 'online');
  return (online ?? devices[0]).id;
}

export function DeviceProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useDevices();
  const devices = useMemo(() => data ?? [], [data]);
  const [deviceId, setDeviceIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (!devices.length) return;
    if (!deviceId || !devices.some((d) => d.id === deviceId)) {
      const next = pickDefault(devices);
      if (next) setDeviceIdState(next);
    }
  }, [devices, deviceId]);

  const setDeviceId = (id: string) => {
    setDeviceIdState(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* ignore */
    }
  };

  const device = devices.find((d) => d.id === deviceId) ?? null;
  const value = useMemo<DeviceCtx>(() => ({ devices, deviceId: device ? device.id : null, device, setDeviceId, isLoading, error }), [devices, device, isLoading, error]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDevice() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDevice outside DeviceProvider');
  return ctx;
}
