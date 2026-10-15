import { useEffect, useMemo, useReducer, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Bot, CheckCircle2, Droplets, Fan, Flame, Package, RefreshCw, Send, Sparkles } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '@/api/endpoints';
import { useDevice } from '@/providers/DeviceProvider';
import { useLive } from '@/providers/LiveProvider';
import { useAssistant } from '@/providers/AssistantProvider';
import { useViewMode } from '@/providers/ViewModeProvider';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { qk, useAlerts, useBatches, useControl, useInsight, useLatest, useSystemStatus } from '@/lib/queries';
import { Badge, Button, Card, EmptyState, ErrorState, KeyValue, Loading, Modal, Skeleton, errorMessage, severityTone } from '@/components/ui';
import { ConfidenceTag, SourceTag } from '@/components/domain';
import { SuggestionChips } from '@/components/assistant/ChatPanel';
import { Advanced, TechDetails } from '@/components/Technical';
import { fmtAgo, fmtDateTime, titleCase } from '@/lib/format';
import { cn, clamp } from '@/lib/utils';
import type { Actuator, ActuatorEntry, AIInsight, Batch, ControlMode, InsightPoint, Reading, StageDefinition, Targets } from '@/api/types';

/* ------------------------------------------------------------------ words */

/** Short grower words for the profile stage keys (the profile names are long). */
const STAGE_SHORT: Record<string, string> = {
  substrate_preparation: 'Preparing',
  inoculation: 'Inoculated',
  incubation: 'Colonising',
  browning: 'Browning',
  pinning: 'Pinning',
  fruiting: 'Fruiting',
  harvest_ready: 'Ready to pick',
  harvest: 'Harvest',
  post_harvest: 'Resting',
};

