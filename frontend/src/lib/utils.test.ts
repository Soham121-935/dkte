import { describe, expect, it } from 'vitest';
import { clamp, cn, csvEscape, fromLocalInput, inRange, toCsv, toIsoLocalInput } from './utils';

describe('utils', () => {
  it('cn merges conditional classes', () => {
    expect(cn('a', false && 'b', undefined, ['c', { d: true, e: false }])).toBe('a c d');
  });

  it('clamp and inRange', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(inRange(22, 20, 24)).toBe('in');
    expect(inRange(19.9, 20, 24)).toBe('low');
    expect(inRange(24.1, 20, 24)).toBe('high');
    expect(inRange(null, 20, 24)).toBe('unknown');
    expect(inRange(99, null, null)).toBe('in');
    expect(inRange(10, 20, null)).toBe('low');
  });

  it('round-trips datetime-local inputs through ISO', () => {
    const iso = fromLocalInput('2026-03-04T05:06');
    expect(iso).not.toBeNull();
    expect(toIsoLocalInput(iso)).toBe('2026-03-04T05:06');
    expect(fromLocalInput('')).toBeNull();
    expect(fromLocalInput('garbage')).toBeNull();
    expect(toIsoLocalInput(null)).toBe('');
    expect(toIsoLocalInput('garbage')).toBe('');
  });

  it('builds RFC-4180 style CSV with escaping', () => {
    expect(csvEscape('plain')).toBe('plain');
    expect(csvEscape('has,comma')).toBe('"has,comma"');
    expect(csvEscape('has "quote"')).toBe('"has ""quote"""');
    expect(csvEscape('multi\nline')).toBe('"multi\nline"');
    expect(csvEscape(null)).toBe('');
    const csv = toCsv(
      [
        { measured_at: '2026-01-01T00:00:00Z', temperature_c: 22.5, note: 'ok, fine' },
        { measured_at: '2026-01-01T00:01:00Z', temperature_c: null, note: 'sensor "glitch"' },
      ],
      ['measured_at', 'temperature_c', 'note'],
    );
    expect(csv.split('\n')).toEqual(['measured_at,temperature_c,note', '2026-01-01T00:00:00Z,22.5,"ok, fine"', '2026-01-01T00:01:00Z,,"sensor ""glitch"""']);
    expect(toCsv([])).toBe('');
    expect(toCsv([{ a: 1, b: 2 }]).split('\n')[0]).toBe('a,b'); // columns inferred
  });
});
