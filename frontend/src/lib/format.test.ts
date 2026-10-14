import { describe, expect, it, vi, afterEach } from 'vitest';
import { fmtAgo, fmtDays, fmtDuration, fmtNumber, fmtPercent, parseDate, sourceLabel, titleCase, fmtDateTime } from './format';

describe('format helpers', () => {
  afterEach(() => vi.useRealTimers());

  it('parses ISO timestamps and rejects garbage', () => {
    expect(parseDate('2026-10-14T18:50:02.412528+00:00')?.toISOString()).toBe('2026-10-14T18:50:02.412Z');
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(fmtDateTime(null)).toBe('—');
    expect(fmtDateTime('2026-01-02T03:04:00Z', "yyyy-MM-dd'T'HH:mm:ssXXX")).toMatch(/^2026-01-0[12]T/); // local tz
  });

  it('formats numbers with fallbacks for missing values', () => {
    expect(fmtNumber(22.456, 1, ' °C')).toBe('22.5 °C');
    expect(fmtNumber(null)).toBe('—');
    expect(fmtNumber(Number.NaN)).toBe('—');
    expect(fmtNumber(0, 0)).toBe('0');
    expect(fmtPercent(0.4567, 1)).toBe('45.7%');
    expect(fmtPercent(undefined)).toBe('—');
  });

  it('formats durations in the largest sensible unit', () => {
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(60)).toBe('1m');
    expect(fmtDuration(3600 * 2 + 60 * 5)).toBe('2h 5m');
    expect(fmtDuration(86400 * 3)).toBe('3d');
    expect(fmtDuration(86400 * 3 + 3600 * 7)).toBe('3d 7h');
    expect(fmtDuration(-5)).toBe('0s');
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDays(0.5)).toBe('12 h');
    expect(fmtDays(12.34)).toBe('12.3 d');
  });

  it('formats relative times', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
    expect(fmtAgo('2026-10-15T09:59:58Z')).toBe('just now');
    expect(fmtAgo('2026-10-15T09:59:20Z')).toBe('40s ago');
    expect(fmtAgo('2026-10-15T09:30:00Z')).toBe('30 minutes ago');
    expect(fmtAgo('2026-10-13T10:00:00Z')).toBe('2 days ago');
    expect(fmtAgo(null)).toBe('never');
  });

  it('labels data sources so simulated data is never shown as measured', () => {
    expect(sourceLabel('hardware')).toBe('Measured (hardware)');
    expect(sourceLabel('simulation')).toBe('Simulated');
    expect(sourceLabel('profile_reference')).toBe('Reference profile');
    expect(sourceLabel('batch_override')).toBe('Batch override');
    expect(sourceLabel('something_new')).toBe('Something New');
    expect(sourceLabel(null)).toBe('Unknown source');
    expect(titleCase('harvest_ready')).toBe('Harvest Ready');
  });
});
