import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { endpoints, type RangeKey } from '@/api/endpoints';
import { qk, useAlerts } from '@/lib/queries';
import { useDevice } from '@/providers/DeviceProvider';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Stat, errorMessage, severityTone } from '@/components/ui';
import { SectionTitle, SourceTag } from '@/components/domain';
import { CHART_COLORS, PeriodBars } from '@/components/charts';
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber, fmtPercent } from '@/lib/format';
import { downloadText, toCsv } from '@/lib/utils';
import type { Alert } from '@/api/types';

const RANGES: { key: RangeKey; label: string; days: number }[] = [
  { key: '7d', label: 'Last 7 days', days: 7 },
  { key: '30d', label: 'Last 30 days', days: 30 },
];

/** Count alerts of the period by title so the table reads "Humidity out of range · 4×". */
export function groupAlerts(alerts: Alert[], since: Date): { title: string; severity: Alert['severity']; count: number; last: string }[] {
  const map = new Map<string, { title: string; severity: Alert['severity']; count: number; last: string }>();
  for (const a of alerts) {
    if (new Date(a.last_seen_at) < since) continue;
    const prev = map.get(a.title);
    if (prev) {
      prev.count += 1;
      if (a.last_seen_at > prev.last) prev.last = a.last_seen_at;
      if (a.severity === 'critical') prev.severity = 'critical';
    } else map.set(a.title, { title: a.title, severity: a.severity, count: 1, last: a.last_seen_at });
  }
  return [...map.values()].sort((x, y) => y.count - x.count);
}

