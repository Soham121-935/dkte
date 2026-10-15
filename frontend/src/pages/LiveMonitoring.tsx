import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { endpoints, type RangeKey, type TimeRange } from '@/api/endpoints';
import { useDevice } from '@/providers/DeviceProvider';
import { useLive } from '@/providers/LiveProvider';
import { useToast } from '@/providers/ToastProvider';
import { useLatest, useSeries, qk } from '@/lib/queries';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Loading, Notice, Skeleton, Tabs, errorMessage } from '@/components/ui';
import { ConnectionBadge, QualityBadge, SectionTitle, SourceTag } from '@/components/domain';
import { ReadingCards } from '@/components/ReadingCards';
import { ActuatorChart, MetricChart, gapsFromRows, toChartRows } from '@/components/charts';
import { AlertsPanel } from '@/components/AlertsPanel';
import { fmtDateTime, fmtDuration, fmtNumber, fmtTime } from '@/lib/format';
import { fromLocalInput } from '@/lib/utils';
import { useViewMode } from '@/providers/ViewModeProvider';
import { TechDetails } from '@/components/Technical';

const RANGES: { value: RangeKey; label: string }[] = [
  { value: '1h', label: '1 h' },
  { value: '6h', label: '6 h' },
  { value: '24h', label: '24 h' },
  { value: '7d', label: '7 d' },
  { value: '30d', label: '30 d' },
];

export function useTimeRange(defaultRange: RangeKey = '24h') {
  const [range, setRange] = useState<RangeKey | 'custom'>(defaultRange);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const tr: TimeRange = useMemo(() => {
    if (range !== 'custom') return { range };
    const f = fromLocalInput(from);
    const t = fromLocalInput(to);
    return { from: f ?? undefined, to: t ?? undefined, range: f ? undefined : '24h' };
  }, [range, from, to]);
  return { range, setRange, from, setFrom, to, setTo, tr };
}

export function TimeRangePicker({ ctrl }: { ctrl: ReturnType<typeof useTimeRange> }) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Tabs value={ctrl.range} onChange={ctrl.setRange} items={[...RANGES, { value: 'custom' as const, label: 'Custom' }]} />
      {ctrl.range === 'custom' && (
        <>
          <Field label="From" htmlFor="tr-from">
            <Input id="tr-from" type="datetime-local" value={ctrl.from} onChange={(e) => ctrl.setFrom(e.target.value)} className="h-8 py-0 text-xs" />
          </Field>
          <Field label="To" htmlFor="tr-to">
            <Input id="tr-to" type="datetime-local" value={ctrl.to} onChange={(e) => ctrl.setTo(e.target.value)} className="h-8 py-0 text-xs" />
          </Field>
        </>
      )}
    </div>
  );
}

