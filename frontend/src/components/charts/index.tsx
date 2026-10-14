import { useMemo } from 'react';
import { Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { format } from 'date-fns';
import type { ForecastMetric, SeriesPoint, Targets } from '@/api/types';
import { fmtDateTime, fmtNumber } from '@/lib/format';

const COLORS = {
  temperature: '#e8aa40',
  humidity: '#56c4c8',
  moisture: '#9d8cf0',
  fan: '#6ea4ec',
  heater: '#ec6262',
  humidifier: '#5bd4a0',
  band: 'rgb(var(--c-brand))',
};

function tooltipStyle() {
  return {
    contentStyle: { background: 'rgb(var(--c-surface))', border: '1px solid rgb(var(--c-line-strong))', borderRadius: 6, fontSize: 12, color: 'rgb(var(--c-ink))' },
    labelStyle: { color: 'rgb(var(--c-ink-3))', marginBottom: 4 },
    itemStyle: { padding: 0 },
  };
}

function tickFormatter(spanMs: number) {
  return (v: number) => {
    const d = new Date(v);
    if (spanMs > 3 * 24 * 3600 * 1000) return format(d, 'dd MMM');
    if (spanMs > 24 * 3600 * 1000) return format(d, 'dd MMM HH:mm');
    return format(d, 'HH:mm');
  };
}

export interface ChartRow {
  ts: number;
  temperature_c: number | null;
  relative_humidity_percent: number | null;
  substrate_moisture_raw: number | null;
  fan_on_ratio: number | null;
  heater_on_ratio: number | null;
  humidifier_on_ratio: number | null;
  invalid_count: number;
  source: string;
}

/** Converts bucketed points to chart rows, inserting null rows for gaps so lines break. */
export function toChartRows(points: SeriesPoint[], bucketSeconds: number): ChartRow[] {
  const rows: ChartRow[] = [];
  let prev: number | null = null;
  for (const p of points) {
    const ts = new Date(p.t).getTime();
    if (prev !== null && ts - prev > bucketSeconds * 1000 * 2.5) {
      rows.push({ ts: prev + bucketSeconds * 1000, temperature_c: null, relative_humidity_percent: null, substrate_moisture_raw: null, fan_on_ratio: null, heater_on_ratio: null, humidifier_on_ratio: null, invalid_count: 0, source: 'gap' });
    }
    rows.push({ ts, temperature_c: p.temperature_c, relative_humidity_percent: p.relative_humidity_percent, substrate_moisture_raw: p.substrate_moisture_raw, fan_on_ratio: p.fan_on_ratio, heater_on_ratio: p.heater_on_ratio, humidifier_on_ratio: p.humidifier_on_ratio, invalid_count: p.invalid_count, source: p.source });
    prev = ts;
  }
  return rows;
}

export function gapsFromRows(rows: ChartRow[], bucketSeconds: number): { start: number; end: number }[] {
  const gaps: { start: number; end: number }[] = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].source === 'gap') {
      const next = rows[i + 1];
      if (next) gaps.push({ start: rows[i - 1].ts + bucketSeconds * 1000, end: next.ts });
    }
  }
  return gaps;
}

interface MetricChartProps {
  rows: ChartRow[];
  metric: 'temperature_c' | 'relative_humidity_percent' | 'substrate_moisture_raw';
  targets?: Targets | null;
  height?: number;
  gaps?: { start: number; end: number }[];
  domain?: [number | 'auto', number | 'auto'];
}

const METRIC_META = {
  temperature_c: { label: 'Temperature', unit: '°C', color: COLORS.temperature, digits: 1 },
  relative_humidity_percent: { label: 'Relative humidity', unit: '%', color: COLORS.humidity, digits: 0 },
  substrate_moisture_raw: { label: 'Substrate moisture (raw ADC)', unit: '', color: COLORS.moisture, digits: 0 },
} as const;

