import { Droplets, Sprout, Thermometer } from 'lucide-react';
import type { Reading, Targets } from '@/api/types';
import { Badge, Card, Skeleton } from '@/components/ui';
import { QualityBadge, SourceTag } from '@/components/domain';
import { fmtAgo, fmtDateTime, fmtNumber } from '@/lib/format';
import { cn, inRange } from '@/lib/utils';

interface Props {
  reading: Reading | null | undefined;
  targets?: Targets | null;
  loading?: boolean;
  stale?: boolean;
  compact?: boolean;
}

export function readingIsStale(reading: Reading | null | undefined, maxAgeSeconds = 120): boolean {
  if (!reading) return true;
  return Date.now() - new Date(reading.measured_at).getTime() > maxAgeSeconds * 1000;
}

export function ReadingCards({ reading, targets, loading, stale, compact }: Props) {
  const isStale = stale ?? readingIsStale(reading);
  const metrics = [
    {
      key: 'temperature_c' as const,
      label: 'Temperature',
      icon: Thermometer,
      value: reading?.temperature_c ?? null,
      unit: '°C',
      digits: 1,
      min: targets?.temperature_min_c ?? null,
      max: targets?.temperature_max_c ?? null,
      sensor: 'DHT11 (±2 °C, 0–50 °C)',
    },
    {
      key: 'relative_humidity_percent' as const,
      label: 'Relative humidity',
      icon: Droplets,
      value: reading?.relative_humidity_percent ?? null,
      unit: '%',
      digits: 0,
      min: targets?.humidity_min_percent ?? null,
      max: targets?.humidity_max_percent ?? null,
      sensor: 'DHT11 (±5 % RH, rated to ~90 %)',
    },
    {
      key: 'substrate_moisture_raw' as const,
      label: 'Substrate moisture',
      icon: Sprout,
      value: reading?.substrate_moisture_raw ?? null,
      unit: 'raw',
      digits: 0,
      min: targets?.moisture_min_raw ?? null,
      max: null,
      sensor: 'Analog moisture probe (uncalibrated ADC counts)',
    },
  ];
  return (
    <div className={cn('grid gap-3', compact ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 md:grid-cols-3')}>
      {metrics.map((m) => {
        const quality = reading?.quality?.[m.key] as string | undefined;
        const invalid = quality && quality !== 'ok';
        const status = invalid ? 'unknown' : inRange(m.value, m.min, m.max);
        const tone = isStale || status === 'unknown' ? 'text-ink-3' : status === 'in' ? 'text-ink' : 'text-amber';
        return (
          <Card key={m.key} className={cn(isStale && 'opacity-80')}>
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-medium text-ink-2">
                <m.icon className="h-4 w-4 text-ink-3" aria-hidden /> {m.label}
              </div>
              <div className="flex items-center gap-1">
                {reading && <SourceTag source={reading.source} compact />}
                <QualityBadge quality={quality} />
              </div>
            </div>
            {loading ? (
              <Skeleton className="mt-3 h-8 w-32" />
            ) : (
              <div className={cn('mt-2 font-mono text-3xl font-semibold leading-none', tone)}>
                {invalid ? <span className="text-xl">invalid</span> : fmtNumber(m.value, m.digits)}
                {!invalid && m.value !== null && <span className="ml-1 text-sm font-normal text-ink-3">{m.unit}</span>}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
              {m.min !== null || m.max !== null ? (
                <span>
                  target {m.min !== null ? fmtNumber(m.min, m.digits) : '…'}–{m.max !== null ? fmtNumber(m.max, m.digits) : '…'} {m.unit !== 'raw' ? m.unit : ''}
                </span>
              ) : (
                <span>no target configured</span>
              )}
              {status === 'low' && !isStale && <Badge tone="amber">below target</Badge>}
              {status === 'high' && !isStale && <Badge tone="amber">above target</Badge>}
              {status === 'in' && !isStale && <Badge tone="brand">in range</Badge>}
              {isStale && reading && <Badge tone="danger">stale</Badge>}
            </div>
            <div className="mt-1 text-[10px] text-ink-3" title={reading ? fmtDateTime(reading.measured_at) : undefined}>
              {reading ? `measured ${fmtAgo(reading.measured_at)} · ${m.sensor}` : 'no reading received yet'}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
