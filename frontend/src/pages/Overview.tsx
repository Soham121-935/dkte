import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Bot, CheckCircle2, CircleHelp, Package, RefreshCw, Send, Sparkles, TriangleAlert } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '@/api/endpoints';
import { useDevice } from '@/providers/DeviceProvider';
import { useLive } from '@/providers/LiveProvider';
import { useAssistant } from '@/providers/AssistantProvider';
import { useViewMode } from '@/providers/ViewModeProvider';
import { useAlerts, useBatches, useControl, useInsight, useLatest, useSeries, useSystemStatus, qk } from '@/lib/queries';
import { Badge, Button, Card, EmptyState, ErrorState, KeyValue, Loading, Notice, Skeleton, severityTone } from '@/components/ui';
import { ActuatorChip, ConfidenceTag, ConnectionBadge, ModeBadge, SectionTitle, SourceTag } from '@/components/domain';
import { ReadingCards } from '@/components/ReadingCards';
import { MetricChart, toChartRows, gapsFromRows } from '@/components/charts';
import { SuggestionChips } from '@/components/assistant/ChatPanel';
import { Advanced, TechDetails } from '@/components/Technical';
import { fmtAgo, fmtDateTime, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Actuator, AIInsight, InsightPoint } from '@/api/types';

const STATUS_META: Record<AIInsight['status'], { tone: string; icon: typeof CheckCircle2; ring: string }> = {
  good: { tone: 'text-brand', icon: CheckCircle2, ring: 'border-brand/40 bg-brand/10' },
  watch: { tone: 'text-amber', icon: AlertTriangle, ring: 'border-amber/40 bg-amber/10' },
  attention: { tone: 'text-danger', icon: TriangleAlert, ring: 'border-danger/40 bg-danger/10' },
  unknown: { tone: 'text-ink-3', icon: CircleHelp, ring: 'border-line bg-surface-2' },
};

const POINT_TONE: Record<InsightPoint['tone'], string> = {
  good: 'bg-brand',
  warn: 'bg-amber',
  bad: 'bg-danger',
  info: 'bg-ink-3',
};