export default function Stats() {
  const { device, deviceId } = useDevice();
  const toast = useToast();
  const [range, setRange] = useState<RangeKey>('7d');
  const tr = useMemo(() => ({ range }), [range]);
  const summary = useQuery({ queryKey: qk.analytics(deviceId ?? '', tr), queryFn: () => endpoints.analyticsSummary(deviceId!, tr), enabled: !!deviceId });
  const daily = useQuery({ queryKey: qk.periodic(deviceId ?? '', 'day', tr), queryFn: () => endpoints.periodic(deviceId!, 'day', tr), enabled: !!deviceId });
  const alerts = useAlerts({ device_id: deviceId ?? undefined, limit: 500 });
  const [exporting, setExporting] = useState<string | null>(null);
  const days = RANGES.find((r) => r.key === range)?.days ?? 7;
  const since = useMemo(() => new Date(Date.now() - days * 86400_000), [days]);

  const exportCsv = async (kind: 'readings' | 'daily') => {
    if (!deviceId) return;
    setExporting(kind);
    try {
      if (kind === 'readings') await endpoints.exportReadingsCsv(deviceId, tr);
      else await endpoints.exportPeriodicCsv(deviceId, 'day', tr);
    } catch (e) {
      toast.error('Export failed', errorMessage(e));
    } finally {
      setExporting(null);
    }
  };
  const exportSummary = () => {
    const s = summary.data;
    if (!s) return;
    const rows = (['temperature_c', 'relative_humidity_percent', 'substrate_moisture_raw'] as const).map((metric) => {
      const m = s[metric];
      return { metric, count: m.count, min: m.min, max: m.max, mean: m.mean, median: m.median, std: m.std, p5: m.p5, p95: m.p95 };
    });
    downloadText(`myco-summary-${s.device_id}-${range}.csv`, toCsv(rows));
  };

  if (!device) return <EmptyState title="No chamber selected" description="Pick a chamber in Connections (gear icon)." />;
  const s = summary.data;
  const items = daily.data?.items ?? [];
  const periodRows = items.map((it) => ({
    period: it.period.slice(5),
    fan: Math.round(it.fan_on_minutes),
    heater: Math.round(it.heater_on_minutes),
    humidifier: Math.round(it.humidifier_on_minutes),
    temp_out: Math.round(it.temperature_outside_minutes),
    rh_out: Math.round(it.humidity_outside_minutes),
  }));
  const grouped = groupAlerts(alerts.data ?? [], since);
  const tOut = s?.outside_range.temperature_c;
  const rhOut = s?.outside_range.relative_humidity_percent;
  const inRange = (o: typeof tOut) => (o && o.outside_fraction !== null ? 1 - o.outside_fraction : null);

  return (
    <div className="space-y-4 pb-10">
      <SectionTitle
        title="Stats"
        description={`What happened in ${device.name} over the last days: how much of the time conditions were on target, how long the equipment ran, where data was missing and which alerts fired.`}
        actions={
          <div className="stem-seg inline-flex rounded-full p-1" role="group" aria-label="Period">
            {RANGES.map((r) => (
              <button key={r.key} type="button" aria-pressed={range === r.key} onClick={() => setRange(r.key)} className="min-h-[32px] rounded-full px-3 text-[12px] font-semibold">
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      {summary.isLoading ? (
        <Loading label="Adding things up…" />
      ) : summary.error ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : s && s.n_readings === 0 ? (
        <EmptyState title="No readings in this period" description="The chamber has not reported anything in this period yet." />
      ) : s ? (
        <>
          <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
            <span>
              {fmtDateTime(s.start, 'dd MMM')} – {fmtDateTime(s.end, 'dd MMM')}
            </span>
            <span>· {s.n_readings} readings</span>
            <span>· data from</span>
            {s.sources.map((src) => (
              <SourceTag key={src} source={src} />
            ))}
            {s.targets && <span>· compared with the current targets ({s.targets.source_label ?? s.targets.source})</span>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <Stat label="Temperature on target" value={fmtPercent(inRange(tOut))} hint={tOut ? `${fmtDuration(tOut.below_seconds)} too cold · ${fmtDuration(tOut.above_seconds)} too warm (target ${tOut.min}–${tOut.max} °C)` : 'no target set'} tone={(tOut?.outside_fraction ?? 0) > 0.2 ? 'amber' : 'brand'} />
            </Card>
            <Card>
              <Stat label="Humidity on target" value={fmtPercent(inRange(rhOut))} hint={rhOut ? `${fmtDuration(rhOut.below_seconds)} too dry · ${fmtDuration(rhOut.above_seconds)} too damp (target ${rhOut.min}–${rhOut.max} %)` : 'no target set'} tone={(rhOut?.outside_fraction ?? 0) > 0.2 ? 'amber' : 'brand'} />
            </Card>
            <Card>
              <Stat label="Data received" value={fmtPercent(s.data_completeness, s.data_completeness !== null && s.data_completeness < 1 ? 1 : 0)} hint={s.missing_intervals.length ? `${s.missing_intervals.length} gap${s.missing_intervals.length === 1 ? '' : 's'} · ${fmtDuration(s.missing_seconds)} missing` : 'no gaps'} tone={s.data_completeness !== null && s.data_completeness < 0.9 ? 'amber' : undefined} />
            </Card>
            <Card>
              <Stat label="Flagged readings" value={s.invalid_readings} hint="readings with a sensor problem (excluded from the averages)" tone={s.invalid_readings > 0 ? 'amber' : undefined} />
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card title="Averages" subtitle="over all accepted readings in the period">
              <table className="table">
                <thead>
                  <tr>
                    <th />
                    <th>Average</th>
                    <th>Lowest</th>
                    <th>Highest</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="text-ink">Temperature</td>
                    <td className="font-mono">{fmtNumber(s.temperature_c.mean, 1)} °C</td>
                    <td className="font-mono">{fmtNumber(s.temperature_c.min, 1)}</td>
                    <td className="font-mono">{fmtNumber(s.temperature_c.max, 1)}</td>
                  </tr>
                  <tr>
                    <td className="text-ink">Humidity</td>
                    <td className="font-mono">{fmtNumber(s.relative_humidity_percent.mean, 0)} %</td>
                    <td className="font-mono">{fmtNumber(s.relative_humidity_percent.min, 0)}</td>
                    <td className="font-mono">{fmtNumber(s.relative_humidity_percent.max, 0)}</td>
                  </tr>
                  <tr>
                    <td className="text-ink">Substrate moisture</td>
                    <td className="font-mono">{fmtNumber(s.substrate_moisture_raw.mean, 0)}</td>
                    <td className="font-mono">{fmtNumber(s.substrate_moisture_raw.min, 0)}</td>
                    <td className="font-mono">{fmtNumber(s.substrate_moisture_raw.max, 0)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-ink-3">Moisture is the raw sensor value – it has no unit until the sensor is calibrated.</p>
            </Card>
            <Card title="Equipment run time" subtitle="how long each device was reported ON">
              <table className="table">
                <thead>
                  <tr>
                    <th />
                    <th>On</th>
                    <th>Share</th>
                    <th>Switches</th>
                  </tr>
                </thead>
                <tbody>
                  {(['fan', 'heater', 'humidifier'] as const).map((a) => (
                    <tr key={a}>
                      <td className="capitalize text-ink">{a}</td>
                      <td className="font-mono">{fmtDuration(s.actuator_runtime[a].on_seconds)}</td>
                      <td className="font-mono">{fmtPercent(s.actuator_runtime[a].duty_cycle)}</td>
                      <td className="font-mono">{s.actuator_runtime[a].switch_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-ink-3">Counted from the states the chamber reported, not from what was requested.</p>
            </Card>
            <Card title="Alerts in this period" subtitle={alerts.isLoading ? undefined : grouped.length ? `${grouped.reduce((n, g) => n + g.count, 0)} alerts` : 'none'} padded={false}>
              {alerts.isLoading ? (
                <Loading className="px-4" />
              ) : alerts.error ? (
                <ErrorState error={alerts.error} />
              ) : !grouped.length ? (
                <EmptyState title="No alerts" description="Nothing crossed a threshold in this period." className="py-6" />
              ) : (
                <ul className="divide-y divide-line">
                  {grouped.map((g) => (
                    <li key={g.title} className="flex items-start gap-2 px-4 py-2 text-xs">
                      <Badge tone={severityTone(g.severity)}>{g.severity}</Badge>
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-ink">{g.title}</p>
                        <p className="text-[11px] text-ink-3">last {fmtAgo(g.last)}</p>
                      </div>
                      <span className="font-mono text-ink-2">{g.count}×</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card
            title="Day by day"
            subtitle="equipment minutes per day, and the daily numbers below"
            actions={
              <div className="flex flex-wrap gap-1.5">
                <Button size="xs" variant="outline" icon={<Download className="h-3 w-3" />} onClick={() => exportCsv('daily')} loading={exporting === 'daily'}>
                  Daily CSV
                </Button>
                <Button size="xs" variant="outline" icon={<Download className="h-3 w-3" />} onClick={() => exportCsv('readings')} loading={exporting === 'readings'}>
                  Readings CSV
                </Button>
                <Button size="xs" variant="outline" icon={<Download className="h-3 w-3" />} onClick={exportSummary}>
                  Summary CSV
                </Button>
              </div>
            }
          >
            {daily.isLoading ? (
              <Loading />
            ) : daily.error ? (
              <ErrorState error={daily.error} onRetry={() => daily.refetch()} />
            ) : !items.length ? (
              <EmptyState title="No days with data" className="py-6" />
            ) : (
              <>
                <PeriodBars rows={periodRows} keys={[{ key: 'fan', label: 'Fan', color: CHART_COLORS.fan }, { key: 'heater', label: 'Heater', color: CHART_COLORS.heater }, { key: 'humidifier', label: 'Humidifier', color: CHART_COLORS.humidifier }]} height={180} />
                <div className="mt-3 overflow-x-auto">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Day</th>
                        <th>Readings</th>
                        <th>Temp avg (low–high)</th>
                        <th>Humidity avg (low–high)</th>
                        <th>Temp off target</th>
                        <th>Humidity off target</th>
                        <th>Fan</th>
                        <th>Heater</th>
                        <th>Humidifier</th>
                        <th>Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((it) => (
                        <tr key={it.period}>
                          <td className="font-mono text-xs">{it.period}</td>
                          <td className="font-mono">{it.n_readings}</td>
                          <td className="font-mono">{it.temperature_c ? `${fmtNumber(it.temperature_c.mean, 1)} (${fmtNumber(it.temperature_c.min, 1)}–${fmtNumber(it.temperature_c.max, 1)})` : '—'}</td>
                          <td className="font-mono">{it.relative_humidity_percent ? `${fmtNumber(it.relative_humidity_percent.mean, 0)} (${fmtNumber(it.relative_humidity_percent.min, 0)}–${fmtNumber(it.relative_humidity_percent.max, 0)})` : '—'}</td>
                          <td className="font-mono">{fmtDuration(it.temperature_outside_minutes * 60)}</td>
                          <td className="font-mono">{fmtDuration(it.humidity_outside_minutes * 60)}</td>
                          <td className="font-mono">{fmtDuration(it.fan_on_minutes * 60)}</td>
                          <td className="font-mono">{fmtDuration(it.heater_on_minutes * 60)}</td>
                          <td className="font-mono">{fmtDuration(it.humidifier_on_minutes * 60)}</td>
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

          {s.missing_intervals.length > 0 && (
            <Card title="When data was missing" subtitle={`gaps longer than ${s.expected_interval_seconds * 3} s between readings`} padded={false}>
              <div className="max-h-64 overflow-auto">
                <table className="table">
                  <thead className="sticky top-0 bg-surface">
                    <tr>
                      <th>From</th>
                      <th>For</th>
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
            </Card>
          )}
          <p className="text-[11px] text-ink-3">Only accepted readings are counted; values the server rejected as implausible are listed as flagged. Simulated data is labelled and should not be mixed with hardware data in reports.</p>
        </>
      ) : null}
    </div>
  );
}
