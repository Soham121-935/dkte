import { api, downloadFile, type Query } from './client';
import type {
  AIMessage,
  AIStatus,
  Alert,
  AlertSummary,
  AnalyticsSummary,
  AnomalyReport,
  Batch,
  BatchReport,
  Command,
  ControlOverview,
  Conversation,
  Device,
  DeviceDiagnostics,
  DeviceWithToken,
  Evaluation,
  Forecast,
  ForecastAccuracy,
  LatestTelemetry,
  LoginResponse,
  Observation,
  PeriodicReport,
  PredictionRecord,
  Profile,
  Reading,
  RecommendationReport,
  SeriesResponse,
  SettingsResponse,
  SimulatorStatus,
  StageEnvironment,
  StageEstimate,
  SystemEvent,
  SystemStatus,
  Timeline,
  User,
} from './types';

export type RangeKey = '1h' | '6h' | '24h' | '7d' | '30d';

export interface TimeRange {
  range?: RangeKey;
  from?: string;
  to?: string;
}

export const endpoints = {
  // ---- system / auth
  health: () => api<{ status: string; time: string; version: string }>('/api/system/health'),
  systemStatus: () => api<SystemStatus>('/api/system/status'),
  systemEvents: (query?: Query) => api<SystemEvent[]>('/api/system/events', { query }),
  login: (username: string, password: string) => api<LoginResponse>('/api/auth/login', { method: 'POST', body: { username, password } }),
  me: () => api<User>('/api/auth/me'),
  changePassword: (current_password: string, new_password: string) =>
    api<{ status: string }>('/api/auth/change-password', { method: 'POST', body: { current_password, new_password } }),
  users: () => api<User[]>('/api/auth/users'),
  createUser: (body: { username: string; password: string; role: string }) => api<User>('/api/auth/users', { method: 'POST', body }),
  updateUser: (id: number, body: { role?: string; is_active?: boolean; password?: string }) =>
    api<User>(`/api/auth/users/${id}`, { method: 'PATCH', body }),

  // ---- devices
  devices: () => api<Device[]>('/api/devices'),
  device: (id: string) => api<Device>(`/api/devices/${id}`),
  createDevice: (body: Record<string, unknown>) => api<DeviceWithToken>('/api/devices', { method: 'POST', body }),
  updateDevice: (id: string, body: Record<string, unknown>) => api<Device>(`/api/devices/${id}`, { method: 'PATCH', body }),
  rotateToken: (id: string) => api<{ device_id: string; token: string; note: string }>(`/api/devices/${id}/token`, { method: 'POST' }),
  revokeToken: (id: string) => api<Device>(`/api/devices/${id}/token`, { method: 'DELETE' }),
  diagnostics: (id: string, limit = 50) => api<DeviceDiagnostics>(`/api/devices/${id}/diagnostics`, { query: { limit } }),

  // ---- telemetry
  latest: (device_id: string) => api<LatestTelemetry>('/api/telemetry/latest', { query: { device_id } }),
  readings: (device_id: string, query?: Query) => api<Reading[]>('/api/telemetry/readings', { query: { device_id, ...query } }),
  series: (device_id: string, tr: TimeRange, max_points = 400) =>
    api<SeriesResponse>('/api/telemetry/series', { query: { device_id, ...tr, max_points } }),
  exportReadingsCsv: (device_id: string, tr: TimeRange) =>
    downloadFile('/api/telemetry/export.csv', `myco-readings-${device_id}-${tr.range ?? 'custom'}.csv`, { device_id, ...tr }),

  // ---- profiles
  profiles: () => api<Profile[]>('/api/profiles'),
  profile: (id: number) => api<Profile>(`/api/profiles/${id}`),
  createProfile: (body: Record<string, unknown>) => api<Profile>('/api/profiles', { method: 'POST', body }),
  updateProfile: (id: number, body: Record<string, unknown>) => api<Profile>(`/api/profiles/${id}`, { method: 'PATCH', body }),
  deleteProfile: (id: number) => api<void>(`/api/profiles/${id}`, { method: 'DELETE' }),
  cloneProfile: (id: number, name?: string) => api<Profile>(`/api/profiles/${id}/clone`, { method: 'POST', body: name ? { name } : {} }),

  // ---- batches
  batches: (query?: Query) => api<Batch[]>('/api/batches', { query }),
  batch: (id: number) => api<Batch>(`/api/batches/${id}`),
  createBatch: (body: Record<string, unknown>) => api<Batch>('/api/batches', { method: 'POST', body }),
  updateBatch: (id: number, body: Record<string, unknown>) => api<Batch>(`/api/batches/${id}`, { method: 'PATCH', body }),
  deleteBatch: (id: number) => api<void>(`/api/batches/${id}`, { method: 'DELETE' }),
  timeline: (id: number) => api<Timeline>(`/api/batches/${id}/timeline`),
  confirmStage: (id: number, body: { stage_key: string; started_at?: string; note?: string }) =>
    api<Batch>(`/api/batches/${id}/stage`, { method: 'POST', body }),
  observations: (id: number) => api<Observation[]>(`/api/batches/${id}/observations`),
  createObservation: (id: number, body: Record<string, unknown>) => api<Observation>(`/api/batches/${id}/observations`, { method: 'POST', body }),
  uploadObservationImage: (batchId: number, obsId: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api<Observation>(`/api/batches/${batchId}/observations/${obsId}/image`, { method: 'POST', formData: fd });
  },
  deleteObservation: (batchId: number, obsId: number) => api<void>(`/api/batches/${batchId}/observations/${obsId}`, { method: 'DELETE' }),
  batchReadings: (id: number, max_points = 400) => api<SeriesResponse>(`/api/batches/${id}/readings`, { query: { max_points } }),
  batchReport: (id: number) => api<BatchReport>(`/api/batches/${id}/report`),

  // ---- control
  control: (device_id: string) => api<ControlOverview>(`/api/control/${device_id}`),
  setMode: (device_id: string, mode: string) => api<ControlOverview>(`/api/control/${device_id}/mode`, { method: 'POST', body: { mode } }),
  command: (device_id: string, body: { actuator: string; state: boolean; reason?: string }) =>
    api<Command>(`/api/control/${device_id}/command`, { method: 'POST', body }),
  updateControlConfig: (device_id: string, body: Record<string, unknown>) =>
    api<ControlOverview>(`/api/control/${device_id}/config`, { method: 'PATCH', body }),
  evaluate: (device_id: string) => api<Evaluation>(`/api/control/${device_id}/evaluate`, { method: 'POST' }),
  commands: (device_id: string, limit = 50) => api<Command[]>(`/api/control/${device_id}/commands`, { query: { limit } }),

  // ---- alerts
  alerts: (query?: Query) => api<Alert[]>('/api/alerts', { query }),
  alertSummary: () => api<AlertSummary>('/api/alerts/summary'),
  alertChannels: () => api<{ name: string; enabled: boolean; detail: string }[]>('/api/alerts/channels'),
  acknowledgeAlert: (id: number, note?: string) => api<Alert>(`/api/alerts/${id}/acknowledge`, { method: 'POST', body: { note } }),
  resolveAlert: (id: number, note?: string) => api<Alert>(`/api/alerts/${id}/resolve`, { method: 'POST', body: { note } }),

  // ---- predictions
  forecast: (device_id: string, window_minutes = 60) => api<Forecast>('/api/predictions/forecast', { query: { device_id, window_minutes } }),
  stageEstimate: (batch_id: number) => api<StageEstimate>('/api/predictions/stage', { query: { batch_id } }),
  anomalies: (device_id: string, hours = 24) => api<AnomalyReport>('/api/predictions/anomalies', { query: { device_id, hours } }),
  recommendations: (device_id: string) => api<RecommendationReport>('/api/predictions/recommendations', { query: { device_id } }),
  accuracy: (device_id: string, days = 7) => api<ForecastAccuracy>('/api/predictions/accuracy', { query: { device_id, days } }),
  predictionHistory: (query?: Query) => api<PredictionRecord[]>('/api/predictions/history', { query }),
  runPredictions: () => api<Record<string, unknown>>('/api/predictions/run', { method: 'POST' }),

  // ---- analytics
  analyticsSummary: (device_id: string, tr: TimeRange) => api<AnalyticsSummary>('/api/analytics/summary', { query: { device_id, ...tr } }),
  periodic: (device_id: string, period: 'day' | 'week', tr: TimeRange) =>
    api<PeriodicReport>('/api/analytics/periodic', { query: { device_id, period, ...tr } }),
  exportPeriodicCsv: (device_id: string, period: 'day' | 'week', tr: TimeRange) =>
    downloadFile('/api/analytics/periodic.csv', `myco-${period}ly-summary-${device_id}.csv`, { device_id, period, ...tr }),
  stageEnvironment: (batch_id: number) => api<StageEnvironment>('/api/analytics/stage-environment', { query: { batch_id } }),

  // ---- AI assistant (all provider calls happen server-side)
  aiStatus: () => api<AIStatus>('/api/ai/status'),
  aiDiagnostics: () => api<Record<string, unknown>>('/api/ai/diagnostics', { method: 'POST' }),
  aiSuggestions: () => api<{ questions: string[] }>('/api/ai/suggestions'),
  conversations: (limit = 30) => api<Conversation[]>('/api/ai/conversations', { query: { limit } }),
  conversation: (id: number) => api<Conversation & { messages: AIMessage[] }>(`/api/ai/conversations/${id}`),
  createConversation: (body: { device_id?: string | null; batch_id?: number | null; title?: string }) =>
    api<Conversation>('/api/ai/conversations', { method: 'POST', body }),
  deleteConversation: (id: number) => api<void>(`/api/ai/conversations/${id}`, { method: 'DELETE' }),
  sendMessage: (id: number, content: string, signal?: AbortSignal) =>
    api<Conversation & { messages: AIMessage[] }>(`/api/ai/conversations/${id}/messages`, { method: 'POST', body: { content }, signal }),

  // ---- settings / simulator
  settings: () => api<SettingsResponse>('/api/settings'),
  /** Returns the merged section (not the full settings document). */
  updateSettings: (section: string, value: Record<string, unknown>) =>
    api<Record<string, unknown>>(`/api/settings/${section}`, { method: 'PATCH', body: { value } }),
  simulatorStatus: () => api<SimulatorStatus>('/api/simulator/status'),
  simulatorScenario: (scenario: string, duration_minutes?: number) =>
    api<SimulatorStatus>('/api/simulator/scenario', { method: 'POST', body: { scenario, duration_minutes } }),
  simulatorStart: () => api<SimulatorStatus>('/api/simulator/start', { method: 'POST' }),
  simulatorStop: () => api<SimulatorStatus>('/api/simulator/stop', { method: 'POST' }),
};