export function MetricChart({ rows, metric, targets, height = 220, gaps = [], domain }: MetricChartProps) {
  const meta = METRIC_META[metric];
  const span = rows.length > 1 ? rows[rows.length - 1].ts - rows[0].ts : 3600_000;
  const band = useMemo(() => {
    if (!targets) return null;
    if (metric === 'temperature_c') return [targets.temperature_min_c, targets.temperature_max_c] as const;
    if (metric === 'relative_humidity_percent') return [targets.humidity_min_percent, targets.humidity_max_percent] as const;
    return [targets.moisture_min_raw, null] as const;
  }, [targets, metric]);
  if (!rows.length) return <div className="flex items-center justify-center text-xs text-ink-3" style={{ height }}>No data in this range</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={tickFormatter(span)} minTickGap={48} />
        <YAxis domain={domain ?? ['auto', 'auto']} tickFormatter={(v) => `${v}`} width={52} />
        <Tooltip
          {...tooltipStyle()}
          labelFormatter={(v) => fmtDateTime(new Date(v as number).toISOString(), 'dd MMM HH:mm')}
          formatter={(v) => [typeof v !== 'number' ? '—' : `${fmtNumber(v, meta.digits)}${meta.unit}`, meta.label]}
        />
        {band && band[0] !== null && band[1] !== null && band[0] !== undefined && band[1] !== undefined && (
          <ReferenceArea y1={band[0]} y2={band[1]} fill={COLORS.band} fillOpacity={0.08} stroke={COLORS.band} strokeOpacity={0.25} ifOverflow="extendDomain" />
        )}
        {band && band[0] !== null && band[0] !== undefined && band[1] === null && <ReferenceLine y={band[0]} stroke={COLORS.band} strokeDasharray="4 4" />}
        {gaps.map((g, i) => (
          <ReferenceArea key={i} x1={g.start} x2={g.end} fill="rgb(var(--c-danger))" fillOpacity={0.08} />
        ))}
        <Line type="monotone" dataKey={metric} stroke={meta.color} strokeWidth={1.6} dot={false} connectNulls={false} isAnimationActive={false} name={meta.label} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function ActuatorChart({ rows, height = 110 }: { rows: ChartRow[]; height?: number }) {
  const span = rows.length > 1 ? rows[rows.length - 1].ts - rows[0].ts : 3600_000;
  if (!rows.length) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 4, right: 12, left: -14, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={tickFormatter(span)} minTickGap={48} />
        <YAxis domain={[0, 1]} ticks={[0, 1]} tickFormatter={(v) => (v ? 'on' : 'off')} width={52} />
        <Tooltip {...tooltipStyle()} labelFormatter={(v) => fmtDateTime(new Date(v as number).toISOString(), 'dd MMM HH:mm')} formatter={(v, name) => [typeof v !== 'number' ? '—' : `${Math.round(v * 100)}% of bucket`, name]} />
        <Area type="stepAfter" dataKey="fan_on_ratio" stroke={COLORS.fan} fill={COLORS.fan} fillOpacity={0.25} name="Fan" isAnimationActive={false} connectNulls={false} />
        <Area type="stepAfter" dataKey="heater_on_ratio" stroke={COLORS.heater} fill={COLORS.heater} fillOpacity={0.25} name="Heater" isAnimationActive={false} connectNulls={false} />
        <Area type="stepAfter" dataKey="humidifier_on_ratio" stroke={COLORS.humidifier} fill={COLORS.humidifier} fillOpacity={0.2} name="Humidifier" isAnimationActive={false} connectNulls={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function ForecastChart({ metric, history, height = 220, targets }: { metric: ForecastMetric; history: { ts: number; value: number | null }[]; height?: number; targets?: [number | null, number | null] }) {
  const rows = useMemo(() => {
    const hist = history.map((h) => ({ ts: h.ts, actual: h.value, value: null as number | null, lower: null as number | null, upper: null as number | null }));
    const last = hist.length ? hist[hist.length - 1] : null;
    const fc = (metric.forecasts ?? []).map((f) => ({ ts: new Date(f.target_time).getTime(), actual: null as number | null, value: f.value, lower: f.lower, upper: f.upper }));
    if (last && metric.current !== undefined) {
      fc.unshift({ ts: last.ts, actual: null, value: metric.current, lower: metric.current, upper: metric.current });
    }
    return [...hist, ...fc];
  }, [history, metric]);
  if (!rows.length) return <div className="flex items-center justify-center text-xs text-ink-3" style={{ height }}>No data</div>;
  const span = rows[rows.length - 1].ts - rows[0].ts;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart data={rows} margin={{ top: 8, right: 12, left: -14, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="ts" type="number" domain={['dataMin', 'dataMax']} scale="time" tickFormatter={tickFormatter(span)} minTickGap={48} />
        <YAxis domain={['auto', 'auto']} width={52} />
        <Tooltip {...tooltipStyle()} labelFormatter={(v) => fmtDateTime(new Date(v as number).toISOString(), 'dd MMM HH:mm')} formatter={(v, name) => [typeof v !== 'number' ? '—' : `${fmtNumber(v, 1)}${metric.unit}`, name]} />
        {targets && targets[0] !== null && targets[1] !== null && <ReferenceArea y1={targets[0]} y2={targets[1]} fill={COLORS.band} fillOpacity={0.08} ifOverflow="extendDomain" />}
        <Area type="monotone" dataKey="upper" stroke="none" fill={COLORS.fan} fillOpacity={0.15} name="Upper band" isAnimationActive={false} connectNulls={false} />
        <Area type="monotone" dataKey="lower" stroke="none" fill="rgb(var(--c-surface))" fillOpacity={1} name="Lower band" isAnimationActive={false} connectNulls={false} />
        <Line type="monotone" dataKey="actual" stroke={COLORS.temperature} strokeWidth={1.5} dot={false} name="Measured" isAnimationActive={false} connectNulls={false} />
        <Line type="monotone" dataKey="value" stroke={COLORS.fan} strokeWidth={1.5} strokeDasharray="5 4" dot={{ r: 2 }} name="Forecast (linear trend)" isAnimationActive={false} connectNulls={false} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

export function Histogram({ bins, unit, color = COLORS.temperature, height = 160, range }: { bins: { from: number; to: number; count: number }[]; unit: string; color?: string; height?: number; range?: [number | null, number | null] }) {
  const rows = bins.map((b) => ({ label: `${fmtNumber(b.from, unit === '°C' ? 1 : 0)}`, mid: (b.from + b.to) / 2, count: b.count, from: b.from, to: b.to }));
  if (!rows.length) return <div className="flex items-center justify-center text-xs text-ink-3" style={{ height }}>No data</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" minTickGap={24} />
        <YAxis allowDecimals={false} width={48} />
        <Tooltip {...tooltipStyle()} formatter={(v: number) => [v, 'readings']} labelFormatter={(_, p) => (p?.[0] ? `${fmtNumber(p[0].payload.from, 1)} – ${fmtNumber(p[0].payload.to, 1)} ${unit}` : '')} />
        <Bar dataKey="count" fill={color} radius={[2, 2, 0, 0]} isAnimationActive={false}>
          {range && range[0] !== null && range[1] !== null
            ? rows.map((r, i) => <Cell key={i} fill={r.mid < (range[0] as number) || r.mid > (range[1] as number) ? 'rgb(var(--c-danger))' : color} />)
            : null}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function DutyBars({ data, height = 160 }: { data: { name: string; value: number; label?: string; color?: string }[]; height?: number }) {
  if (!data.length) return null;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 24, left: 8, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
        <YAxis type="category" dataKey="name" width={80} />
        <Tooltip {...tooltipStyle()} formatter={(v: number, _n, p) => [p?.payload?.label ?? `${v}%`, 'duty cycle']} />
        <Bar dataKey="value" radius={[0, 3, 3, 0]} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.color ?? COLORS.fan} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PeriodBars({ rows, keys, height = 200, unit = 'min' }: { rows: Record<string, unknown>[]; keys: { key: string; label: string; color: string }[]; height?: number; unit?: string }) {
  if (!rows.length) return <div className="flex items-center justify-center text-xs text-ink-3" style={{ height }}>No data</div>;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="period" minTickGap={16} />
        <YAxis width={52} />
        <Tooltip {...tooltipStyle()} formatter={(v: number, name) => [`${fmtNumber(v, 0)} ${unit}`, name]} />
        {keys.map((k) => (
          <Bar key={k.key} dataKey={k.key} name={k.label} fill={k.color} stackId="a" isAnimationActive={false} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export const CHART_COLORS = COLORS;