export default function LiveMonitoring() {
  const { device, deviceId } = useDevice();
  const { detailed } = useViewMode();
  const { latestReadings, connected } = useLive();
  const toast = useToast();
  const ctrl = useTimeRange('6h');
  const latest = useLatest(deviceId);
  const series = useSeries(deviceId, ctrl.tr, 500);
  const [tab, setTab] = useState<'charts' | 'readings' | 'rejections' | 'alerts'>('charts');
  const readings = useQuery({ queryKey: ['telemetry', 'readings', deviceId, ctrl.tr], queryFn: () => endpoints.readings(deviceId!, { ...ctrl.tr, limit: 200 }), enabled: !!deviceId && tab === 'readings' });
  const rejections = useQuery({ queryKey: qk.events({ category: 'validation', device_id: deviceId }), queryFn: () => endpoints.systemEvents({ category: 'validation', device_id: deviceId!, limit: 50 }), enabled: !!deviceId && tab === 'rejections', refetchInterval: 20000 });

  useEffect(() => {
    if (window.location.hash === '#alerts') setTab('alerts');
  }, []);

  const reading = (deviceId && latestReadings[deviceId]) || latest.data?.reading || null;
  const targets = latest.data?.targets ?? series.data?.targets ?? null;
  const rows = useMemo(() => (series.data ? toChartRows(series.data.points, series.data.bucket_seconds) : []), [series.data]);
  const gaps = useMemo(() => (series.data ? gapsFromRows(rows, series.data.bucket_seconds) : []), [rows, series.data]);
  const [exporting, setExporting] = useState(false);

  const exportCsv = async () => {
    if (!deviceId) return;
    setExporting(true);
    try {
      await endpoints.exportReadingsCsv(deviceId, ctrl.tr);
      toast.success('CSV export started');
    } catch (e) {
      toast.error('Export failed', errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  if (!device) return <EmptyState title="No chamber selected" description="Add a chamber controller under Device Management or turn on the demo simulator." />;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Live Monitoring"
        description={detailed ? 'Real-time sensor values with quality flags, time-series history, data gaps and alerts. Every value shows its origin (measured, simulated) and timestamp.' : 'The latest readings from your chamber and how they changed over time. Every value shows when it was measured and whether it is real or simulated.'}
        actions={
          <>
            <ConnectionBadge status={device.connection_status} lastSeen={device.last_seen_at} />
            {!connected && <Badge tone="danger">live feed offline</Badge>}
            <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => { latest.refetch(); series.refetch(); }}>
              Refresh
            </Button>
          </>
        }
      />
      {device.connection_status !== 'online' && (
        <Notice tone={device.connection_status === 'offline' ? 'danger' : 'amber'}>
          The chamber is <strong>{device.connection_status === 'offline' ? 'DISCONNECTED' : device.connection_status.toUpperCase()}</strong>. The values below are the most recent stored readings, not live ones.
        </Notice>
      )}

      <ReadingCards reading={reading} targets={targets} loading={latest.isLoading} />

      <TechDetails title="All sensor channels" summary={latest.data?.reading ? (detailed ? `message ${latest.data.reading.message_id?.slice(0, 8) ?? '—'} · schema v${latest.data.reading.schema_version} · received ${fmtTime(latest.data.reading.received_at)}` : `last message received ${fmtTime(latest.data.reading.received_at)}`) : 'waiting for the first message'}>
        {latest.isLoading ? (
          <Loading className="px-4" />
        ) : latest.error ? (
          <ErrorState error={latest.error} onRetry={() => latest.refetch()} />
        ) : !latest.data?.sensors.length ? (
          <EmptyState title="No readings yet" description="The chamber has not sent any accepted readings." className="py-6" />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Sensor</th>
                  <th>Value</th>
                  <th>Unit</th>
                  <th>Quality</th>
                  <th>Source</th>
                  <th>Measured at</th>
                </tr>
              </thead>
              <tbody>
                {latest.data.sensors.map((s) => (
                  <tr key={s.sensor_type}>
                    <td className={detailed ? 'font-mono text-xs text-ink' : 'text-xs text-ink'}>{detailed ? s.sensor_type : s.sensor_type.replace(/_/g, ' ')}</td>
                    <td className="font-mono">{typeof s.value === 'boolean' ? (s.value ? 'ON' : 'OFF') : s.value === null ? '—' : fmtNumber(s.value, s.unit === '°C' ? 1 : 0)}</td>
                    <td>{s.unit}</td>
                    <td>{s.quality === 'ok' ? <Badge tone="brand">ok</Badge> : <QualityBadge quality={s.quality} />}</td>
                    <td>
                      <SourceTag source={s.source} />
                    </td>
                    <td className="font-mono text-xs">{fmtDateTime(s.measured_at, 'dd MMM HH:mm:ss')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {latest.data?.reading?.quality?.warnings?.length ? (
          <div className="border-t border-line px-4 py-2 text-[11px] text-amber">Validation warnings: {latest.data.reading.quality.warnings.join('; ')}</div>
        ) : null}
      </TechDetails>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'charts', label: 'Charts' },
            { value: 'readings', label: detailed ? 'Raw readings' : 'Readings table' },
            { value: 'rejections', label: detailed ? 'Rejected messages' : 'Data problems' },
            { value: 'alerts', label: 'Alerts' },
          ]}
        />
        {tab !== 'alerts' && (
          <div className="flex flex-wrap items-end gap-2">
            <TimeRangePicker ctrl={ctrl} />
            <Button size="sm" variant="outline" icon={<Download className="h-3.5 w-3.5" />} onClick={exportCsv} loading={exporting}>
              Export CSV
            </Button>
          </div>
        )}
      </div>

      {tab === 'charts' && (
        <div className="space-y-4">
          {series.isLoading ? (
            <Skeleton className="h-[300px] w-full" />
          ) : series.error ? (
            <ErrorState error={series.error} onRetry={() => series.refetch()} />
          ) : series.data && !series.data.points.length ? (
            <EmptyState title="No data in this range" description="Choose a wider range or check that the chamber is sending readings." />
          ) : series.data ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
                <span>{series.data.n_readings} readings</span>
                {detailed && <span>· bucket {fmtDuration(series.data.bucket_seconds)}</span>}
                {detailed ? <span>· sources:</span> : <span>·</span>}
                {series.data.sources.map((s) => (
                  <SourceTag key={s} source={s} />
                ))}
                {gaps.length > 0 && <Badge tone="danger">{gaps.length} data gap{gaps.length > 1 ? 's' : ''} (shaded)</Badge>}
                {targets && <span>· {detailed ? 'target band from' : 'target range from'} {targets.source_label ?? targets.source}</span>}
              </div>
              <Card title="Temperature (°C)">
                <MetricChart rows={rows} metric="temperature_c" targets={targets} gaps={gaps} height={240} />
              </Card>
              <Card title="Humidity (%)" subtitle={detailed ? "DHT11 readings above ~90 % RH are outside the sensor's rated range and should be treated as approximate." : 'Readings above about 90 % are at the edge of what the sensor can measure – treat them as approximate.'}>
                <MetricChart rows={rows} metric="relative_humidity_percent" targets={targets} gaps={gaps} height={240} />
              </Card>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card title={detailed ? 'Substrate moisture (raw ADC counts)' : 'Substrate moisture (raw sensor value)'} subtitle="Not calibrated – watch the trend rather than the exact number.">
                  <MetricChart rows={rows} metric="substrate_moisture_raw" targets={targets} gaps={gaps} height={200} />
                </Card>
                <Card title="Equipment activity" subtitle={detailed ? 'fraction of each bucket the device reported the actuator ON' : 'how much of the time each piece of equipment was on'}>
                  <ActuatorChart rows={rows} height={200} />
                  <div className="mt-1 flex gap-3 text-[11px] text-ink-3">
                    <span><span className="inline-block h-2 w-2 rounded-sm" style={{ background: '#6ea4ec' }} /> fan</span>
                    <span><span className="inline-block h-2 w-2 rounded-sm" style={{ background: '#ec6262' }} /> heater</span>
                    <span><span className="inline-block h-2 w-2 rounded-sm" style={{ background: '#5bd4a0' }} /> humidifier</span>
                  </div>
                </Card>
              </div>
              {gaps.length > 0 && (
                <Card title="Gaps in the data" subtitle="periods when no readings arrived" padded={false}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Start</th>
                        <th>End</th>
                        <th>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {gaps.map((g, i) => (
                        <tr key={i}>
                          <td className="font-mono text-xs">{fmtDateTime(new Date(g.start).toISOString(), 'dd MMM HH:mm')}</td>
                          <td className="font-mono text-xs">{fmtDateTime(new Date(g.end).toISOString(), 'dd MMM HH:mm')}</td>
                          <td>{fmtDuration((g.end - g.start) / 1000)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              )}
            </>
          ) : null}
        </div>
      )}

      {tab === 'readings' && (
        <Card title={detailed ? 'Raw readings (newest first, max 200)' : 'Readings (newest first, up to 200)'} padded={false}>
          {readings.isLoading ? (
            <Loading className="px-4" />
          ) : readings.error ? (
            <ErrorState error={readings.error} onRetry={() => readings.refetch()} />
          ) : !readings.data?.length ? (
            <EmptyState title="No readings in this range" className="py-6" />
          ) : (
            <div className="max-h-[520px] overflow-auto">
              <table className="table">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th>Measured</th>
                    <th>T °C</th>
                    <th>RH %</th>
                    <th>Moist.</th>
                    <th>Fan</th>
                    <th>Heater</th>
                    <th>Humid.</th>
                    <th>Quality</th>
                    <th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {readings.data.map((r) => {
                    const bad = Object.entries(r.quality).filter(([k, v]) => typeof v === 'string' && v !== 'ok' && k !== 'transport').map(([k, v]) => `${k}: ${v}`);
                    return (
                      <tr key={r.id}>
                        <td className="font-mono text-xs">{fmtDateTime(r.measured_at, 'dd MMM HH:mm:ss')}</td>
                        <td className="font-mono">{fmtNumber(r.temperature_c, 1)}</td>
                        <td className="font-mono">{fmtNumber(r.relative_humidity_percent, 0)}</td>
                        <td className="font-mono">{fmtNumber(r.substrate_moisture_raw, 0)}</td>
                        <td>{r.fan_state === null ? '—' : r.fan_state ? 'ON' : 'off'}</td>
                        <td>{r.heater_state === null ? '—' : r.heater_state ? 'ON' : 'off'}</td>
                        <td>{r.humidifier_state === null ? '—' : r.humidifier_state ? 'ON' : 'off'}</td>
                        <td>{bad.length ? <Badge tone="danger" title={bad.join(', ')}>{bad.length} flag{bad.length > 1 ? 's' : ''}</Badge> : <Badge tone="brand">ok</Badge>}</td>
                        <td>
                          <SourceTag source={r.source} compact />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'rejections' && (
        <Card title={detailed ? 'Rejected / quarantined messages' : 'Messages that were not accepted'} subtitle={detailed ? 'Messages that failed schema, timestamp or plausibility validation are not stored as readings; the rejection reason is logged here.' : 'Readings that looked wrong (impossible values, bad timestamps, wrong format) are kept out of your data. The reason is listed here.'} padded={false}>
          {rejections.isLoading ? (
            <Loading className="px-4" />
          ) : rejections.error ? (
            <ErrorState error={rejections.error} onRetry={() => rejections.refetch()} />
          ) : !rejections.data?.length ? (
            <EmptyState title="No problems" description="All recent messages from this chamber were accepted." className="py-6" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Level</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {rejections.data.map((e) => (
                  <tr key={e.id}>
                    <td className="font-mono text-xs">{fmtDateTime(e.created_at, 'dd MMM HH:mm:ss')}</td>
                    <td>
                      <Badge tone={e.level === 'error' ? 'danger' : e.level === 'warning' ? 'amber' : 'neutral'}>{e.level}</Badge>
                    </td>
                    <td>
                      {e.message}
                      {e.data && Object.keys(e.data).length > 0 && <pre className="mt-1 max-w-xl overflow-x-auto rounded bg-surface-2 p-1.5 font-mono text-[10px] text-ink-3">{JSON.stringify(e.data)}</pre>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === 'alerts' && (
        <Card title="Alerts" subtitle={detailed ? 'Deduplicated with cooldown; auto-resolved when the condition clears.' : 'Alerts clear themselves once the problem is gone; mark them as seen so others know you noticed.'}>
          <div id="alerts" />
          <AlertsPanel deviceId={deviceId} />
        </Card>
      )}
    </div>
  );
}
