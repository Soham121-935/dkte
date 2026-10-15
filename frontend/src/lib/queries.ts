import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints, type TimeRange } from '@/api/endpoints';

export const qk = {
  status: ['system', 'status'] as const,
  devices: ['devices'] as const,
  device: (id: string) => ['devices', id] as const,
  latest: (id: string) => ['telemetry', 'latest', id] as const,
  series: (id: string, tr: TimeRange) => ['telemetry', 'series', id, tr] as const,
  control: (id: string) => ['control', id] as const,
  commands: (id: string) => ['control', id, 'commands'] as const,
  alerts: (q: Record<string, unknown>) => ['alerts', q] as const,
  alertSummary: ['alerts', 'summary'] as const,
  batches: (q?: Record<string, unknown>) => ['batches', q ?? {}] as const,
  batch: (id: number) => ['batches', id] as const,
  timeline: (id: number) => ['batches', id, 'timeline'] as const,
  observations: (id: number) => ['batches', id, 'observations'] as const,
  profiles: ['profiles'] as const,
  forecast: (id: string) => ['predictions', 'forecast', id] as const,
  stage: (id: number) => ['predictions', 'stage', id] as const,
  anomalies: (id: string, hours: number) => ['predictions', 'anomalies', id, hours] as const,
  recommendations: (id: string) => ['predictions', 'recommendations', id] as const,
  accuracy: (id: string) => ['predictions', 'accuracy', id] as const,
  history: (q: Record<string, unknown>) => ['predictions', 'history', q] as const,
  analytics: (id: string, tr: TimeRange) => ['analytics', 'summary', id, tr] as const,
  periodic: (id: string, period: string, tr: TimeRange) => ['analytics', 'periodic', id, period, tr] as const,
  stageEnv: (id: number) => ['analytics', 'stage-env', id] as const,
  aiStatus: ['ai', 'status'] as const,
  insight: (id: string, batchId?: number | null) => ['ai', 'insight', id, batchId ?? null] as const,
  conversations: ['ai', 'conversations'] as const,
  conversation: (id: number) => ['ai', 'conversations', id] as const,
  settings: ['settings'] as const,
  simulator: ['simulator'] as const,
  users: ['users'] as const,
  events: (q: Record<string, unknown>) => ['events', q] as const,
};

export function useSystemStatus() {
  return useQuery({ queryKey: qk.status, queryFn: endpoints.systemStatus, refetchInterval: 15000 });
}

export function useDevices() {
  return useQuery({ queryKey: qk.devices, queryFn: endpoints.devices, refetchInterval: 20000 });
}

export function useLatest(deviceId: string | null) {
  return useQuery({ queryKey: qk.latest(deviceId ?? ''), queryFn: () => endpoints.latest(deviceId!), enabled: !!deviceId, refetchInterval: 15000 });
}

export function useSeries(deviceId: string | null, tr: TimeRange, maxPoints = 400) {
  return useQuery({
    queryKey: [...qk.series(deviceId ?? '', tr), maxPoints],
    queryFn: () => endpoints.series(deviceId!, tr, maxPoints),
    enabled: !!deviceId,
    refetchInterval: tr.range === '1h' ? 15000 : 60000,
  });
}

export function useControl(deviceId: string | null) {
  return useQuery({ queryKey: qk.control(deviceId ?? ''), queryFn: () => endpoints.control(deviceId!), enabled: !!deviceId, refetchInterval: 10000 });
}

export function useAlerts(query: Record<string, string | number | undefined>) {
  return useQuery({ queryKey: qk.alerts(query), queryFn: () => endpoints.alerts(query), refetchInterval: 20000 });
}

export function useBatches(query?: Record<string, string | undefined>) {
  return useQuery({ queryKey: qk.batches(query), queryFn: () => endpoints.batches(query) });
}

export function useProfiles() {
  return useQuery({ queryKey: qk.profiles, queryFn: endpoints.profiles, staleTime: 60000 });
}

export function useAIStatus() {
  return useQuery({ queryKey: qk.aiStatus, queryFn: endpoints.aiStatus, refetchInterval: 30000 });
}

/** Plain-language briefing for the home page; the backend caches it for ~10 minutes. */
export function useInsight(deviceId: string | null, batchId?: number | null) {
  return useQuery({
    queryKey: qk.insight(deviceId ?? '', batchId),
    queryFn: () => endpoints.aiInsight(deviceId!, batchId),
    enabled: !!deviceId,
    staleTime: 60000,
    refetchInterval: 120000,
    placeholderData: keepPreviousData,
  });
}

export function useInvalidate() {
  const qc = useQueryClient();
  return (prefix: readonly unknown[]) => qc.invalidateQueries({ queryKey: prefix as unknown[] });
}
