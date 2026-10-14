import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import type { SeriesPoint } from '@/api/types';
import { ActuatorChart, MetricChart, gapsFromRows, toChartRows } from './index';
import { FIXTURES } from '@/test/helpers';

function point(t: string, temp: number | null, extra: Partial<SeriesPoint> = {}): SeriesPoint {
  return {
    t,
    temperature_c: temp,
    relative_humidity_percent: 90,
    substrate_moisture_raw: 2000,
    fan_on_ratio: 0,
    heater_on_ratio: null,
    humidifier_on_ratio: 1,
    n: 1,
    invalid_count: 0,
    source: 'simulation',
    ...extra,
  } as SeriesPoint;
}

describe('toChartRows / gapsFromRows', () => {
  const bucket = 60;
  const points = [
    point('2026-01-01T00:00:00Z', 20),
    point('2026-01-01T00:01:00Z', 21),
    // 10 minute hole: the chart must break the line instead of interpolating
    point('2026-01-01T00:11:00Z', 22),
    point('2026-01-01T00:12:00Z', null, { invalid_count: 1 }),
  ];

  it('inserts a null row where data is missing so lines break', () => {
    const rows = toChartRows(points, bucket);
    expect(rows).toHaveLength(5);
    expect(rows[2].source).toBe('gap');
    expect(rows[2].temperature_c).toBeNull();
    expect(rows[2].ts).toBe(new Date('2026-01-01T00:02:00Z').getTime());
    expect(rows[3].temperature_c).toBe(22);
    expect(rows[4].temperature_c).toBeNull();
    expect(rows[4].invalid_count).toBe(1);
  });

  it('does not invent gaps for regular spacing', () => {
    const regular = Array.from({ length: 6 }, (_, i) => point(new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), 20 + i));
    const rows = toChartRows(regular, bucket);
    expect(rows.filter((r) => r.source === 'gap')).toHaveLength(0);
    expect(gapsFromRows(rows, bucket)).toEqual([]);
  });

  it('derives gap intervals for shading', () => {
    const rows = toChartRows(points, bucket);
    const gaps = gapsFromRows(rows, bucket);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({ start: new Date('2026-01-01T00:02:00Z').getTime(), end: new Date('2026-01-01T00:11:00Z').getTime() });
  });

  it('handles empty input', () => {
    expect(toChartRows([], bucket)).toEqual([]);
    expect(gapsFromRows([], bucket)).toEqual([]);
  });
});

describe('chart components', () => {
  it('render with recorded series data without throwing', () => {
    const rows = toChartRows(FIXTURES.series.points as SeriesPoint[], FIXTURES.series.bucket_seconds);
    expect(rows.length).toBeGreaterThan(5);
    const { container } = render(
      <div style={{ width: 600, height: 300 }}>
        <MetricChart rows={rows} metric="temperature_c" targets={FIXTURES.series.targets} gaps={gapsFromRows(rows, FIXTURES.series.bucket_seconds)} />
        <ActuatorChart rows={rows} />
      </div>,
    );
    expect(container.querySelectorAll('.recharts-responsive-container').length).toBe(2);
  });
});
