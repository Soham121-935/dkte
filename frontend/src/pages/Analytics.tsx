import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { qk, useBatches } from '@/lib/queries';
import { useDevice } from '@/providers/DeviceProvider';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card, EmptyState, ErrorState, KeyValue, Loading, Notice, Select, Stat, Tabs, errorMessage } from '@/components/ui';
import { SectionTitle, SourceTag } from '@/components/domain';
import { CHART_COLORS, DutyBars, Histogram, PeriodBars } from '@/components/charts';
import { TimeRangePicker, useTimeRange } from '@/pages/LiveMonitoring';
import { fmtDateTime, fmtDays, fmtDuration, fmtNumber, fmtPercent } from '@/lib/format';
import { downloadText, toCsv } from '@/lib/utils';
import { useViewMode } from '@/providers/ViewModeProvider';

export default function Analytics() {
  const { device, deviceId } = useDevice();
  const { detailed } = useViewMode();
  const toast = useToast();
  const ctrl = useTimeRange('7d');
  const [period, setPeriod] = useState<'day' | 'week'>('day');
  const summary = useQuery({ queryKey: qk.analytics(deviceId ?? '', ctrl.tr), queryFn: () => endpoints.analyticsSummary(deviceId!, ctrl.tr), enabled: !!deviceId });
  const periodic = useQuery({ queryKey: qk.periodic(deviceId ?? '', period, ctrl.tr), queryFn: () => endpoints.periodic(deviceId!, period, ctrl.tr), enabled: !!deviceId });
  const batches = useBatches();
  const batch = useMemo(() => (batches.data ?? []).find((b) => b.device_id === deviceId && b.status === 'active') ?? (batches.data ?? []).find((b) => b.device_id === deviceId) ?? null, [batches.data, deviceId]);
  const [batchId, setBatchId] = useState<number | null>(null);
  const selectedBatch = batchId ?? batch?.id ?? null;
  const stageEnv = useQuery({ queryKey: qk.stageEnv(selectedBatch ?? 0), queryFn: () => endpoints.stageEnvironment(selectedBatch!), enabled: !!selectedBatch });
  const [exporting, setExporting] = useState<string | null>(null);

  const exportPeriodic = async () => {
    if (!deviceId) return;
    setExporting('periodic');
    try {
      await endpoints.exportPeriodicCsv(deviceId, period, ctrl.tr);
    } catch (e) {
      toast.error('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  };
  const exportReadings = async () => {
    if (!deviceId) return;
    setExporting('readings');
    try {
      await endpoints.exportReadingsCsv(deviceId, ctrl.tr);
    } catch (e) {
      toast.error('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  };
  const exportSummary = () => {
    if (!summary.data) return;
    const s = summary.data;
    const rows = [
      { metric: 'temperature_c', ...s.temperature_c, bins: undefined },
      { metric: 'relative_humidity_percent', ...s.relative_humidity_percent, bins: undefined },
      { metric: 'substrate_moisture_raw', ...s.substrate_moisture_raw, bins: undefined },
    ].map((r) => ({ metric: r.metric, count: r.count, min: r.min, max: r.max, mean: r.mean, median: r.median, std: r.std, p5: r.p5, p95: r.p95 }));
    downloadText(`myco-summary-${s.device_id}.csv`, toCsv(rows));
  };

  if (!device) return <EmptyState title="No device selected" />;
  const s = summary.data;

  const periodRows = (periodic.data?.items ?? []).map((it) => ({
    period: it.period,
    fan: Math.round(it.fan_on_minutes),
    heater: Math.round(it.heater_on_minutes),
    humidifier: Math.round(it.humidifier_on_minutes),
    temp_out: Math.round(it.temperature_outside_minutes),
    rh_out: Math.round(it.humidity_outside_minutes),
  }));

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Analytics and Reports"
        description={detailed ? 'Descriptive statistics over stored readings: distributions, time outside target ranges, actuator runtimes, data completeness and stage-by-stage environment. Associations are shown without causal claims.' : 'A look back over days or weeks: how often conditions were off target, how long the equipment ran, where data was missing and what the environment was like in each growth stage. Export everything as CSV.'}
        actions={
          <>
            <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={exportReadings} loading={exporting === 'readings'}>
              Readings CSV
            </Button>
            <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={exportSummary} disabled={!s}>
              Summary CSV
            </Button>
          </>
        }
      />
      <TimeRangePicker ctrl={ctrl} />

      {summary.isLoading ? (
        <Loading label="Computing summary…" />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : s && s.n_readings === 0 ? (
        <EmptyState title="No readings in this range" description="Choose another range or wait for telemetry." />
      ) : s ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span>
              {fmtDateTime(s.start, 'dd MMM HH:mm')} – {fmtDateTime(s.end, 'dd MMM HH:mm')}
            </span>
            <span>· {s.n_readings} readings</span>
            <span>· sources:</span>
            {s.sources.map((src) => (
              <SourceTag key={src} source={src} />
            ))}
            {s.targets && <span>· targets: {s.targets.source_label ?? s.targets.source}</span>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <Stat label="Data completeness" value={fmtPercent(s.data_completeness, s.data_completeness !== null && s.data_completeness < 1 ? 1 : 0)} hint={`${fmtDuration(s.missing_seconds)} missing · ${s.missing_intervals.length} gap(s) · expected every ${s.expected_interval_seconds}s`} tone={s.data_completeness !== null && s.data_completeness < 0.9 ? 'amber' : undefined} />
            </Card>
            <Card>
              <Stat label="Invalid readings" value={s.invalid_readings} hint="readings with at least one flagged field" tone={s.invalid_readings > 0 ? 'amber' : undefined} />
            </Card>
            <Card>
              <Stat label="Temp outside range" value={fmtPercent(s.outside_range.temperature_c?.outside_fraction)} hint={s.outside_range.temperature_c ? `${fmtDuration(s.outside_range.temperature_c.below_seconds)} below · ${fmtDuration(s.outside_range.temperature_c.above_seconds)} above (${s.outside_range.temperature_c.min}–${s.outside_range.temperature_c.max} °C, current targets applied to the whole range)` : 'no target'} tone={(s.outside_range.temperature_c?.outside_fraction ?? 0) > 0.2 ? 'amber' : undefined} />
            </Card>
            <Card>
              <Stat label="RH outside range" value={fmtPercent(s.outside_range.relative_humidity_percent?.outside_fraction)} hint={s.outside_range.relative_humidity_percent ? `${fmtDuration(s.outside_range.relative_humidity_percent.below_seconds)} below · ${fmtDuration(s.outside_range.relative_humidity_percent.above_seconds)} above (${s.outside_range.relative_humidity_percent.min}–${s.outside_range.relative_humidity_percent.max} %)` : 'no target'} tone={(s.outside_range.relative_humidity_percent?.outside_fraction ?? 0) > 0.2 ? 'amber' : undefined} />
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {(
              [
                ['temperature_c', 'Temperature distribution', '°C', CHART_COLORS.temperature, [s.targets?.temperature_min_c ?? null, s.targets?.temperature_max_c ?? null]],
                ['relative_humidity_percent', 'Humidity distribution', '%', CHART_COLORS.humidity, [s.targets?.humidity_min_percent ?? null, s.targets?.humidity_max_percent ?? null]],
                ['substrate_moisture_raw', 'Substrate moisture distribution', 'raw', CHART_COLORS.moisture, [null, null]],
              ] as const
            ).map(([key, title, unit, color, range]) => {
              const m = s[key];
              return (
                <Card key={key} title={title} subtitle={`n=${m.count} · bins outside target shown in red`}>
                  <Histogram bins={m.bins} unit={unit} color={color} range={range as [number | null, number | null]} />
                  <KeyValue
                    className="mt-2"
                    items={[
                      { k: 'Mean / median', v: `${fmtNumber(m.mean, 1)} / ${fmtNumber(m.median, 1)} ${unit}` },
                      { k: 'Min – max', v: `${fmtNumber(m.min, 1)} – ${fmtNumber(m.max, 1)} ${unit}` },
                      { k: 'Std · p5–p95', v: `${fmtNumber(m.std, 2)} · ${fmtNumber(m.p5, 1)}–${fmtNumber(m.p95, 1)}` },
                    ]}
                  />
                </Card>
              );
            })}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Actuator duty cycles" subtitle="share of known time each actuator was reported ON">
              <DutyBars
                data={(['fan', 'heater', 'humidifier'] as const).map((a) => ({
                  name: a,
                  value: Math.round((s.actuator_runtime[a].duty_cycle ?? 0) * 100),
                  label: `${fmtPercent(s.actuator_runtime[a].duty_cycle)} · ${fmtDuration(s.actuator_runtime[a].on_seconds)} on · ${s.actuator_runtime[a].switch_count} switches`,
                  color: a === 'fan' ? CHART_COLORS.fan : a === 'heater' ? CHART_COLORS.heater : CHART_COLORS.humidifier,
                }))}
              />
              <table className="table mt-2">
                <thead>
                  <tr>
                    <th>Actuator</th>
                    <th>On time</th>
                    <th>Switches</th>
                  </tr>
                </thead>
                <tbody>
                  {(['fan', 'heater', 'humidifier'] as const).map((a) => (
                    <tr key={a}>
                      <td className="capitalize text-ink">{a}</td>
                      <td className="font-mono">{fmtDuration(s.actuator_runtime[a].on_seconds)}</td>
                      <td className="font-mono">{s.actuator_runtime[a].switch_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card
              className="lg:col-span-2"
              title={`${period === 'day' ? 'Daily' : 'Weekly'} summary`}
              subtitle="actuator minutes and time outside target per period"
              actions={
                <>
                  <Tabs value={period} onChange={setPeriod} items={[{ value: 'day', label: 'Daily' }, { value: 'week', label: 'Weekly' }]} />
                  <Button size="xs" variant="outline" icon={<Download className="h-3 w-3" />} onClick={exportPeriodic} loading={exporting === 'periodic'}>
                    CSV
                  </Button>
                </>
              }
            >
              {periodic.isLoading ? (
                <Loading />
              ) : periodic.error ? (
                <ErrorState error={periodic.error} />
              ) : (
                <>
                  <PeriodBars rows={periodRows} keys={[{ key: 'fan', label: 'Fan', color: CHART_COLORS.fan }, { key: 'heater', label: 'Heater', color: CHART_COLORS.heater }, { key: 'humidifier', label: 'Humidifier', color: CHART_COLORS.humidifier }]} />
                  <div className="mt-2 max-h-56 overflow-auto">
                    <table className="table">
                      <thead className="sticky top-0 bg-surface">
                        <tr>
                          <th>Period</th>
                          <th>n</th>
                          <th>T mean (min–max)</th>
                          <th>RH mean (min–max)</th>
                          <th>T out</th>
                          <th>RH out</th>
                          <th>Sources</th>
                        </tr>
                      </thead>
                      <tbody>
                        {periodic.data?.items.map((it) => (
                          <tr key={it.period}>
                            <td className="font-mono text-xs">{it.period}</td>
                            <td className="font-mono">{it.n_readings}</td>
                            <td className="font-mono">{it.temperature_c ? `${fmtNumber(it.temperature_c.mean, 1)} (${fmtNumber(it.temperature_c.min, 1)}–${fmtNumber(it.temperature_c.max, 1)})` : '—'}</td>
                            <td className="font-mono">{it.relative_humidity_percent ? `${fmtNumber(it.relative_humidity_percent.mean, 0)} (${fmtNumber(it.relative_humidity_percent.min, 0)}–${fmtNumber(it.relative_humidity_percent.max, 0)})` : '—'}</td>
                            <td className="font-mono">{fmtDuration(it.temperature_outside_minutes * 60)}</td>
                            <td className="font-mono">{fmtDuration(it.humidity_outside_minutes * 60)}</td>
                            <td>
                              {it.sources.map((src) => (
                                <SourceTag key={src} source={src} compact />
                              ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Missing-data intervals" subtitle={`gaps longer than ${s.expected_interval_seconds * 3}s between accepted readings`} padded={false}>
              {!s.missing_intervals.length ? (
                <EmptyState title="No gaps" description="Telemetry arrived continuously in this range." className="py-6" />
              ) : (
                <div className="max-h-72 overflow-auto">
                  <table className="table">
                    <thead className="sticky top-0 bg-surface">
                      <tr>
                        <th>Start</th>
                        <th>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.missing_intervals.map((g, i) => (
                        <tr key={i}>
                          <td className="font-mono text-xs">{fmtDateTime(g.start, 'dd MMM HH:mm')}</td>
                          <td>{fmtDuration(g.seconds)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card
              className="lg:col-span-2"
              title="Environment per growth stage"
              subtitle="descriptive only – one batch cannot establish what caused a faster or slower stage"
              actions={
                <Select aria-label="Batch" value={selectedBatch ?? ''} onChange={(e) => setBatchId(Number(e.target.value))} className="h-8 w-auto py-0 text-xs">
                  {!batches.data?.length && <option value="">no batches</option>}
                  {batches.data?.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.code}
                    </option>
                  ))}
                </Select>
              }
              padded={false}
            >
              {!selectedBatch ? (
                <EmptyState title="No batch" className="py-6" />
              ) : stageEnv.isLoading ? (
                <Loading className="px-4" />
              ) : stageEnv.error ? (
                <ErrorState error={stageEnv.error} />
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Stage</th>
                          <th>Started</th>
                          <th>Duration</th>
                          <th>Typical</th>
                          <th>n</th>
                          <th>T mean ± std</th>
                          <th>RH mean ± std</th>
                          <th>Moisture mean</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stageEnv.data?.stages.map((st) => {
                          const typical = st.typical_duration_days;
                          const flag = st.duration_days !== null && typical && st.ended_at ? (st.duration_days < typical.min ? 'shorter' : st.duration_days > typical.max ? 'longer' : 'typical') : null;
                          return (
                            <tr key={st.stage_key}>
                              <td className="text-ink">
                                {st.stage_name}
                                {!st.ended_at && <Badge tone="brand" className="ml-1">current</Badge>}
                              </td>
                              <td className="font-mono text-xs">{fmtDateTime(st.started_at, 'dd MMM')}</td>
                              <td>
                                {fmtDays(st.duration_days)}
                                {flag && <Badge tone={flag === 'typical' ? 'neutral' : 'amber'} className="ml-1">{flag}</Badge>}
                              </td>
                              <td>{typical ? `${typical.min}–${typical.max} d` : '—'}</td>
                              <td className="font-mono">{st.n_readings}</td>
                              <td className="font-mono">{st.temperature_c ? `${fmtNumber(st.temperature_c.mean, 1)} ± ${fmtNumber(st.temperature_c.std, 1)}` : '—'}</td>
                              <td className="font-mono">{st.relative_humidity_percent ? `${fmtNumber(st.relative_humidity_percent.mean, 0)} ± ${fmtNumber(st.relative_humidity_percent.std, 0)}` : '—'}</td>
                              <td className="font-mono">{st.substrate_moisture_raw ? fmtNumber(st.substrate_moisture_raw.mean, 0) : '—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="border-t border-line px-4 py-2 text-[11px] text-ink-3">{stageEnv.data?.note}</p>
                </>
              )}
            </Card>
          </div>
          <Notice tone="neutral">Reading counts and statistics include only accepted readings; rejected/implausible values are excluded and counted under invalid readings. Simulated data is labelled and should not be mixed with hardware data in reports.</Notice>
        </>
      ) : null}
    </div>
  );
}
