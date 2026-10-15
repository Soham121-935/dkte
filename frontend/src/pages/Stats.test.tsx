/**
 * Stats page: multi-day look-back built from the recorded analytics fixtures –
 * time on target, run times, alerts grouped by title, the day-by-day table,
 * period switching and the CSV exports.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';
import { FIXTURES, WebSocketStub, installFetchMock, json, renderApp, type FetchMock } from '@/test/helpers';
import { groupAlerts } from './Stats';
import type { Alert } from '@/api/types';

describe('groupAlerts', () => {
  it('groups alerts by title inside the period, counts them and keeps the worst severity', () => {
    const now = Date.now();
    const mk = (id: number, title: string, severity: Alert['severity'], agoHours: number): Alert => ({ ...(FIXTURES.alerts[0] as Alert), id, title, severity, last_seen_at: new Date(now - agoHours * 3600_000).toISOString() });
    const grouped = groupAlerts([mk(1, 'Humidity low', 'warning', 1), mk(2, 'Humidity low', 'critical', 5), mk(3, 'Fan mismatch', 'warning', 2), mk(4, 'Old one', 'critical', 24 * 9)], new Date(now - 7 * 86400_000));
    expect(grouped.map((g) => [g.title, g.count, g.severity])).toEqual([
      ['Humidity low', 2, 'critical'],
      ['Fan mismatch', 1, 'warning'],
    ]);
  });
});

describe('Stats page', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    WebSocketStub.instances.length = 0;
    vi.stubGlobal('WebSocket', WebSocketStub);
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    fetchMock.restore();
    vi.unstubAllGlobals();
  });

  it('shows time on target, run times, daily rows and alert counts from the recorded data', async () => {
    renderApp(<App />, { route: '/stats' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Stats' })).toBeInTheDocument();
    // outside_fraction 0.0014 → 99.9 % on target; humidity 0.2877 → 71 %
    expect(await screen.findByText('Temperature on target')).toBeInTheDocument();
    expect(screen.getByText(/99\.9\s?%|100\s?%/)).toBeInTheDocument();
    expect(screen.getByText(/71\s?%/)).toBeInTheDocument();
    // the comparison is against the recorded targets and the readings are labelled simulated
    expect(screen.getByText(/target 90–95 %/)).toBeInTheDocument();
    expect(screen.getAllByText(/Simulated/).length).toBeGreaterThan(0);
    // run times from actuator_runtime (fan 14401 s ≈ 4 h 0 min, 96 switches)
    const run = screen.getByText('Equipment run time').closest('section')!;
    expect(within(run).getByText('96')).toBeInTheDocument();
    expect(within(run).getByText('291')).toBeInTheDocument();
    // one daily row per period in the fixture
    for (const it of FIXTURES.analyticsPeriodic.items) expect(screen.getByText(it.period)).toBeInTheDocument();
    // alerts grouped by title (fixture alerts are recent relative to their recording – only those within 7 d count)
    expect(screen.getByText('Alerts in this period')).toBeInTheDocument();
    // the request used the 7-day range by default
    expect(fetchMock.calls.find((c) => c.url.startsWith('/api/analytics/summary'))?.url).toContain('range=7d');
    expect(fetchMock.calls.find((c) => c.url.startsWith('/api/analytics/periodic'))?.url).toContain('period=day');
  });

  it('switching to 30 days re-queries both endpoints and the CSV buttons download through the API', async () => {
    const user = userEvent.setup();
    // jsdom cannot navigate to blob: URLs – swallow the download click
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fetchMock.on('GET', /^\/api\/analytics\/periodic\.csv$/, () => new Response('period,n\n2026-10-07,1', { status: 200, headers: { 'Content-Type': 'text/csv' } }));
    fetchMock.on('GET', /^\/api\/telemetry\/export\.csv$/, () => new Response('measured_at,temperature_c\n', { status: 200, headers: { 'Content-Type': 'text/csv' } }));
    renderApp(<App />, { route: '/stats' });
    const period = await screen.findByRole('group', { name: 'Period' });
    await user.click(within(period).getByRole('button', { name: 'Last 30 days' }));
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url.startsWith('/api/analytics/summary') && c.url.includes('range=30d'))).toBe(true));
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url.startsWith('/api/analytics/periodic') && c.url.includes('range=30d'))).toBe(true));
    await screen.findByText('Day by day');
    await user.click(screen.getByRole('button', { name: /Daily CSV/ }));
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url.startsWith('/api/analytics/periodic.csv') && c.url.includes('period=day') && c.url.includes('range=30d'))).toBe(true));
    await user.click(screen.getByRole('button', { name: /Readings CSV/ }));
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url.startsWith('/api/telemetry/export.csv') && c.url.includes('device_id=myco-sim-01'))).toBe(true));
  });

  it('says so when there are no readings or the API fails, instead of showing empty numbers', async () => {
    fetchMock.on('GET', /^\/api\/analytics\/summary$/, () => ({ ...FIXTURES.analyticsSummary, n_readings: 0 }));
    const first = renderApp(<App />, { route: '/stats' });
    expect(await screen.findByText('No readings in this period')).toBeInTheDocument();
    first.unmount();
    fetchMock.on('GET', /^\/api\/analytics\/summary$/, () => json(500, { detail: 'boom' }));
    renderApp(<App />, { route: '/stats' });
    expect(await screen.findByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
