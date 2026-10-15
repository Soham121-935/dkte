import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ActuatorChip, ConfidenceTag, ConnectionBadge, ModeBadge, SourceTag, kindFromSource } from './domain';

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
