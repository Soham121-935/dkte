import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActuatorChip, ConfidenceTag, ConnectionBadge, ModeBadge, SourceTag, kindFromSource } from './domain';
import { ReadingCards, readingIsStale } from './ReadingCards';
import type { Reading } from '@/api/types';

describe('data-source labelling', () => {
  it('maps backend sources to display kinds', () => {
    expect(kindFromSource('hardware')).toBe('measured');
    expect(kindFromSource('simulation')).toBe('simulated');
    expect(kindFromSource('profile_reference')).toBe('reference');
    expect(kindFromSource('defaults')).toBe('reference');
    expect(kindFromSource('batch_override')).toBe('user');
    expect(kindFromSource('observed')).toBe('observed');
    expect(kindFromSource('model')).toBe('predicted');
    expect(kindFromSource(undefined)).toBe('general');
  });

  it('renders simulated data with an explicit "Simulated" tag, never "Measured"', () => {
    render(<SourceTag source="simulation" />);
    expect(screen.getByText('Simulated')).toBeInTheDocument();
    expect(screen.queryByText('Measured')).not.toBeInTheDocument();
    expect(screen.getByText('Simulated').closest('span')?.getAttribute('title')).toMatch(/not a real measurement/i);
  });

  it('shows DISCONNECTED and DEMO MODE explicitly', () => {
    render(
      <>
        <ConnectionBadge status="offline" lastSeen="2026-01-01T00:00:00Z" />
        <ConnectionBadge status="online" />
        <ModeBadge mode="demo" />
        <ModeBadge mode="disconnected" />
        <ModeBadge mode="live" />
      </>,
    );
    expect(screen.getByText('ONLINE')).toBeInTheDocument();
    expect(screen.getByText('DEMO MODE')).toBeInTheDocument();
    expect(screen.getByText('LIVE')).toBeInTheDocument();
    expect(screen.getAllByText('DISCONNECTED')).toHaveLength(2);
  });

  it('confidence tags are qualitative and never show a percentage', () => {
    render(<ConfidenceTag level="low" basis={['only 2 h of data', 'DHT11 ±2 °C']} />);
    const el = screen.getByText(/confidence: low/);
    expect(el).toBeInTheDocument();
    expect(el.textContent).not.toMatch(/%/);
    expect(el.closest('span')?.getAttribute('title')).toMatch(/not a calibrated probability/);
  });
});

describe('actuator chips distinguish requested vs confirmed state', () => {
  it('renders pending / mismatch / unknown states', () => {
    render(
      <>
        <ActuatorChip actuator="fan" entry={{ requested: true, confirmed: null, status: 'pending', last_reason: 'manual', requested_at: '2026-01-01T00:00:00Z' }} />
        <ActuatorChip actuator="heater" entry={{ requested: false, confirmed: true, status: 'mismatch', last_reason: 'auto', requested_at: null }} />
        <ActuatorChip actuator="humidifier" entry={undefined} />
      </>,
    );
    expect(screen.getByText(/Fan/)).toBeInTheDocument();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/pending|requested/i);
    expect(text).toMatch(/mismatch/i);
    expect(text).toMatch(/unknown/i);
  });
});

describe('ReadingCards', () => {
  const reading: Reading = {
    id: 1,
    device_id: 'myco-esp32-01',
    measured_at: new Date(Date.now() - 10_000).toISOString(),
    received_at: new Date().toISOString(),
    message_id: 'm',
    schema_version: 1,
    source: 'hardware',
    temperature_c: 26.4,
    relative_humidity_percent: 88,
    substrate_moisture_raw: 1850,
    fan_state: true,
    heater_state: false,
    humidifier_state: true,
    quality: { temperature_c: 'ok', relative_humidity_percent: 'ok', substrate_moisture_raw: 'ok' },
  };
  const targets = { temperature_min_c: 20, temperature_max_c: 24, humidity_min_percent: 85, humidity_max_percent: 95, moisture_min_raw: null, fae_cycle_minutes: 0, fae_duration_minutes: 0 };

  it('flags out-of-range values against targets', () => {
    render(<ReadingCards reading={reading} targets={targets} />);
    expect(screen.getByText('26.4')).toBeInTheDocument();
    expect(screen.getByText('above target')).toBeInTheDocument();
    expect(screen.getAllByText('in range')).toHaveLength(2); // humidity (85–95) and moisture (no bounds)
    expect(screen.getByText('no target configured')).toBeInTheDocument();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();
  });

  it('marks stale readings and invalid sensor values', () => {
    const old: Reading = { ...reading, measured_at: new Date(Date.now() - 10 * 60_000).toISOString(), temperature_c: null, quality: { ...reading.quality, temperature_c: 'sensor_error' } };
    expect(readingIsStale(old)).toBe(true);
    expect(readingIsStale(reading)).toBe(false);
    render(<ReadingCards reading={old} targets={targets} />);
    expect(screen.getAllByText('stale').length).toBeGreaterThan(0);
    expect(screen.getByText('invalid')).toBeInTheDocument();
    expect(screen.getByText('sensor error')).toBeInTheDocument();
    expect(screen.queryByText('above target')).not.toBeInTheDocument(); // no range verdict for stale data
  });

  it('shows an empty state with no reading', () => {
    render(<ReadingCards reading={null} />);
    expect(screen.getAllByText('no reading received yet')).toHaveLength(3);
  });
});
