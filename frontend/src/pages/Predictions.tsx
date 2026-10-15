import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Brain, RefreshCw } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { qk, useBatches, useSeries } from '@/lib/queries';
import { useDevice } from '@/providers/DeviceProvider';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card, EmptyState, ErrorState, KeyValue, Loading, Notice, Select, Tabs, errorMessage, severityTone } from '@/components/ui';
import { ConfidenceTag, SectionTitle, SourceTag } from '@/components/domain';
import { ForecastChart } from '@/components/charts';
import { fmtDateTime, fmtDuration, fmtNumber, fmtPercent, titleCase } from '@/lib/format';
import { useViewMode } from '@/providers/ViewModeProvider';
import { useAssistant } from '@/providers/AssistantProvider';
import { TechDetails } from '@/components/Technical';

const TIMING_LABEL: Record<string, string> = {
  early: 'Too early for a change',
  within_window: 'A change could happen any day',
  beyond_window: 'Taking longer than usual',
  milestone: 'Milestone stage',
};

export default function Predictions() {
  const { device, deviceId } = useDevice();
  const { canOperate } = useAuth();
  const { detailed } = useViewMode();
  const { ask } = useAssistant();
  const toast = useToast();
  const qc = useQueryClient();
  const [hours, setHours] = useState(24);
  const batches = useBatches({ status: 'active' });
  const batch = useMemo(() => (batches.data ?? []).find((b) => b.device_id === deviceId) ?? (batches.data ?? [])[0], [batches.data, deviceId]);
  const forecast = useQuery({ queryKey: qk.forecast(deviceId ?? ''), queryFn: () => endpoints.forecast(deviceId!, 60), enabled: !!deviceId, refetchInterval: 60000 });
  const history = useSeries(deviceId, { range: '6h' }, 150);
  const anomalies = useQuery({ queryKey: qk.anomalies(deviceId ?? '', hours), queryFn: () => endpoints.anomalies(deviceId!, hours), enabled: !!deviceId });
  const recs = useQuery({ queryKey: qk.recommendations(deviceId ?? ''), queryFn: () => endpoints.recommendations(deviceId!), enabled: !!deviceId, refetchInterval: 60000 });
  const accuracy = useQuery({ queryKey: qk.accuracy(deviceId ?? ''), queryFn: () => endpoints.accuracy(deviceId!, 7), enabled: !!deviceId });
  const stage = useQuery({ queryKey: qk.stage(batch?.id ?? 0), queryFn: () => endpoints.stageEstimate(batch!.id), enabled: !!batch });
  const [histKind, setHistKind] = useState<'env_forecast' | 'stage_estimate' | 'all'>('env_forecast');
  const predHistory = useQuery({ queryKey: qk.history({ device_id: deviceId, kind: histKind }), queryFn: () => endpoints.predictionHistory({ device_id: deviceId!, kind: histKind === 'all' ? undefined : histKind, limit: 40 }), enabled: !!deviceId });
  const run = useMutation({
    mutationFn: endpoints.runPredictions,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['predictions'] });
      toast.success('Prediction cycle executed');
    },
    onError: (e) => toast.error('Could not run predictions', errorMessage(e)),
  });

  const histRows = useMemo(() => {
    const pts = history.data?.points ?? [];
    return {
      temperature_c: pts.map((p) => ({ ts: new Date(p.t).getTime(), value: p.temperature_c })),
      relative_humidity_percent: pts.map((p) => ({ ts: new Date(p.t).getTime(), value: p.relative_humidity_percent })),
    };
  }, [history.data]);

  if (!device) return <EmptyState title="No chamber selected" />;
  const targets = forecast.data ? anomalies.data?.targets ?? recs.data?.targets ?? null : null;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="AI Predictions"
        description={
          detailed
            ? 'Short-horizon environmental forecasts (linear trend), stage timing estimate with uncertainty, rule-based anomaly detection and recommendations. Every output states its model, inputs and confidence basis. Nothing here is a learned growth model.'
            : 'Where temperature and humidity are heading in the next hour, how your batch is progressing, anything unusual we noticed and what you could do about it. These are estimates from your own readings – not guarantees.'
        }
        actions={
          <>
            <Badge tone="info">
              <SourceTag kind="predicted" compact /> {detailed ? 'model outputs' : 'estimates'}
            </Badge>
            <Button size="sm" variant="ghost" icon={<Bot className="h-3.5 w-3.5" />} onClick={() => ask('What should I expect in my chamber over the next few hours, and what should I watch for next?')}>
              Ask MYCO AI
            </Button>
            {canOperate && (
              <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={run.isPending} onClick={() => run.mutate()}>
                {detailed ? 'Run prediction cycle' : 'Update now'}
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        {(['temperature_c', 'relative_humidity_percent'] as const).map((metric) => {
          const m = forecast.data?.metrics[metric];
          return (
            <Card key={metric} title={`${metric === 'temperature_c' ? 'Temperature' : 'Humidity'} – next hour`} subtitle={forecast.data ? (detailed ? `${forecast.data.model.name} v${forecast.data.model.version} · window ${forecast.data.window_minutes} min · input: ${forecast.data.source}` : `based on the trend of the last ${forecast.data.window_minutes} minutes`) : undefined}>
              {forecast.isLoading ? (
                <Loading />
              ) : forecast.error ? (
                <ErrorState error={forecast.error} onRetry={() => forecast.refetch()} />
              ) : !m ? (
                <p className="text-xs text-ink-3">No metric data.</p>
              ) : !m.sufficient ? (
                <EmptyState title="Not enough recent data" description={m.limitation ?? `Only ${m.n_points} valid points in the window.`} className="py-6" />
              ) : (
                <>
                  <ForecastChart metric={m} history={histRows[metric]} targets={metric === 'temperature_c' ? [targets?.temperature_min_c ?? null, targets?.temperature_max_c ?? null] : [targets?.humidity_min_percent ?? null, targets?.humidity_max_percent ?? null]} />
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    <div>
                      <p className="label">Now</p>
                      <p className="font-mono text-ink">{fmtNumber(m.current, 1)}{m.unit}</p>
                    </div>
                    <div>
                      <p className="label">Trend</p>
                      <p className="text-ink">
                        {m.trend} ({m.slope_per_hour !== undefined && m.slope_per_hour > 0 ? '+' : ''}
                        {fmtNumber(m.slope_per_hour, 2)}{m.unit}/h)
                      </p>
                    </div>
                    {m.forecasts?.map((f) => (
                      <div key={f.horizon_minutes}>
                        <p className="label">+{f.horizon_minutes} min</p>
                        <p className="font-mono text-ink">
                          {fmtNumber(f.value, 1)}
                          <span className="text-ink-3"> [{fmtNumber(f.lower, 1)}–{fmtNumber(f.upper, 1)}]</span>
                        </p>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-ink-3">{detailed ? forecast.data?.model.description : 'The range in brackets shows how far off the estimate could be. A sudden change (door opened, equipment switched) cannot be predicted from the trend.'}</p>
                </>
              )}
            </Card>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={detailed ? 'Forecast accuracy (last 7 days)' : 'How good were past forecasts? (last 7 days)'} subtitle={detailed ? 'forecasts are stored and compared with what was actually measured' : 'every forecast is checked against what was measured later'}>
          {accuracy.isLoading ? (
            <Loading />
          ) : accuracy.error ? (
            <ErrorState error={accuracy.error} />
          ) : !accuracy.data?.results.length ? (
            <EmptyState title="No evaluated forecasts yet" description={accuracy.data?.note ?? 'Forecasts are evaluated once their target time has passed and a measurement exists.'} className="py-4" />
          ) : (
            <>
              <table className="table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Horizon</th>
                    <th>n</th>
                    <th>MAE</th>
                    <th>Bias</th>
                    <th>Band hit</th>
                  </tr>
                </thead>
                <tbody>
                  {accuracy.data.results.map((r) => (
                    <tr key={`${r.metric}-${r.horizon_minutes}`} className={!r.sufficient ? 'opacity-60' : undefined}>
                      <td>{r.metric === 'temperature_c' ? 'Temp' : 'RH'}</td>
                      <td>{r.horizon_minutes} min</td>
                      <td className="font-mono">{r.n_evaluated}</td>
                      <td className="font-mono">{fmtNumber(r.mae, 2)}</td>
                      <td className="font-mono">{r.bias !== null && r.bias > 0 ? '+' : ''}{fmtNumber(r.bias, 2)}</td>
                      <td className="font-mono">{fmtPercent(r.band_coverage)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-ink-3">{accuracy.data.note}</p>
            </>
          )}
        </Card>

        <Card title={detailed ? 'Stage timing estimate' : 'How is the batch progressing?'} subtitle={batch ? `${detailed ? batch.code : batch.name} · ${batch.current_stage_name ?? titleCase(batch.current_stage_key)}` : 'no active batch'}>
          {!batch ? (
            <EmptyState title="No batch yet" description="Add the mushrooms you are growing and choose a species profile to see stage timing." className="py-4" action={<Link to="/batches" className="text-xs text-brand hover:underline">Add a batch →</Link>} />
          ) : stage.isLoading ? (
            <Loading />
          ) : stage.error ? (
            <ErrorState error={stage.error} />
          ) : !stage.data?.available ? (
            <p className="text-xs text-ink-3">{stage.data?.reason ?? 'Unavailable'}</p>
          ) : (
            <div className="space-y-2 text-xs">
              <div className="flex flex-wrap gap-1.5">
                <ConfidenceTag level={stage.data.confidence?.level} basis={stage.data.confidence?.basis} />
                <Badge tone={stage.data.timing === 'beyond_window' ? 'amber' : 'neutral'}>{detailed ? titleCase(stage.data.timing) : TIMING_LABEL[stage.data.timing ?? ''] ?? titleCase(stage.data.timing)}</Badge>
              </div>
              <p className="text-ink-2">{stage.data.timing_label}</p>
              {stage.data.next_stage?.expected_window && (
                <p className="text-ink-3">
                  {stage.data.next_stage.name} usually starts between {fmtDateTime(stage.data.next_stage.expected_window.earliest, 'dd MMM')} and {fmtDateTime(stage.data.next_stage.expected_window.latest, 'dd MMM')}
                </p>
              )}
              {stage.data.harvest_window?.earliest && (
                <p className="text-ink-3">
                  Harvest could be around {fmtDateTime(stage.data.harvest_window.earliest, 'dd MMM')} – {fmtDateTime(stage.data.harvest_window.latest, 'dd MMM')}
                </p>
              )}
              <p className="text-ink-3">{detailed ? stage.data.model.description : 'Based on typical timings for this species, counted from the stage you confirmed – your own observations decide when a stage really changes.'}</p>
              <div className="flex flex-wrap gap-3">
                <Link to={`/timeline/${batch.id}`} className="inline-block text-brand hover:underline">
                  Open timeline →
                </Link>
                <button type="button" onClick={() => ask('Which growth stage is my batch in, is it on schedule, and what signs should I look for next?')} className="inline-flex items-center gap-1 text-brand hover:underline">
                  <Bot className="h-3 w-3" /> Ask MYCO AI
                </button>
              </div>
            </div>
          )}
        </Card>

        <Card title={detailed ? 'Recommendations' : 'What you could do'} subtitle={recs.data ? (detailed ? `generated ${fmtDateTime(recs.data.generated_at, 'HH:mm:ss')} · mode ${recs.data.mode}` : `updated ${fmtDateTime(recs.data.generated_at, 'HH:mm')}`) : undefined}>
          {recs.isLoading ? (
            <Loading />
          ) : recs.error ? (
            <ErrorState error={recs.error} onRetry={() => recs.refetch()} />
          ) : !recs.data?.recommendations.length ? (
            <EmptyState icon={<Brain className="h-5 w-5" />} title="Nothing to do right now" description="Conditions are where they should be and nothing unusual was noticed." className="py-4" />
          ) : (
            <ul className="space-y-3">
              {recs.data.recommendations.map((r) => (
                <li key={r.key} className="rounded-md border border-line bg-surface-2 p-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-ink">{r.title}</span>
                    <Badge>{titleCase(r.category)}</Badge>
                    <ConfidenceTag level={r.confidence.level} basis={r.confidence.basis} />
                    {r.requires_confirmation && <Badge tone="amber">needs your confirmation</Badge>}
                  </div>
                  <dl className="mt-1.5 space-y-1">
                    <div>
                      <dt className="inline text-ink-3">{detailed ? 'Detected: ' : 'What we noticed: '}</dt>
                      <dd className="inline text-ink-2">{r.detected}</dd>
                    </div>
                    <div>
                      <dt className="inline text-ink-3">Why it matters: </dt>
                      <dd className="inline text-ink-2">{r.why}</dd>
                    </div>
                    <div>
                      <dt className="inline text-ink-3">Suggested action: </dt>
                      <dd className="inline text-ink-2">{r.action}</dd>
                    </div>
                  </dl>
                  {r.actuator && (
                    <p className="mt-1 text-[11px] text-ink-3">
                      Involves the {r.actuator}; {detailed ? 'the deterministic controller applies this only in auto mode' : 'the app only does this by itself in Automatic mode'} – <Link to="/control" className="text-brand hover:underline">review in Environmental Control</Link>.
                    </p>
                  )}
                  <button type="button" onClick={() => ask(`${r.title}: ${r.detected} Why does this happen and how should I handle it?`)} className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-brand hover:underline">
                    <Bot className="h-3 w-3" /> Ask MYCO AI about this
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title={detailed ? 'Anomaly detection' : 'Anything unusual?'}
        subtitle={anomalies.data ? (detailed ? `${anomalies.data.model.name} · ${anomalies.data.n_readings} readings · source ${anomalies.data.source}` : `checked ${anomalies.data.n_readings} readings`) : undefined}
        actions={
          <Select aria-label="Anomaly window" value={hours} onChange={(e) => setHours(Number(e.target.value))} className="h-8 w-auto py-0 text-xs">
            <option value={6}>last 6 h</option>
            <option value={24}>last 24 h</option>
            <option value={72}>last 3 d</option>
            <option value={168}>last 7 d</option>
          </Select>
        }
        padded={false}
      >
        {anomalies.isLoading ? (
          <Loading className="px-4" />
        ) : anomalies.error ? (
          <ErrorState error={anomalies.error} onRetry={() => anomalies.refetch()} />
        ) : !anomalies.data?.anomalies.length ? (
          <EmptyState title="Nothing unusual" description={detailed ? 'Rules: out-of-range intervals, rapid temperature rise, sensor saturation, instability, actuator state mismatches and data gaps.' : 'We look for values outside the target range, sudden temperature jumps, sensors at their limit, unstable conditions, equipment not doing what was asked and missing data.'} className="py-6" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Severity</th>
                  {detailed && <th>Type</th>}
                  <th>What happened</th>
                  <th>Start</th>
                  <th>End</th>
                  <th>Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {anomalies.data.anomalies.map((a, i) => (
                  <tr key={i}>
                    <td>
                      <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                    </td>
                    {detailed && <td className="font-mono text-xs">{a.type}</td>}
                    <td className="text-ink">{a.label}</td>
                    <td className="font-mono text-xs">{fmtDateTime(a.start, 'dd MMM HH:mm')}</td>
                    <td className="font-mono text-xs">{fmtDateTime(a.end, 'dd MMM HH:mm')}</td>
                    <td>{a.duration_minutes !== null ? fmtDuration(a.duration_minutes * 60) : '—'}</td>
                    <td>
                      <button type="button" onClick={() => ask(`Between ${fmtDateTime(a.start, 'dd MMM HH:mm')} and ${fmtDateTime(a.end, 'dd MMM HH:mm')} this was noticed: "${a.label}". What could have caused it and should I do anything?`)} className="inline-flex items-center gap-1 text-[11px] text-brand hover:underline" aria-label={`Ask MYCO AI about ${a.label}`}>
                        <Bot className="h-3 w-3" /> Ask
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <TechDetails title="Prediction log" summary="every stored prediction, checked against what was measured later">
      <Card
        title="Prediction log"
        subtitle="every stored prediction with its inputs; evaluated against the actual measurement when the target time passes"
        actions={
          <Tabs
            value={histKind}
            onChange={setHistKind}
            items={[
              { value: 'env_forecast', label: 'Forecasts' },
              { value: 'stage_estimate', label: 'Stage estimates' },
              { value: 'all', label: 'All' },
            ]}
          />
        }
        padded={false}
      >
        {predHistory.isLoading ? (
          <Loading className="px-4" />
        ) : predHistory.error ? (
          <ErrorState error={predHistory.error} />
        ) : !predHistory.data?.length ? (
          <EmptyState title="No predictions stored yet" description="The prediction task runs periodically in the background." className="py-6" />
        ) : (
          <div className="max-h-[420px] overflow-auto">
            <table className="table">
              <thead className="sticky top-0 bg-surface">
                <tr>
                  <th>Generated</th>
                  <th>Kind</th>
                  <th>Model</th>
                  <th>Output</th>
                  <th>Target time</th>
                  <th>Actual</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {predHistory.data.map((p) => (
                  <tr key={p.id}>
                    <td className="font-mono text-xs">{fmtDateTime(p.generated_at, 'dd MMM HH:mm')}</td>
                    <td>{titleCase(p.kind)}</td>
                    <td className="font-mono text-xs">{p.model_name} v{p.model_version}</td>
                    <td className="max-w-xs truncate font-mono text-[11px]" title={JSON.stringify(p.output)}>
                      {p.kind === 'env_forecast' ? `${String(p.output.metric ?? '').replace('_c', '').replace('relative_', '')} ${fmtNumber(p.output.value as number, 1)} [${fmtNumber((p.uncertainty?.lower as number) ?? null, 1)}–${fmtNumber((p.uncertainty?.upper as number) ?? null, 1)}]` : JSON.stringify(p.output).slice(0, 80)}
                    </td>
                    <td className="font-mono text-xs">{p.target_time ? fmtDateTime(p.target_time, 'HH:mm') : '—'}</td>
                    <td className="font-mono text-xs">{p.actual ? fmtNumber(p.actual.value as number, 1) : p.evaluated_at ? 'no data' : 'pending'}</td>
                    <td className="font-mono text-xs">{p.error && typeof p.error.abs_error === 'number' ? fmtNumber(p.error.abs_error as number, 2) : p.error?.status ? String(p.error.status).replace(/_/g, ' ') : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      </TechDetails>

      <Notice tone="neutral">
        {detailed ? (
          <KeyValue
            items={[
              { k: 'Environmental forecast', v: 'Least-squares linear trend over the last hour; band = ±2 × residual std, widened with horizon. Heuristic, not a calibrated interval.' },
              { k: 'Stage estimate', v: 'Calendar comparison of elapsed time with the profile\u2019s typical duration. Confidence reflects data availability, not biological certainty.' },
              { k: 'Anomalies / recommendations', v: 'Deterministic rules on stored readings and targets. Confidence levels are qualitative (how directly the evidence supports the finding).' },
              { k: 'Not available with this hardware', v: 'Contamination detection, yield prediction, colonisation %, CO₂-based FAE control (no camera, scale or CO₂ sensor).' },
            ]}
          />
        ) : (
          <p className="text-xs">
            <strong>How to read this page.</strong> Forecasts simply continue the recent trend; stage timing compares elapsed days with what is typical for the species; "unusual" findings and suggestions come from fixed rules on your readings. With the current sensors the app cannot detect contamination, predict yield or measure how far the substrate is colonised – that is where your own eyes come in.
          </p>
        )}
      </Notice>
    </div>
  );
}