export function shortStage(stage: { key: string; name?: string | null } | null | undefined): string {
  if (!stage) return 'No stage';
  if (STAGE_SHORT[stage.key]) return STAGE_SHORT[stage.key];
  const name = stage.name ?? titleCase(stage.key);
  return name.split(/\s[(&/–-]\s?|\s\(/)[0].trim() || titleCase(stage.key);
}

type Verdict = { state: 'in' | 'low' | 'high' | 'unknown' | 'invalid'; words: string; bad: boolean };

const WORDS = {
  temp: { low: 'A little cool', veryLow: 'Too cold', in: 'Just right', high: 'Running warm', veryHigh: 'Too hot' },
  rh: { low: 'Air is a bit dry', veryLow: 'Air is dry', in: 'Nicely humid', high: 'Very damp', veryHigh: 'Far too damp' },
};

/** Plain words for a measured value against its target band – purely arithmetic, nothing is guessed. */
export function verdict(kind: 'temp' | 'rh', value: number | null | undefined, min: number | null | undefined, max: number | null | undefined, quality?: string): Verdict {
  if (quality && quality !== 'ok') return { state: 'invalid', words: quality === 'missing' ? 'No reading' : 'Sensor problem', bad: true };
  if (value === null || value === undefined) return { state: 'unknown', words: 'Waiting for sensor', bad: false };
  if (min === null || min === undefined || max === null || max === undefined) return { state: 'unknown', words: 'No target set yet', bad: false };
  const w = WORDS[kind];
  const far = kind === 'temp' ? 3 : 8;
  if (value < min) return { state: 'low', words: min - value > far ? w.veryLow : w.low, bad: true };
  if (value > max) return { state: 'high', words: value - max > far ? w.veryHigh : w.high, bad: true };
  return { state: 'in', words: w.in, bad: false };
}

const MODE_WORDS: Record<ControlMode, { label: string; hint: string }> = {
  auto: { label: 'Automatic', hint: "MYCO AI's controller keeps the chamber in range with these switches. Choose Manual to take over." },
  manual: { label: 'Manual', hint: 'You are in charge: tap a switch. The chamber confirms the real state within a few seconds.' },
  monitor: { label: 'Watch only', hint: 'Nothing switches on by itself. Choose Automatic or Manual to control the chamber.' },
};

const ACTUATORS: { key: Actuator; label: string; icon: typeof Fan; color: string }[] = [
  { key: 'humidifier', label: 'Humidifier', icon: Droplets, color: '#237c99' },
  { key: 'fan', label: 'Fan', icon: Fan, color: '#4f7f3f' },
  { key: 'heater', label: 'Heater', icon: Flame, color: '#c4601a' },
];

function stateWords(entry: ActuatorEntry | undefined, reported: boolean | null, mode: ControlMode, busy: boolean): { on: boolean; words: string } {
  const confirmed = entry?.confirmed ?? reported ?? null;
  const on = confirmed === true;
  if (busy) return { on, words: 'Sending…' };
  const status = entry?.status ?? (confirmed === null ? 'unknown' : 'confirmed');
  if (status === 'pending') return { on, words: `Waiting for the chamber to confirm ${entry?.requested ? 'ON' : 'OFF'}` };
  if (status === 'mismatch') return { on, words: `Chamber reports ${on ? 'running' : 'off'} – it did not follow the ${entry?.requested ? 'ON' : 'OFF'} command` };
  if (confirmed === null) return { on: false, words: 'State unknown – no report from the chamber yet' };
  return { on, words: `${on ? 'Running' : 'Off'}${mode === 'auto' ? ' · automatic' : ''}` };
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function fmtRange(min: number | null | undefined, max: number | null | undefined, unit: string): string | null {
  if (min === null || min === undefined || max === null || max === undefined) return null;
  return `${min}–${max} ${unit}`;
}

/* ------------------------------------------------------------------ gauge */

function Gauge({ label, value, unit, digits, scale, min, max, v, dimmed, hint }: { label: string; value: number | null | undefined; unit: string; digits: number; scale: [number, number]; min: number | null | undefined; max: number | null | undefined; v: Verdict; dimmed: boolean; hint?: string | null }) {
  const hasBand = min !== null && min !== undefined && max !== null && max !== undefined;
  const lo = Math.min(scale[0], hasBand ? min - 2 : scale[0], value ?? scale[0]);
  const hi = Math.max(scale[1], hasBand ? max + 2 : scale[1], value ?? scale[1]);
  const pc = (x: number) => clamp(((x - lo) / (hi - lo)) * 100, 0, 100);
  const range = fmtRange(min, max, unit);
  return (
    <div className="px-2 sm:px-6 [&+&]:border-l [&+&]:border-cap-ink/20">
      <p className="text-[15px] font-semibold">{label}</p>
      <p className={cn('font-display text-[clamp(52px,11vw,88px)] leading-[1.05] tracking-[-0.02em] transition-opacity', dimmed && 'opacity-50')}>
        {value === null || value === undefined ? '--' : value.toFixed(digits)}
        <span className="ml-1 text-[0.34em] tracking-normal">{unit}</span>
      </p>
      <p className="text-[17px] font-semibold">{v.words}</p>
      <div className="relative mb-2 mt-4 h-2.5 rounded-full cap-track" aria-hidden>
        {hasBand && <i className="cap-band absolute inset-y-0 rounded-full" style={{ left: `${pc(min)}%`, width: `${pc(max) - pc(min)}%` }} />}
        {value !== null && value !== undefined && v.state !== 'invalid' && <b className={cn('cap-pin absolute top-1/2 -ml-2.5 -mt-2.5 h-5 w-5 rounded-full', v.bad && 'bad', dimmed && 'opacity-50')} style={{ left: `${pc(value)}%` }} />}
      </div>
      <p className="text-sm cap-muted">
        {range ? `Target ${range}` : 'No target set'}
        {hint ? <span className="block text-[12px]">{hint}</span> : null}
      </p>
    </div>
  );
}

/* ----------------------------------------------------------- stage stepper */

function StageStepper({ batch, elapsedDays, onPick }: { batch: Batch; elapsedDays: number | null; onPick: (stage: StageDefinition) => void }) {
  const stages = batch.profile?.stages ?? [];
  const idx = stages.findIndex((s) => s.key === batch.current_stage_key);
  const prev = idx > 0 ? stages[idx - 1] : null;
  const next = idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : null;
  const currentLabel = shortStage({ key: batch.current_stage_key ?? '', name: batch.current_stage_name });
  return (
    <div className="cap-seg inline-flex max-w-full items-center rounded-full p-1" role="group" aria-label="Growing stage">
      {prev && (
        <button type="button" aria-pressed="false" onClick={() => onPick(prev)} className="min-h-[40px] rounded-full px-3.5 text-sm font-semibold opacity-70 hover:opacity-100 sm:px-4" title={`Go back to ${shortStage(prev)}`}>
          ‹ {shortStage(prev)}
        </button>
      )}
      <button type="button" aria-pressed="true" className="min-h-[40px] rounded-full px-4 text-sm font-semibold" title={batch.current_stage_name ?? undefined}>
        {currentLabel}
        {elapsedDays !== null && <span className="ml-1 font-normal opacity-80">· day {Math.floor(elapsedDays) + 1}</span>}
      </button>
      {next && (
        <button type="button" aria-pressed="false" onClick={() => onPick(next)} className="min-h-[40px] rounded-full px-3.5 text-sm font-semibold opacity-70 hover:opacity-100 sm:px-4" title={`Mark the batch as ${shortStage(next)}`}>
          {shortStage(next)} ›
        </button>
      )}
    </div>
  );
}

function StageDialog({ batch, target, onClose, onConfirmed }: { batch: Batch; target: StageDefinition | null; onClose: () => void; onConfirmed: () => void }) {
  const toast = useToast();
  const stages = batch.profile?.stages ?? [];
  const goingBack = !!target && stages.findIndex((s) => s.key === target.key) < stages.findIndex((s) => s.key === batch.current_stage_key);
  const confirm = useMutation({
    mutationFn: () => endpoints.confirmStage(batch.id, { stage_key: target!.key }),
    onSuccess: () => {
      toast.success(`${batch.name} is now in ${shortStage(target)}`, 'Targets and the timeline were updated.');
      onConfirmed();
      onClose();
    },
    onError: (e) => toast.error('Could not change the stage', errorMessage(e)),
  });
  if (!target) return null;
  const t = fmtRange(target.targets.temperature_min_c, target.targets.temperature_max_c, '°C');
  const rh = fmtRange(target.targets.humidity_min_percent, target.targets.humidity_max_percent, '% humidity');
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={goingBack ? `Back to ${shortStage(target)}?` : `Has ${batch.name} reached ${shortStage(target)}?`}
      footer={
        <>
          <Button onClick={onClose}>Not yet</Button>
          <Button variant="primary" loading={confirm.isPending} onClick={() => confirm.mutate()}>
            Yes, from today
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-ink-2">
        <p>
          This records that the batch {goingBack ? 'is back in' : 'moved to'} <strong className="text-ink">{target.name}</strong> today. From now on MYCO AI uses that stage's targets
          {t || rh ? ` (${[t, rh].filter(Boolean).join(', ')})` : ''}.
        </p>
        {target.observable_signs.length > 0 && (
          <div>
            <p className="font-medium text-ink">You should be seeing</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {target.observable_signs.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        )}
        {target.transition_criteria && <p className="text-xs text-ink-3">{target.transition_criteria}</p>}
        <p className="text-xs text-ink-3">
          Stages are only changed when you confirm them – MYCO AI never guesses a stage from the calendar. Need a different date or a note? Use the{' '}
          <Link to={`/timeline/${batch.id}`} className="text-brand hover:underline">
            Growth timeline
          </Link>
          .
        </p>
      </div>
    </Modal>
  );
}

/* --------------------------------------------------------------- noticed */

const POINT_TONE: Record<InsightPoint['tone'], string> = { good: 'bg-brand', warn: 'bg-amber', bad: 'bg-danger', info: 'bg-ink-3' };

function NoticedCard({ deviceId, batchId, insight }: { deviceId: string; batchId: number | null | undefined; insight: ReturnType<typeof useInsight> }) {
  const qc = useQueryClient();
  const { ask } = useAssistant();
  const { detailed } = useViewMode();
  const [question, setQuestion] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const suggestions = useQuery({ queryKey: ['ai', 'suggestions'], queryFn: endpoints.aiSuggestions, staleTime: Infinity });

  const refresh = async () => {
    if (batchId === undefined) return;
    setRefreshing(true);
    try {
      const fresh = await endpoints.aiInsight(deviceId, batchId, true);
      qc.setQueryData(qk.insight(deviceId, batchId), fresh);
    } finally {
      setRefreshing(false);
    }
  };
  const submit = (q?: string) => {
    const text = (q ?? question).trim();
    if (!text) return;
    ask(text);
    setQuestion('');
  };
  const data = insight.data;
  return (
    <Card
      title="What MYCO AI noticed"
      subtitle={data ? `updated ${fmtAgo(data.generated_at)}` : undefined}
      actions={
        <div className="flex items-center gap-1.5">
          {data && (
            <Badge tone={data.mode === 'llm' ? 'brand' : 'neutral'} title={data.error ?? data.label}>
              {data.mode === 'llm' ? <><Sparkles className="h-2.5 w-2.5" /> {detailed ? `AI · ${data.model}` : 'Written by MYCO AI'}</> : detailed ? 'computed · AI offline' : 'From your data (AI offline)'}
            </Badge>
          )}
          <Button size="xs" variant="ghost" icon={<RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />} onClick={refresh} disabled={refreshing || insight.isLoading} aria-label="Refresh briefing">
            Refresh
          </Button>
        </div>
      }
    >
      {insight.isLoading || batchId === undefined ? (
        <div className="space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : insight.error ? (
        <ErrorState error={insight.error} onRetry={() => insight.refetch()} title="Could not prepare the briefing" />
      ) : data ? (
        <div className="space-y-3">
          {data.narrative && <p className="text-sm leading-relaxed text-ink">{data.narrative}</p>}
          <ul className="space-y-1.5">
            {data.points.map((p, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-ink-2">
                <span className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', POINT_TONE[p.tone])} aria-hidden />
                <span>{p.text}</span>
              </li>
            ))}
          </ul>
          {data.data_note && <p className="text-[11px] text-ink-3">{data.data_note}</p>}
          {detailed && data.error && <p className="text-[11px] text-amber">{data.error}</p>}
          <div className="border-t border-line pt-3">
            <SuggestionChips questions={suggestions.data?.questions ?? []} onPick={(q) => submit(q)} limit={3} className="mb-2" />
            <form
              className="flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label htmlFor="home-ask" className="sr-only">
                Ask MYCO AI
              </label>
              <input id="home-ask" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a follow-up…" className="h-10 min-w-0 flex-1 rounded-full border border-line bg-surface-2 px-4 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none" maxLength={4000} />
              <Button type="submit" variant="primary" size="sm" icon={<Send className="h-3.5 w-3.5" />} disabled={!question.trim()} aria-label="Ask" className="h-10 rounded-full px-4">
                Ask
              </Button>
            </form>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------- page */

export default function Home() {
  const { device, deviceId, isLoading: devicesLoading, error: devicesError } = useDevice();
  const { latestReadings, devices: liveDevices } = useLive();
  const { ask } = useAssistant();
  const { detailed } = useViewMode();
  const { canOperate, openLogin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const latest = useLatest(deviceId);
  const control = useControl(deviceId);
  const status = useSystemStatus();
  const alerts = useAlerts({ status: 'open', limit: 8 });
  const batches = useBatches({ status: 'active' });
  const activeBatch = useMemo(() => (batches.data ?? []).find((b) => b.device_id === deviceId) ?? (batches.data ?? [])[0], [batches.data, deviceId]);
  const batchId = batches.isLoading ? undefined : (activeBatch?.id ?? null);
  const insight = useInsight(batchId === undefined ? null : deviceId, batchId);
  const estimate = useQuery({ queryKey: qk.stage(activeBatch?.id ?? 0), queryFn: () => endpoints.stageEstimate(activeBatch!.id), enabled: !!activeBatch });
  const [stageTarget, setStageTarget] = useState<StageDefinition | null>(null);
  const [busy, setBusy] = useState<Actuator | null>(null);

  // re-render every 15 s so "updated … ago" and the stale check stay honest
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 15000);
    return () => clearInterval(id);
  }, []);

  const invalidateControl = () => {
    qc.invalidateQueries({ queryKey: ['control'] });
    qc.invalidateQueries({ queryKey: ['devices'] });
    qc.invalidateQueries({ queryKey: ['system'] });
  };
  const guard = (fn: () => void) => {
    if (!canOperate) {
      toast.warning('Sign in to change this', 'Controlling the chamber or changing a stage needs an operator or admin account.');
      openLogin();
      return;
    }
    fn();
  };
  const setMode = useMutation({
    mutationFn: (mode: ControlMode) => endpoints.setMode(deviceId!, mode),
    onSuccess: (_d, mode) => {
      invalidateControl();
      toast.success(`${MODE_WORDS[mode].label} mode is on`);
    },
    onError: (e) => toast.error('Could not change the mode', errorMessage(e)),
  });
  const command = useMutation({
    mutationFn: (p: { actuator: Actuator; state: boolean }) => endpoints.command(deviceId!, { ...p, reason: 'home page switch' }),
    onMutate: (p) => setBusy(p.actuator),
    onSettled: () => setBusy(null),
    onSuccess: (cmd) => {
      invalidateControl();
      if (cmd.status === 'rejected' || cmd.status === 'failed') toast.error(`The chamber did not accept that`, cmd.error ?? 'The command was rejected by the safety rules.');
      else toast.info(`${titleCase(cmd.actuator)} → ${cmd.requested_state ? 'on' : 'off'} sent`, 'Waiting for the chamber to confirm the real state.');
    },
    onError: (e) => toast.error('Could not reach the chamber', errorMessage(e)),
  });

  if (devicesLoading) return <Loading label="Loading your chamber…" />;
  if (devicesError) return <ErrorState error={devicesError} />;
  if (!device) {
    return (
      <EmptyState
        title="No chamber connected yet"
        description="Add your ESP32 chamber controller under Device Management, or turn on the demo simulator to explore the app with sample data."
        action={
          <Link to="/devices" className="text-xs text-brand hover:underline">
            Open Device Management →
          </Link>
        }
      />
    );
  }

  const liveDevice = liveDevices[device.id];
  const reading: Reading | null = (deviceId && latestReadings[deviceId]) || latest.data?.reading || null;
  const targets: Targets | null = latest.data?.targets ?? control.data?.targets ?? activeBatch?.effective_targets ?? null;
  const simulated = device.kind === 'simulated' || reading?.source === 'simulation';
  const connection = liveDevice?.connection_status ?? device.connection_status ?? 'unknown';
  const offline = connection === 'offline';
  const staleAfter = Number(control.data?.config?.stale_sensor_timeout_seconds ?? device.control_config?.stale_sensor_timeout_seconds ?? 120);
  const ageSeconds = reading ? (Date.now() - new Date(reading.measured_at).getTime()) / 1000 : null;
  const stale = ageSeconds !== null && ageSeconds > staleAfter;
  const dimmed = offline || stale || !reading;

  const shown = (v: number | null | undefined, digits: number) => (v === null || v === undefined ? v : Number(v.toFixed(digits)));
  const tV = verdict('temp', shown(reading?.temperature_c, 1), targets?.temperature_min_c, targets?.temperature_max_c, reading?.quality?.temperature_c);
  const hV = verdict('rh', shown(reading?.relative_humidity_percent, 0), targets?.humidity_min_percent, targets?.humidity_max_percent, reading?.quality?.relative_humidity_percent);
  const mode: ControlMode = control.data?.mode ?? liveDevice?.control_mode ?? device.control_mode;
  const data: AIInsight | undefined = insight.data;
  const openAlerts = (alerts.data ?? []).filter((a) => a.status === 'active');
  const elapsedDays = estimate.data?.available && estimate.data.current_stage ? estimate.data.current_stage.elapsed_days : null;

  const freshness = (() => {
    if (!reading) return { tone: 'bg-amber', text: 'No reading has arrived from this chamber yet' };
    if (offline) return { tone: 'bg-[#b3461f]', text: `Chamber disconnected – last reading ${fmtAgo(reading.measured_at)}` };
    if (stale) return { tone: 'bg-amber', text: `No fresh reading for ${fmtAgo(reading.measured_at).replace(' ago', '')} – showing the last one` };
    return { tone: simulated ? 'bg-amber' : 'bg-brand', text: `${simulated ? 'Simulated reading' : 'Measured by your chamber'} · ${fmtAgo(reading.measured_at)}` };
  })();

  const askWhatToDo = () => {
    const issues = (data?.points ?? []).filter((p) => p.tone === 'warn' || p.tone === 'bad').map((p) => p.text);
    if (offline) issues.unshift('The chamber is disconnected.');
    ask(issues.length ? `My chamber needs attention. ${issues.join(' ')} What should I do right now?` : 'How is my chamber doing right now, and is there anything I should do today?');
  };
  const onSwitch = (a: Actuator, on: boolean) => {
    if (offline) {
      toast.warning('The chamber is disconnected', 'Commands cannot be delivered until it reconnects.');
      return;
    }
    if (mode !== 'manual') {
      toast.info('Switch to Manual first', mode === 'auto' ? "MYCO AI's controller is in charge while Automatic is on." : 'Watch-only mode never switches equipment.');
      return;
    }
    guard(() => command.mutate({ actuator: a, state: !on }));
  };
  const afterStageChange = () => {
    qc.invalidateQueries({ queryKey: ['batches'] });
    qc.invalidateQueries({ queryKey: ['control'] });
    qc.invalidateQueries({ queryKey: ['telemetry'] });
    qc.invalidateQueries({ queryKey: ['predictions'] });
    qc.invalidateQueries({ queryKey: ['analytics'] });
    qc.invalidateQueries({ queryKey: ['ai', 'insight'] });
  };

  const rhHint = detailed && (reading?.relative_humidity_percent ?? 0) > 90 ? 'DHT11 is only rated to ~90 % – treat as approximate' : null;
  const chamberLabel = simulated ? 'Demo data – simulated chamber' : offline ? 'Chamber disconnected' : connection === 'online' ? 'Live from your chamber' : 'Waiting for the chamber';

  return (
    <div className="mx-auto max-w-[920px] pb-16 sm:pb-20">
      <h1 className="sr-only">Overview</h1>
      <p className="mb-3 text-center text-sm text-ink-3">
        {greeting()}. Here is how <span className="font-medium text-ink-2">{device.name}</span> is doing.
      </p>

      {/* ------------------------------------------------------------ cap */}
      <section className="cap px-3 pb-8 pt-12 text-center sm:px-7 sm:pt-16" aria-label="Chamber climate">
        <div className="flex flex-col items-center gap-2.5">
          <span className="inline-flex items-center gap-2 rounded-full border border-cap-ink/20 px-3 py-1 text-[13px] font-medium cap-muted">
            <i className={cn('h-2 w-2 rounded-full', simulated ? 'bg-amber' : offline ? 'bg-[#b3461f]' : connection === 'online' ? 'bg-brand-2' : 'bg-cap-ink/40')} aria-hidden />
            {chamberLabel}
          </span>
          {batches.isLoading ? (
            <Skeleton className="h-10 w-56 rounded-full bg-cap-ink/10" />
          ) : activeBatch ? (
            <>
              <StageStepper batch={activeBatch} elapsedDays={elapsedDays} onPick={(s) => guard(() => setStageTarget(s))} />
              <p className="text-[13px] cap-muted">
                {activeBatch.name} · {activeBatch.species}
                {activeBatch.is_demo ? ' · demo batch' : ''}
              </p>
            </>
          ) : (
            <Link to="/batches" className="cap-seg inline-flex min-h-[40px] items-center rounded-full px-4 text-sm font-semibold hover:underline">
              No batch yet – add what you are growing ›
            </Link>
          )}
        </div>

        <div className="mt-6 grid grid-cols-2">
          <Gauge label="Temperature" value={reading?.temperature_c} unit="°C" digits={1} scale={[10, 35]} min={targets?.temperature_min_c} max={targets?.temperature_max_c} v={tV} dimmed={dimmed} />
          <Gauge label="Humidity" value={reading?.relative_humidity_percent} unit="%" digits={0} scale={[40, 100]} min={targets?.humidity_min_percent} max={targets?.humidity_max_percent} v={hV} dimmed={dimmed} hint={rhHint} />
        </div>

        <div className="mx-auto mt-4 flex max-w-[560px] flex-col items-center gap-1 text-[13px] cap-muted">
          <p className="flex items-center gap-1.5">
            <i className={cn('h-2 w-2 rounded-full', freshness.tone)} aria-hidden />
            {freshness.text}
            {targets?.source && <span className="hidden sm:inline">· targets {targets.source === 'profile_reference' ? 'from the reference profile' : targets.source === 'user' || targets.source === 'batch_override' ? 'set by you' : 'from the chamber defaults'}</span>}
          </p>
          {reading?.substrate_moisture_raw !== null && reading?.substrate_moisture_raw !== undefined && (
            <p>
              Substrate moisture {Math.round(reading.substrate_moisture_raw)}
              {targets?.moisture_min_raw != null ? (reading.substrate_moisture_raw < targets.moisture_min_raw ? ' – drier than your threshold' : ' – above your threshold') : ' (uncalibrated sensor value)'}
            </p>
          )}
        </div>

        <div className="mx-auto mt-6 flex max-w-[600px] flex-wrap items-center justify-center gap-x-3.5 gap-y-2.5 font-medium" aria-live="polite">
          {insight.isLoading || batchId === undefined ? (
            <span className="cap-muted">Checking your chamber…</span>
          ) : data ? (
            <span className="text-[15px] leading-snug">
              <b className="font-semibold">{data.headline}</b> <span className="font-normal">{data.next_step}</span>
            </span>
          ) : (
            <span className="cap-muted">{offline ? 'The chamber is disconnected.' : 'MYCO AI could not prepare a briefing right now.'}</span>
          )}
          <button type="button" onClick={askWhatToDo} className="inline-flex min-h-[40px] items-center gap-1.5 rounded-full bg-cap-ink px-4 text-sm font-semibold text-[#d3dfe8] hover:brightness-125">
            <Sparkles className="h-4 w-4" aria-hidden />
            {data && data.status !== 'good' ? 'Ask MYCO AI what to do' : 'Ask MYCO AI'}
          </button>
        </div>
      </section>
      <div className="gills" aria-hidden />

      {/* ----------------------------------------------------------- stem */}
      <section className="stem mx-auto -mt-2 w-full max-w-[460px] px-5 pb-9 pt-6 sm:px-6" aria-label="Chamber controls">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-[23px]">Chamber controls</h2>
          <div className="stem-seg inline-flex rounded-full p-1" role="group" aria-label="Control mode">
            {(['auto', 'manual', 'monitor'] as ControlMode[]).map((m) => (
              <button key={m} type="button" aria-pressed={mode === m} onClick={() => mode !== m && guard(() => setMode.mutate(m))} disabled={setMode.isPending} className="min-h-[32px] rounded-full px-3 text-[12px] font-semibold disabled:opacity-60">
                {MODE_WORDS[m].label}
              </button>
            ))}
          </div>
        </div>
        <p className="mb-2 mt-2 text-sm cap-muted">
          {offline ? 'The chamber is disconnected – the switches cannot be reached right now.' : MODE_WORDS[mode].hint}
          {!canOperate && <span> Sign in as an operator to change anything.</span>}
        </p>
        {ACTUATORS.map(({ key, label, icon: Icon, color }) => {
          const entry = liveDevice?.actuator_state?.[key] ?? control.data?.actuators?.[key] ?? device.actuator_state?.[key];
          const reported = reading ? ((reading[`${key}_state`] as boolean | null) ?? null) : null;
          const { on, words } = stateWords(entry, reported, mode, busy === key);
          const canSwitch = mode === 'manual' && !offline && busy === null;
          return (
            <button
              key={key}
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={label}
              aria-disabled={!canSwitch}
              onClick={() => busy === null && onSwitch(key, on)}
              style={{ '--c': color } as CSSProperties}
              className={cn('stem-row flex min-h-[78px] w-full items-center gap-3.5 py-2 text-left transition-opacity', on && 'on', busy === key && 'opacity-60', !canSwitch && busy !== key && 'cursor-default')}
              title={detailed ? (entry?.last_reason ?? undefined) : undefined}
            >
              <span className="stem-icon grid h-12 w-12 shrink-0 place-items-center rounded-full">
                <Icon className={cn('h-[22px] w-[22px]', key === 'fan' && on && 'animate-spin-slow')} aria-hidden />
              </span>
              <span className="grid min-w-0 flex-1">
                <b className="text-[17px] font-bold">{label}</b>
                <small className="text-sm cap-muted">{words}</small>
              </span>
              <span className={cn('stem-switch block h-8 w-14 shrink-0 rounded-full p-[3px]', !canSwitch && 'opacity-60')} aria-hidden>
                <i className="block h-[26px] w-[26px] rounded-full bg-white" />
              </span>
            </button>
          );
        })}
        {control.data?.last_evaluation?.interlocks?.length ? (
          <ul className="mt-3 space-y-1 text-[12px] text-[#8a3a12]">
            {control.data.last_evaluation.interlocks.map((i) => (
              <li key={i.key}>Safety rule active: {i.message}</li>
            ))}
          </ul>
        ) : null}
        <p className="mt-4 text-[12px] cap-muted">
          A switch sends a request; the chamber reports back what really happened. The heater always cuts out above {control.data?.config?.heater_absolute_max_temp_c ?? 32} °C.{' '}
          <Link to="/control" className="font-semibold underline-offset-2 hover:underline">
            All controls ›
          </Link>
        </p>
      </section>

      {/* --------------------------------------------------------- glance */}
      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <NoticedCard deviceId={device.id} batchId={batchId} insight={insight} />

        <Card title="Needs attention" subtitle={openAlerts.length ? `${openAlerts.length} open alert${openAlerts.length === 1 ? '' : 's'}` : 'no open alerts'} actions={<Link to="/monitoring#alerts" className="text-xs text-brand hover:underline">All alerts</Link>}>
          {alerts.isLoading ? (
            <Loading />
          ) : !alerts.data?.length ? (
            <p className="flex items-center gap-1.5 text-sm text-ink-3">
              <CheckCircle2 className="h-4 w-4 text-brand" /> Nothing needs your attention right now.
            </p>
          ) : (
            <ul className="space-y-2.5">
              {alerts.data.slice(0, 4).map((a) => (
                <li key={a.id} className="flex items-start gap-2 text-xs">
                  <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-ink">{a.title}</p>
                    <p className="text-[11px] text-ink-3">
                      {fmtAgo(a.last_seen_at)} · {a.status === 'active' ? 'still active' : a.status}
                    </p>
                  </div>
                  <button type="button" onClick={() => ask(`What does the alert "${a.title}" mean and what should I do about it?`)} className="shrink-0 text-[11px] text-brand hover:underline" aria-label={`Ask MYCO AI about ${a.title}`}>
                    Ask AI
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Your batch" actions={<Link to="/batches" className="text-xs text-brand hover:underline">All batches</Link>}>
          {batches.isLoading ? (
            <Loading />
          ) : !activeBatch ? (
            <EmptyState icon={<Package className="h-5 w-5" />} title="No batch yet" description="Add the mushrooms you are growing so MYCO AI can use the right targets and track their stage." className="py-4" action={<Link to="/batches" className="text-xs text-brand hover:underline">Add a batch →</Link>} />
          ) : (
            <div className="space-y-3 text-sm">
              <div>
                <Link to={`/batches/${activeBatch.id}`} className="font-semibold text-ink hover:underline">
                  {activeBatch.name}
                </Link>
                <p className="text-xs text-ink-3">
                  {activeBatch.species}
                  {activeBatch.strain ? ` · ${activeBatch.strain}` : ''}
                  {detailed ? ` · ${activeBatch.code}` : ''} {activeBatch.is_demo && <Badge tone="amber">demo</Badge>}
                </p>
              </div>
              <p className="text-ink-2">
                <span className="font-medium text-ink">{activeBatch.current_stage_name ?? titleCase(activeBatch.current_stage_key)}</span>
                {elapsedDays !== null && estimate.data?.current_stage?.typical_duration_days ? ` – day ${Math.floor(elapsedDays) + 1}, usually ${estimate.data.current_stage.typical_duration_days.min}–${estimate.data.current_stage.typical_duration_days.max} days` : ''}
                <SourceTag kind="observed" compact className="ml-1.5" />
              </p>
              {estimate.data?.available && estimate.data.next_stage && (
                <p className="text-xs text-ink-3">
                  Next: {shortStage(estimate.data.next_stage)}
                  {estimate.data.next_stage.expected_window ? ` – could start around ${fmtDateTime(estimate.data.next_stage.expected_window.earliest, 'dd MMM')}–${fmtDateTime(estimate.data.next_stage.expected_window.latest, 'dd MMM')}` : ''}
                  {estimate.data.harvest_window?.earliest ? `; harvest roughly ${fmtDateTime(estimate.data.harvest_window.earliest, 'dd MMM')}–${fmtDateTime(estimate.data.harvest_window.latest, 'dd MMM')}` : ''}
                  <span className="ml-1 inline-flex items-center gap-1">
                    <SourceTag kind="predicted" compact />
                    <ConfidenceTag level={estimate.data.confidence?.level} basis={estimate.data.confidence?.basis} />
                  </span>
                </p>
              )}
              <div className="flex flex-wrap gap-3">
                <Link to={`/timeline/${activeBatch.id}`} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
                  Growth timeline <ArrowRight className="h-3 w-3" />
                </Link>
                <button type="button" onClick={() => ask('Which growth stage is my batch in and what should I look for next?')} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
                  <Bot className="h-3 w-3" /> Ask about this stage
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>

      <nav aria-label="Explore" className="mt-6 flex flex-wrap items-center justify-center gap-2 text-sm">
        {[
          { to: '/monitoring', label: 'Charts' },
          { to: activeBatch ? `/timeline/${activeBatch.id}` : '/timeline', label: 'Growth timeline' },
          { to: '/predictions', label: 'Predictions' },
          { to: '/analytics', label: 'Reports' },
          { to: '/assistant', label: 'MYCO AI chat' },
        ].map((l) => (
          <Link key={l.to} to={l.to} className="rounded-full border border-line bg-surface px-3.5 py-1.5 text-ink-2 hover:border-brand/60 hover:text-ink">
            {l.label}
          </Link>
        ))}
      </nav>

      <Advanced>
        <TechDetails title="Technical details" className="mt-6">
          <KeyValue
            items={[
              { k: 'Device id', v: <span className="font-mono">{device.id}</span> },
              { k: 'Transport', v: device.transport },
              { k: 'Firmware', v: device.firmware_version ?? '—' },
              { k: 'Connection', v: connection },
              { k: 'Control mode', v: mode },
              { k: 'Last reading', v: reading ? `${fmtDateTime(reading.measured_at)} · source ${reading.source}${reading.message_id ? ` · ${reading.message_id}` : ''}` : '—' },
              { k: 'Stale after', v: `${staleAfter} s` },
              { k: 'Targets', v: targets ? `${targets.source ?? '—'}${targets.stage_key ? ` · stage ${targets.stage_key}` : ''}` : '—' },
              { k: 'Server time', v: status.data ? fmtDateTime(status.data.server_time, 'dd MMM HH:mm:ss') : '—' },
              { k: 'MYCO AI', v: status.data ? (status.data.ai.configured ? `${status.data.ai.model ?? 'configured'}${status.data.ai.circuit_open ? ' · circuit open' : ''}` : 'no provider key – deterministic answers') : '—' },
            ]}
          />
        </TechDetails>
      </Advanced>

      {activeBatch && <StageDialog batch={activeBatch} target={stageTarget} onClose={() => setStageTarget(null)} onConfirmed={afterStageChange} />}
    </div>
  );
}