const POINT_KIND_LABEL: Record<InsightPoint['kind'], string> = {
  measured: 'measured now',
  history: 'last 24 h',
  estimate: 'estimate',
  alert: 'alerts',
  data: 'data',
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

/** The "MYCO AI says" card: plain-language briefing + ask box. */
function InsightCard({ deviceId, batchId }: { deviceId: string; batchId: number | null | undefined }) {
  // wait until the batch list is known so the briefing is requested once, with the right batch
  const insight = useInsight(batchId === undefined ? null : deviceId, batchId);
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
  const meta = STATUS_META[data?.status ?? 'unknown'];
  const Icon = meta.icon;
  return (
    <Card className="overflow-hidden" padded={false}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-brand/40 bg-brand/10 text-brand" aria-hidden>
          <Bot className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-semibold text-ink">MYCO AI says</h2>
        {data && (
          <Badge tone={data.mode === 'llm' ? 'brand' : 'neutral'} title={data.error ?? data.label}>
            {data.mode === 'llm' ? <><Sparkles className="h-2.5 w-2.5" /> {detailed ? `AI · ${data.model}` : 'Written by MYCO AI'}</> : detailed ? 'computed · AI offline' : 'From your data (AI offline)'}
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-1">
          {data && <span className="hidden text-[10px] text-ink-3 sm:inline" title={fmtDateTime(data.generated_at)}>updated {fmtAgo(data.generated_at)}</span>}
          <Button size="xs" variant="ghost" icon={<RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} />} onClick={refresh} disabled={refreshing || insight.isLoading} aria-label="Refresh briefing">
            Refresh
          </Button>
        </div>
      </div>
      <div className="p-4">
        {insight.isLoading || batchId === undefined ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-64" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        ) : insight.error ? (
          <ErrorState error={insight.error} onRetry={() => insight.refetch()} title="Could not prepare the briefing" />
        ) : data ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_minmax(260px,320px)]">
            <div>
              <div className="flex items-center gap-2.5">
                <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-full border', meta.ring, meta.tone)} aria-hidden>
                  <Icon className="h-5 w-5" />
                </span>
                <p className={cn('text-lg font-semibold leading-tight', meta.tone)}>{data.headline}</p>
              </div>
              {data.narrative && <p className="mt-3 text-sm leading-relaxed text-ink">{data.narrative}</p>}
              <ul className="mt-3 space-y-1.5">
                {data.points.map((p, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-ink-2">
                    <span className={cn('mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full', POINT_TONE[p.tone])} aria-hidden />
                    <span>
                      {p.text}
                      {detailed && <span className="ml-1 text-[10px] uppercase tracking-wide text-ink-3">{POINT_KIND_LABEL[p.kind]}</span>}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2 text-[13px]">
                <span className="font-medium text-ink">Next step: </span>
                <span className="text-ink-2">{data.next_step}</span>
              </div>
              {data.data_note && <p className="mt-2 text-[11px] text-ink-3">{data.data_note}</p>}
              {detailed && data.error && <p className="mt-1 text-[11px] text-amber">{data.error}</p>}
            </div>
            <div className="flex flex-col justify-between gap-3 rounded-md border border-line bg-surface-2 p-3">
              <div>
                <p className="text-xs font-semibold text-ink">Ask MYCO AI</p>
                <p className="mt-0.5 text-[11px] text-ink-3">Follow up on anything above – answers use your real readings.</p>
                <SuggestionChips questions={suggestions.data?.questions ?? []} onPick={(q) => submit(q)} limit={4} className="mt-2" />
              </div>
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
              >
                <label htmlFor="home-ask" className="sr-only">
                  Ask MYCO AI
                </label>
                <input id="home-ask" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Why is humidity dropping?" className="h-9 min-w-0 flex-1 rounded-md border border-line bg-surface px-2.5 text-sm text-ink placeholder:text-ink-3 focus:border-brand focus:outline-none" maxLength={4000} />
                <Button type="submit" variant="primary" size="sm" icon={<Send className="h-3.5 w-3.5" />} disabled={!question.trim()} aria-label="Ask">
                  Ask
                </Button>
              </form>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export default function Overview() {
  const { device, deviceId, isLoading: devicesLoading, error: devicesError } = useDevice();
  const { latestReadings } = useLive();
  const { ask } = useAssistant();
  const { detailed } = useViewMode();
  const latest = useLatest(deviceId);
  const control = useControl(deviceId);
  const status = useSystemStatus();
  const alerts = useAlerts({ status: 'open', limit: 8 });
  const batches = useBatches({ status: 'active' });
  const series = useSeries(deviceId, { range: '6h' }, 200);
  const activeBatch = useMemo(() => (batches.data ?? []).find((b) => b.device_id === deviceId) ?? (batches.data ?? [])[0], [batches.data, deviceId]);
  const estimate = useQuery({ queryKey: qk.stage(activeBatch?.id ?? 0), queryFn: () => endpoints.stageEstimate(activeBatch!.id), enabled: !!activeBatch });
  const recommendations = useQuery({ queryKey: qk.recommendations(deviceId ?? ''), queryFn: () => endpoints.recommendations(deviceId!), enabled: !!deviceId, refetchInterval: 60000 });

  const reading = (deviceId && latestReadings[deviceId]) || latest.data?.reading || null;
  const targets = latest.data?.targets ?? control.data?.targets ?? null;
  const rows = useMemo(() => (series.data ? toChartRows(series.data.points, series.data.bucket_seconds) : []), [series.data]);
  const gaps = useMemo(() => (series.data ? gapsFromRows(rows, series.data.bucket_seconds) : []), [rows, series.data]);

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

  const deviceLabel = device.kind === 'simulated' ? `${device.name} (simulated chamber)` : device.name;
  const openAlerts = (alerts.data ?? []).filter((a) => a.status === 'active');
  const mode = control.data?.mode ?? device.control_mode;
  const modeLabel = mode === 'auto' ? 'Automatic' : mode === 'manual' ? 'Manual' : 'Watch only';

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Overview"
        description={
          detailed ? (
            <>
              {greeting()}. {device.name} <span className="font-mono">({device.id})</span> · {device.kind === 'simulated' ? 'simulated device' : 'hardware device'} · transport {device.transport}
            </>
          ) : (
            <>
              {greeting()}. Here is how <span className="font-medium text-ink-2">{deviceLabel}</span> is doing.
            </>
          )
        }
        actions={
          <>
            {status.data && <ModeBadge mode={status.data.mode} label={status.data.label} />}
            <ConnectionBadge status={device.connection_status ?? 'unknown'} lastSeen={device.last_seen_at} />
          </>
        }
      />

      {device.connection_status === 'offline' && (
        <Notice tone="danger">
          <strong>DISCONNECTED.</strong> Nothing has arrived from this chamber since {device.last_telemetry_at ? `${fmtAgo(device.last_telemetry_at)} (${fmtDateTime(device.last_telemetry_at)})` : 'it was registered'}. The values below are the last ones stored, not live measurements. Automatic control is paused; the controller's own safety logic still applies.
        </Notice>
      )}
      {device.kind === 'simulated' && (
        <Notice tone="amber">
          <strong>DEMO MODE.</strong> This chamber is simulated – the readings and equipment feedback are generated by the app so you can explore it. Don't use them for real growing decisions.
        </Notice>
      )}

      <InsightCard deviceId={device.id} batchId={batches.isLoading ? undefined : (activeBatch?.id ?? null)} />

      <ReadingCards reading={reading} targets={targets} loading={latest.isLoading} />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Last 6 hours" subtitle={detailed && series.data ? `${series.data.n_readings} readings · bucket ${series.data.bucket_seconds}s · sources: ${series.data.sources.join(', ') || 'none'}` : 'temperature and humidity against the target band'} className="lg:col-span-2" actions={<Link to="/monitoring" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">More charts <ArrowRight className="h-3 w-3" /></Link>}>
          {series.isLoading ? (
            <Skeleton className="h-[200px] w-full" />
          ) : series.error ? (
            <ErrorState error={series.error} onRetry={() => series.refetch()} />
          ) : (
            <div className="space-y-2">
              <MetricChart rows={rows} metric="temperature_c" targets={targets} gaps={gaps} height={160} />
              <MetricChart rows={rows} metric="relative_humidity_percent" targets={targets} gaps={gaps} height={160} />
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Equipment" subtitle={`${modeLabel} mode`} actions={<Link to="/control" className="text-xs text-brand hover:underline">Control</Link>}>
            <div className="space-y-2">
              {(['fan', 'heater', 'humidifier'] as Actuator[]).map((a) => (
                <ActuatorChip key={a} actuator={a} entry={(device.actuator_state ?? {})[a]} reported={reading ? (reading[`${a}_state`] as boolean | null) : null} />
              ))}
            </div>
            {control.data?.last_evaluation?.interlocks?.length ? (
              <div className="mt-3 space-y-1">
                {control.data.last_evaluation.interlocks.map((i) => (
                  <div key={i.key} className="flex items-start gap-1.5 text-[11px] text-amber">
                    <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" /> {i.message}
                  </div>
                ))}
              </div>
            ) : null}
            <button type="button" onClick={() => ask('Why are the fan, heater and humidifier in their current state?')} className="mt-3 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
              <Bot className="h-3 w-3" /> Ask why
            </button>
          </Card>

          <Card title="Needs attention" subtitle={openAlerts.length ? `${openAlerts.length} open alert${openAlerts.length === 1 ? '' : 's'}` : 'no open alerts'} actions={<Link to="/monitoring#alerts" className="text-xs text-brand hover:underline">All alerts</Link>}>
            {alerts.isLoading ? (
              <Loading />
            ) : !alerts.data?.length ? (
              <p className="flex items-center gap-1.5 text-xs text-ink-3">
                <CheckCircle2 className="h-3.5 w-3.5 text-brand" /> Nothing needs your attention right now.
              </p>
            ) : (
              <ul className="space-y-2">
                {alerts.data.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex items-start gap-2 text-xs">
                    <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-ink">{a.title}</p>
                      <p className="text-[11px] text-ink-3">
                        {fmtAgo(a.last_seen_at)} · {a.status === 'active' ? 'still active' : a.status}
                        {detailed && a.device_id ? ` · ${a.device_id}` : ''}
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
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Your batch" actions={<Link to="/batches" className="text-xs text-brand hover:underline">All batches</Link>}>
          {batches.isLoading ? (
            <Loading />
          ) : !activeBatch ? (
            <EmptyState icon={<Package className="h-5 w-5" />} title="No batch yet" description="Add the mushrooms you are growing so MYCO AI can use the right targets and track their stage." className="py-4" action={<Link to="/batches" className="text-xs text-brand hover:underline">Add a batch →</Link>} />
          ) : (
            <div className="space-y-3">
              <div>
                <Link to={`/batches/${activeBatch.id}`} className="text-sm font-semibold text-ink hover:underline">
                  {activeBatch.name}
                </Link>
                <p className="text-xs text-ink-3">
                  {activeBatch.species}
                  {activeBatch.strain ? ` · ${activeBatch.strain}` : ''}
                  {detailed ? ` · ${activeBatch.code}` : ''} {activeBatch.is_demo && <Badge tone="amber">demo</Badge>}
                </p>
              </div>
              <KeyValue
                items={[
                  { k: 'Stage', v: <span>{activeBatch.current_stage_name ?? titleCase(activeBatch.current_stage_key)} <SourceTag kind="observed" compact /></span> },
                  { k: 'Started', v: fmtDateTime(activeBatch.inoculation_date, 'dd MMM yyyy') },
                  {
                    k: 'Targets',
                    v: activeBatch.effective_targets ? (
                      <span>
                        {activeBatch.effective_targets.temperature_min_c ?? '…'}–{activeBatch.effective_targets.temperature_max_c ?? '…'} °C · {activeBatch.effective_targets.humidity_min_percent ?? '…'}–{activeBatch.effective_targets.humidity_max_percent ?? '…'} % <SourceTag source={activeBatch.effective_targets.source} compact />
                      </span>
                    ) : (
                      '—'
                    ),
                  },
                  ...(detailed ? [{ k: 'Device', v: activeBatch.device_id ?? '—' }] : []),
                ]}
              />
              {estimate.data?.available && estimate.data.current_stage && (
                <div className="rounded-md border border-line bg-surface-2 p-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SourceTag kind="predicted" />
                    <ConfidenceTag level={estimate.data.confidence?.level} basis={estimate.data.confidence?.basis} />
                  </div>
                  <p className="mt-1.5 text-ink-2">
                    Day {Math.floor(estimate.data.current_stage.elapsed_days) + 1} of {estimate.data.current_stage.name}
                    {estimate.data.current_stage.typical_duration_days ? ` (usually ${estimate.data.current_stage.typical_duration_days.min}–${estimate.data.current_stage.typical_duration_days.max} days)` : ''}
                  </p>
                  {estimate.data.harvest_window?.earliest && <p className="mt-1 text-ink-3">Harvest could be around {fmtDateTime(estimate.data.harvest_window.earliest, 'dd MMM')} – {fmtDateTime(estimate.data.harvest_window.latest, 'dd MMM')} (rough estimate from typical timings)</p>}
                </div>
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

        <Card title="What to do next" subtitle={detailed ? 'rule-based, from stored readings' : 'suggestions based on your readings'} actions={<Link to="/predictions" className="text-xs text-brand hover:underline">More</Link>}>
          {recommendations.isLoading ? (
            <Loading />
          ) : recommendations.error ? (
            <ErrorState error={recommendations.error} onRetry={() => recommendations.refetch()} />
          ) : !recommendations.data?.recommendations.length ? (
            <EmptyState icon={<CheckCircle2 className="h-5 w-5" />} title="Nothing to do right now" description="Conditions are where they should be and nothing unusual was noticed." className="py-4" />
          ) : (
            <ul className="space-y-2.5">
              {recommendations.data.recommendations.slice(0, 3).map((r) => (
                <li key={r.key} className="text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className="font-medium text-ink">{r.title}</span>
                    <ConfidenceTag level={r.confidence.level} basis={r.confidence.basis} />
                  </div>
                  <p className="mt-0.5 text-ink-3">{r.detected}</p>
                  <p className="mt-0.5 text-ink-2">→ {r.action}</p>
                  <button type="button" onClick={() => ask(`${r.title}: ${r.detected} Why does this happen and how should I handle it?`)} className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
                    <Bot className="h-3 w-3" /> Ask MYCO AI
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title={detailed ? 'System' : 'Connection'} actions={<Link to="/settings" className="text-xs text-brand hover:underline">Settings</Link>}>
          {status.isLoading ? (
            <Loading />
          ) : status.error ? (
            <ErrorState error={status.error} onRetry={() => status.refetch()} />
          ) : status.data ? (
            <KeyValue
              items={[
                { k: 'Mode', v: <ModeBadge mode={status.data.mode} label={status.data.label} /> },
                { k: 'Chambers', v: `${status.data.devices.filter((d) => d.connection_status === 'online').length} of ${status.data.devices.length} online` },
                { k: 'Alerts', v: `${status.data.alerts.active} active · ${status.data.alerts.critical} critical` },
                {
                  k: 'MYCO AI',
                  v: status.data.ai.configured ? (
                    status.data.ai.circuit_open ? (
                      <Badge tone="amber" title={status.data.ai.last_error ?? undefined}>temporarily unavailable</Badge>
                    ) : (
                      <Badge tone="brand">{detailed ? status.data.ai.model : 'online'}</Badge>
                    )
                  ) : (
                    <Badge title="Add AI_API_KEY to the backend .env to enable the language model">offline – answers from your data</Badge>
                  ),
                },
                ...(detailed
                  ? [
                      { k: 'MQTT', v: status.data.mqtt.enabled ? (status.data.mqtt.connected ? <Badge tone="brand">connected</Badge> : <Badge tone="danger">not connected</Badge>) : <Badge>disabled</Badge> },
                      { k: 'Simulator', v: 'available' in status.data.simulator && status.data.simulator.available ? <Badge tone="amber">running</Badge> : <Badge>stopped</Badge> },
                      { k: 'Public read', v: status.data.public_read ? 'yes' : 'no (login required)' },
                      { k: 'Server time', v: fmtDateTime(status.data.server_time, 'dd MMM HH:mm:ss') },
                    ]
                  : []),
              ]}
            />
          ) : null}
          <Advanced>
            <TechDetails title="Device record" className="mt-3">
              <KeyValue
                items={[
                  { k: 'Device id', v: <span className="font-mono">{device.id}</span> },
                  { k: 'Transport', v: device.transport },
                  { k: 'Firmware', v: device.firmware_version ?? '—' },
                  { k: 'Last telemetry', v: device.last_telemetry_at ? fmtDateTime(device.last_telemetry_at) : '—' },
                ]}
              />
            </TechDetails>
          </Advanced>
        </Card>
      </div>
    </div>
  );
}
