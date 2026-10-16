// Types mirroring the backend (FastAPI) response payloads.
// Keep in sync with backend/app/schemas and the service `to_dict()` helpers.

export type Role = 'admin' | 'operator' | 'viewer';
export type ConnectionStatus = 'online' | 'offline' | 'stale' | 'unknown';
export type ControlMode = 'monitor' | 'auto' | 'manual';
export type Actuator = 'fan' | 'heater' | 'humidifier';
export type Severity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'active' | 'acknowledged' | 'resolved';
export type Quality = 'ok' | 'missing' | 'implausible' | 'out_of_sensor_range' | 'sensor_error' | 'stale' | 'future' | string;
export type ReadingSource = 'hardware' | 'simulation' | 'manual' | string;

export interface User {
  id: number;
  username: string;
  role: Role;
  is_active?: boolean;
  created_at?: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface ActuatorEntry {
  requested?: boolean | null;
  requested_at?: string | null;
  requested_by?: string | null;
  last_reason?: string | null;
  last_origin?: string | null;
  last_command_id?: string | null;
  confirmed?: boolean | null;
  confirmed_at?: string | null;
  since?: string | null;
  status?: 'pending' | 'confirmed' | 'mismatch' | 'unknown' | string;
  cooldown_until?: string | null;
}

export interface Targets {
  temperature_min_c: number | null;
  temperature_max_c: number | null;
  humidity_min_percent: number | null;
  humidity_max_percent: number | null;
  moisture_min_raw: number | null;
  fae_cycle_minutes: number;
  fae_duration_minutes: number;
  source?: string;
  source_label?: string;
  batch_id?: number | null;
  batch_code?: string | null;
  stage_key?: string | null;
  profile_name?: string | null;
}

export interface Decision {
  actuator: Actuator;
  desired: boolean | null;
  reason: string;
  origin: 'auto' | 'safety' | string;
}

export interface Interlock {
  key: string;
  actuator?: Actuator | null;
  message: string;
  forced_state?: boolean | null;
}

export interface Evaluation {
  device_id: string;
  mode: ControlMode;
  evaluated_at: string;
  targets: Targets;
  inputs: {
    temperature_c: number | null;
    relative_humidity_percent: number | null;
    measured_at: string | null;
    stale: boolean;
    temperature_valid: boolean;
    humidity_valid: boolean;
    device_online: boolean;
  };
  interlocks: Interlock[];
  decisions: Decision[];
  commands: string[];
  notes: string[];
}

export interface Device {
  id: string;
  name: string;
  kind: 'hardware' | 'simulated' | string;
  /** `camera` = the ESP32-CAM (no actuators, never selectable as a chamber). */
  role?: 'chamber' | 'camera';
  transport: 'simulator' | 'http' | 'mqtt' | string;
  firmware_version: string | null;
  hardware_notes: string | null;
  is_enabled: boolean;
  has_token: boolean;
  connection_status: ConnectionStatus;
  last_seen_at: string | null;
  last_telemetry_at: string | null;
  control_mode: ControlMode;
  control_config: Record<string, number | string | boolean>;
  control_state: { last_evaluation?: Evaluation; latches?: Record<string, boolean> };
  actuator_state: Partial<Record<Actuator, ActuatorEntry>>;
  stats: Record<string, number>;
  created_at: string;
}

export interface DeviceWithToken extends Device {
  token?: string;
}

export interface TransportStatus {
  name: string;
  available: boolean;
  detail: string;
}

export interface SimulatorStatus {
  enabled: boolean;
  name: string;
  available: boolean;
  detail: string;
  device_id: string;
  interval_seconds: number;
  scenarios: Record<string, string | null>;
  last_published_at: string | null;
  messages_sent: number;
  started_at: string | null;
  state: {
    temperature_c: number;
    relative_humidity_percent: number;
    substrate_moisture_raw: number;
    ambient_temperature_c: number;
    fan: boolean;
    heater: boolean;
    humidifier: boolean;
  };
  scenarios_available: Record<string, string>;
}

export interface AIStatus {
  configured: boolean;
  provider: string;
  model: string | null;
  json_mode_enabled: boolean;
  rate_limit_per_minute: number;
  last_error: string | null;
  last_success_at: string | null;
  usage: { requests: number; failures: number; prompt_tokens: number; completion_tokens: number };
  fallback: string;
  circuit_open: boolean;
  circuit_retry_in_seconds: number;
  vendor?: string;
  endpoint_host?: string;
  key_present?: boolean;
  key_hint?: string;
}

export type InsightStatus = 'good' | 'watch' | 'attention' | 'unknown';

export interface InsightPoint {
  tone: 'good' | 'warn' | 'bad' | 'info';
  kind: 'measured' | 'history' | 'estimate' | 'alert' | 'data';
  text: string;
}

/** Plain-language chamber briefing from GET /api/ai/insight. */
export interface AIInsight {
  device_id: string;
  batch_id: number | null;
  generated_at: string;
  status: InsightStatus;
  headline: string;
  points: InsightPoint[];
  next_step: string;
  data_note: string | null;
  simulated: boolean;
  /** `llm` when the narrative was written by the configured model, `fallback` when only the computed briefing is available. */
  mode: 'llm' | 'fallback';
  label: string;
  narrative: string | null;
  model: string | null;
  error: string | null;
  cached: boolean;
  cache_age_seconds: number;
  cache_ttl_seconds: number;
}

export interface SystemStatus {
  app: string;
  version: string;
  environment: string;
  server_time: string;
  mode: 'live' | 'demo' | 'disconnected' | string;
  label: string;
  detail: string;
  devices: Device[];
  alerts: { active: number; acknowledged: number; critical: number };
  transports: TransportStatus[];
  mqtt: { name: string; enabled: boolean; available: boolean; connected: boolean; detail: string; topic_prefix: string };
  simulator: SimulatorStatus | { enabled: false; available?: boolean; detail?: string };
  ai: AIStatus;
  notifications: { name: string; enabled: boolean; detail: string }[];
  public_read: boolean;
  /** True when the backend runs without sign-in (OPEN_ACCESS=true): every visitor is a local operator. */
  open_access?: boolean;
}

export interface ReadingQuality {
  time?: Quality;
  temperature_c?: Quality;
  relative_humidity_percent?: Quality;
  substrate_moisture_raw?: Quality;
  fan_state?: Quality;
  heater_state?: Quality;
  humidifier_state?: Quality;
  warnings?: string[];
  transport?: string;
  [key: string]: unknown;
}

export interface Reading {
  id: number;
  device_id: string;
  measured_at: string;
  received_at: string;
  message_id: string | null;
  schema_version: number;
  source: ReadingSource;
  temperature_c: number | null;
  relative_humidity_percent: number | null;
  substrate_moisture_raw: number | null;
  fan_state: boolean | null;
  heater_state: boolean | null;
  humidifier_state: boolean | null;
  quality: ReadingQuality;
}

export interface SensorValue {
  device_id: string;
  sensor_type: string;
  value: number | boolean | null;
  unit: string;
  measured_at: string;
  received_at: string;
  quality: Quality;
  source: ReadingSource;
  message_id: string | null;
}

export interface LatestTelemetry {
  device_id: string;
  connection_status: ConnectionStatus;
  reading: Reading | null;
  sensors: SensorValue[];
  targets: Targets | null;
}

export interface SeriesPoint {
  t: string;
  n: number;
  source: string;
  temperature_c: number | null;
  temperature_c_min: number | null;
  temperature_c_max: number | null;
  relative_humidity_percent: number | null;
  relative_humidity_percent_min: number | null;
  relative_humidity_percent_max: number | null;
  substrate_moisture_raw: number | null;
  substrate_moisture_raw_min: number | null;
  substrate_moisture_raw_max: number | null;
  fan_on_ratio: number | null;
  heater_on_ratio: number | null;
  humidifier_on_ratio: number | null;
  invalid_count: number;
}

export interface SeriesResponse {
  device_id: string;
  from: string;
  to: string;
  bucket_seconds: number;
  n_readings: number;
  sources: string[];
  points: SeriesPoint[];
  targets: Targets | null;
}

export interface StageDefinition {
  key: string;
  name: string;
  description: string;
  milestone: boolean;
  typical_duration_days: { min: number; max: number } | null;
  targets: Targets;
  observable_signs: string[];
  transition_criteria: string;
  requires_confirmation: boolean;
}

export interface Profile {
  id: number;
  name: string;
  species: string;
  strain: string | null;
  cultivation_method: string | null;
  substrate_type: string | null;
  source: 'reference' | 'user' | string;
  source_notes: string | null;
  stages: StageDefinition[];
  is_builtin: boolean;
  created_at: string;
  updated_at: string;
}

export interface Observation {
  id: number;
  batch_id: number;
  observed_at: string;
  kind: string;
  note: string;
  stage_key: string | null;
  image_url: string | null;
  recorded_by: string | null;
  data: Record<string, unknown> | null;
  created_at: string;
}

export interface StageEvent {
  id: number;
  batch_id: number;
  stage_key: string;
  started_at: string;
  source: 'manual' | 'seed' | 'system' | string;
  confirmed_by: string | null;
  note: string | null;
}

export interface Batch {
  id: number;
  code: string;
  name: string;
  species: string;
  strain: string | null;
  substrate_type: string | null;
  substrate_details: string | null;
  inoculation_date: string | null;
  spawn_details: string | null;
  profile_id: number | null;
  profile: Profile | null;
  device_id: string | null;
  status: 'active' | 'completed' | 'failed' | 'archived' | string;
  current_stage_key: string | null;
  current_stage_name: string | null;
  target_overrides: Record<string, Partial<Targets>>;
  notes: string | null;
  expected_harvest_start: string | null;
  expected_harvest_end: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  is_demo: boolean;
  created_at: string;
  updated_at: string;
  effective_targets?: Targets | null;
  observations?: Observation[];
  stage_events?: StageEvent[];
}

export interface TimelineStage {
  index: number;
  key: string;
  name: string;
  description: string;
  milestone: boolean;
  typical_duration_days: { min: number; max: number } | null;
  targets: Targets;
  observable_signs: string[];
  transition_criteria: string;
  requires_confirmation: boolean;
  state: 'completed' | 'current' | 'upcoming' | 'skipped' | string;
  started_at: string | null;
  ended_at: string | null;
  actual_duration_days: number | null;
  events: StageEvent[];
  observations: Observation[];
}

export interface ConfidenceInfo {
  level: 'low' | 'medium' | 'high' | 'none' | string;
  basis: string[] | string;
}

export interface StageEstimate {
  batch_id: number;
  generated_at: string;
  model: { name: string; version: string; description: string };
  available: boolean;
  reason?: string;
  current_stage?: {
    key: string;
    name: string;
    index: number;
    total: number;
    started_at: string;
    source: string;
    confirmed_by: string | null;
    elapsed_days: number;
    typical_duration_days: { min: number; max: number } | null;
    milestone: boolean;
  };
  timing?: 'early' | 'within_typical_window' | 'overdue' | 'unknown' | string;
  timing_label?: string;
  next_stage?: {
    key: string;
    name: string;
    expected_window: { earliest: string; latest: string } | null;
    observable_signs: string[];
    transition_criteria: string;
  } | null;
  harvest_window?: { earliest: string | null; latest: string | null; basis: string } | null;
  cycle_progress?: { fraction: number; label: string } | null;
  confidence?: ConfidenceInfo;
  environment_conformity?: {
    readings: number;
    temperature_in_range_fraction: number | null;
    humidity_in_range_fraction: number | null;
    source: string;
  } | null;
  observations_in_stage?: number;
}

export interface Timeline {
  batch: Batch;
  stages: TimelineStage[];
  events: StageEvent[];
  estimate: StageEstimate | null;
}

export interface ForecastPoint {
  horizon_minutes: number;
  target_time: string;
  value: number;
  lower: number;
  upper: number;
}

export interface ForecastMetric {
  label: string;
  unit: string;
  n_points: number;
  sufficient: boolean;
  limitation?: string;
  current?: number;
  slope_per_hour?: number;
  trend?: 'rising' | 'falling' | 'stable' | string;
  residual_std?: number;
  forecasts?: ForecastPoint[];
}

export interface Forecast {
  device_id: string;
  generated_at: string;
  model: { name: string; version: string; description: string };
  window_minutes: number;
  metrics: Record<string, ForecastMetric>;
  source: string;
}

export interface ForecastAccuracy {
  device_id: string;
  days: number;
  results: {
    metric: string;
    horizon_minutes: number;
    n_evaluated: number;
    mae: number | null;
    bias: number | null;
    band_coverage: number | null;
    sufficient: boolean;
  }[];
  note: string;
}

export interface Anomaly {
  type: string;
  severity: Severity;
  metric: string | null;
  label: string;
  start: string;
  end: string;
  duration_minutes: number | null;
}

export interface AnomalyReport {
  device_id: string;
  generated_at: string;
  hours: number;
  source: string;
  n_readings: number;
  targets: Targets | null;
  anomalies: Anomaly[];
  instability_windows: { start: string; end: string; std_c?: number }[];
  absolute_max_temp_c: number;
  model: { name: string; version: string };
}

export interface Recommendation {
  key: string;
  title: string;
  detected: string;
  why: string;
  action: string;
  confidence: ConfidenceInfo;
  requires_confirmation: boolean;
  category: string;
  actuator?: Actuator | null;
  suggested_state?: boolean | null;
}

export interface RecommendationReport {
  device_id: string;
  generated_at: string;
  source: string;
  recommendations: Recommendation[];
  mode: ControlMode;
  targets: Targets | null;
  reading: { measured_at: string; temperature_c: number | null; relative_humidity_percent: number | null } | null;
}

export interface PredictionRecord {
  id: number;
  kind: string;
  model_name: string;
  model_version: string;
  device_id: string | null;
  batch_id: number | null;
  generated_at: string;
  target_time: string | null;
  horizon_minutes: number | null;
  inputs: Record<string, unknown>;
  output: Record<string, unknown>;
  uncertainty: Record<string, unknown> | null;
  evaluated_at: string | null;
  actual: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

export interface Alert {
  id: number;
  rule_key: string;
  dedup_key: string;
  severity: Severity;
  title: string;
  message: string;
  device_id: string | null;
  batch_id: number | null;
  source: string;
  status: AlertStatus;
  opened_at: string;
  last_seen_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_reason: string | null;
  occurrence_count: number;
  data: Record<string, unknown>;
}

export interface AlertSummary {
  by_status: Record<string, number>;
  by_severity_open: Record<string, number>;
  total: number;
  thresholds: Record<string, number | string>;
}

export interface Command {
  id: number;
  command_id: string;
  device_id: string;
  actuator: Actuator;
  requested_state: boolean;
  reason: string;
  origin: 'auto' | 'manual' | 'safety' | string;
  requested_by: string | null;
  control_mode: ControlMode;
  status: 'pending' | 'sent' | 'confirmed' | 'applied' | 'failed' | 'rejected' | 'timeout' | 'unknown' | string;
  validation: { checks?: string[]; result?: string; warnings?: string[] } | null;
  result_state: boolean | null;
  error: string | null;
  created_at: string;
  sent_at: string | null;
  confirmed_at: string | null;
}

export interface ActuatorStatusEvent {
  id: number;
  device_id: string;
  actuator: Actuator;
  state: boolean;
  observed_at: string;
  source: string;
  command_id: string | null;
}

export interface ControlOverview {
  device: Device;
  reading: Reading | null;
  targets: Targets | null;
  config: Record<string, number>;
  mode: ControlMode;
  modes: ControlMode[];
  evaluation_preview: Evaluation | null;
  last_evaluation: Evaluation | null;
  actuators: Record<Actuator, ActuatorEntry>;
  recent_commands: Command[];
  recent_status_events: ActuatorStatusEvent[];
  safety_notes: string[];
}

export interface SystemEvent {
  id: number;
  created_at: string;
  device_id: string | null;
  category: string;
  level: string;
  message: string;
  data: Record<string, unknown> | null;
}

export interface MetricStats {
  bins: { from: number; to: number; count: number }[];
  count: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  std: number | null;
  p5: number | null;
  p95: number | null;
}

export interface OutsideRange {
  below_seconds: number;
  above_seconds: number;
  measured_seconds: number;
  outside_fraction: number | null;
  min: number | null;
  max: number | null;
}

export interface ActuatorRuntime {
  on_seconds: number;
  known_seconds: number;
  duty_cycle: number | null;
  switch_count: number;
}

export interface AnalyticsSummary {
  device_id: string;
  start: string;
  end: string;
  n_readings: number;
  covered_seconds: number;
  sources: string[];
  temperature_c: MetricStats;
  relative_humidity_percent: MetricStats;
  substrate_moisture_raw: MetricStats;
  outside_range: Partial<Record<'temperature_c' | 'relative_humidity_percent', OutsideRange>>;
  targets: Targets | null;
  actuator_runtime: Record<Actuator, ActuatorRuntime>;
  expected_interval_seconds: number;
  missing_intervals: { start: string; end: string; seconds: number }[];
  missing_seconds: number;
  data_completeness: number | null;
  invalid_readings: number;
}

export interface PeriodicItem {
  period: string;
  n_readings: number;
  sources: string[];
  temperature_c: { mean: number | null; min: number | null; max: number | null } | null;
  relative_humidity_percent: { mean: number | null; min: number | null; max: number | null } | null;
  substrate_moisture_raw: { mean: number | null; min: number | null; max: number | null } | null;
  fan_on_minutes: number;
  heater_on_minutes: number;
  humidifier_on_minutes: number;
  temperature_outside_minutes: number;
  humidity_outside_minutes: number;
}

export interface PeriodicReport {
  device_id: string;
  period: 'day' | 'week';
  from: string;
  to: string;
  items: PeriodicItem[];
}

export interface StageEnvironmentRow {
  stage_key: string;
  stage_name: string;
  started_at: string;
  ended_at: string | null;
  duration_days: number | null;
  source: string;
  typical_duration_days: { min: number; max: number } | null;
  n_readings: number;
  temperature_c: { mean: number; min: number; max: number; std: number } | null;
  relative_humidity_percent: { mean: number; min: number; max: number; std: number } | null;
  substrate_moisture_raw: { mean: number; min: number; max: number; std: number } | null;
  sources: string[];
}

export interface StageEnvironment {
  batch_id: number;
  stages: StageEnvironmentRow[];
  note: string;
}

export interface BatchReport {
  generated_at: string;
  batch: Record<string, unknown> & { code: string; name: string };
  period: { start: string; end: string };
  sensor_summary: AnalyticsSummary | null;
  stage_environment: StageEnvironment;
  observations: { observed_at: string; kind: string; note: string; stage_key: string | null; image: string | null }[];
  stage_estimate: StageEstimate | null;
  predictions: Record<string, unknown>[];
  alerts: { opened_at: string; severity: Severity; title: string; status: AlertStatus; message: string }[];
}

export interface AIMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  mode: 'llm' | 'fallback' | null;
  provider: string | null;
  model: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  context_snapshot: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
}

export interface Conversation {
  id: number;
  title: string;
  device_id: string | null;
  batch_id: number | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
  messages?: AIMessage[];
}

export interface SettingsResponse {
  sections: Record<string, Record<string, unknown>>;
  defaults: Record<string, Record<string, unknown>>;
  runtime: Record<string, unknown>;
}

export interface DeviceDiagnostics {
  device: Device;
  readings_total: number;
  readings_24h: number;
  rejections_24h: number;
  first_reading_at: string | null;
  last_reading: Reading | null;
  telemetry_age_seconds: number | null;
  events: SystemEvent[];
}

export interface LiveEvent<T = unknown> {
  type: string;
  ts?: string;
  data: T;
}

/* ------------------------------------------------------------ camera / phase recognition */

export type CaptureStatus = 'matched' | 'no_match' | 'unreadable' | 'unavailable';
export type CaptureConfidence = 'high' | 'medium' | 'low';

export interface ReferenceCardInfo {
  key: string;
  species_key: string;
  species: string;
  latin_name: string;
  profile_name: string;
  phase_key: string;
  phase: string;
  stage_key: string;
  what_you_see: string;
  qr_payload: string;
  image_url: string;
  image_available?: boolean;
}

export interface CameraCapture {
  id: number;
  camera_device_id: string | null;
  target_device_id: string | null;
  captured_at: string;
  source: 'esp32cam' | 'upload' | string;
  trigger: 'auto' | 'manual' | 'upload' | string;
  image_url: string;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  status: CaptureStatus;
  method: 'qr' | 'features' | null;
  confidence: CaptureConfidence | null;
  inliers: number;
  second_inliers: number;
  qr_text: string | null;
  card: ReferenceCardInfo | null;
  species_key: string | null;
  phase_key: string | null;
  stage_key: string | null;
  message: string | null;
  candidates: { key: string; inliers: number; good_matches: number }[];
  applied: boolean;
  applied_at: string | null;
  applied_batch_id: number | null;
  applied_stage_key: string | null;
  applied_by: string | null;
  apply_note: string | null;
}

export interface CameraStatus {
  camera_device_id: string;
  camera_registered: boolean;
  camera_has_token: boolean;
  online: boolean;
  last_poll_at: string | null;
  last_seen_at: string | null;
  manual_pending: boolean;
  manual_requested_at: string | null;
  auto_interval_seconds: number;
  auto_apply: boolean;
  auto_mode: boolean;
  target_device_id: string;
  target_control_mode: ControlMode | null;
  active_batch: { id: number; code: string; species: string; stage_key: string | null; profile_name: string | null } | null;
  last_capture: CameraCapture | null;
  recognition: { available: boolean; error: string | null; indexed: number; missing: string[]; min_inliers: number; features_per_image: number };
  reference_cards: number;
}

export interface ReferencePhase extends ReferenceCardInfo {
  stage_name: string;
  targets: Targets | Record<string, number | null>;
  typical_duration_days: { min: number; max: number } | null;
}

export interface ReferenceSet {
  species: {
    key: string;
    code: string;
    common_name: string;
    latin_name: string;
    profile_id: number | null;
    profile_name: string;
    profile_source: string | null;
    source_notes: string | null;
    phases: ReferencePhase[];
  }[];
  cards: number;
  images_available: number;
  pdf_url: string;
  qr_format: string;
  note: string;
}

export interface CaptureRequestResponse {
  requested: boolean;
  camera_online: boolean;
  target_device_id: string;
  message: string;
}
