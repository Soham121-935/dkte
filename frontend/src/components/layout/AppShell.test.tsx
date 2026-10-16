import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';
import { FIXTURES, WebSocketStub, installFetchMock, renderApp, type FetchMock } from '@/test/helpers';
import { NAV_ITEMS } from './AppShell';

const PAGES = [
  { label: 'Overview', to: '/', heading: 'Overview' },
  { label: 'Stats', to: '/stats', heading: 'Stats' },
  { label: 'Predictions', to: '/predictions', heading: 'Predictions' },
];

describe('navigation', () => {
  it('exposes exactly the three pages with unique routes and the Overview first', () => {
    expect(NAV_ITEMS.map((n) => ({ label: n.label, to: n.to }))).toEqual(PAGES.map((p) => ({ label: p.label, to: p.to })));
    expect(new Set(NAV_ITEMS.map((n) => n.to)).size).toBe(3);
    expect(NAV_ITEMS[0]).toMatchObject({ to: '/', end: true });
    for (const item of NAV_ITEMS) expect(item.hint.length).toBeGreaterThan(10);
  });
});

describe('AppShell with recorded backend data', () => {
  let fetchMock: FetchMock;
  const consoleErrors: string[] = [];

  beforeEach(() => {
    WebSocketStub.instances.length = 0;
    vi.stubGlobal('WebSocket', WebSocketStub);
    fetchMock = installFetchMock();
    consoleErrors.length = 0;
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  });
  afterEach(() => {
    fetchMock.restore();
    vi.unstubAllGlobals();
  });

  it('renders the light shell: brand, three nav links, mode pill, demo banner – and no sign-in or theme toggle', async () => {
    renderApp(<App />);
    const nav = await screen.findByRole('navigation', { name: /main navigation/i });
    for (const p of PAGES) expect(within(nav).getByRole('link', { name: p.label })).toBeInTheDocument();
    expect(within(nav).getAllByRole('link')).toHaveLength(3);
    // mode comes from /api/system/status (recorded in demo mode)
    expect(await screen.findByText(FIXTURES.systemStatus.label)).toBeInTheDocument();
    expect(screen.getAllByRole('status').map((el) => el.textContent).join(' ')).toMatch(/Live feed disconnected/);
    expect(screen.getAllByText(/DEMO MODE/).length).toBeGreaterThan(0);
    // removed for now: sign-in, dark mode, simple/detailed switch, alerts bell
    expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /switch to (light|dark) mode/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /detailed/i })).not.toBeInTheDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('navigates to every page through the top nav and renders each page heading without crashing', async () => {
    const user = userEvent.setup();
    renderApp(<App />);
    const nav = await screen.findByRole('navigation', { name: /main navigation/i });
    for (const p of [...PAGES].reverse()) {
      await user.click(within(nav).getByRole('link', { name: p.label }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: p.heading })).toBeInTheDocument(), { timeout: 4000 });
      expect(within(nav).getByRole('link', { name: p.label })).toHaveAttribute('aria-current', 'page');
    }
    const crashes = consoleErrors.filter((e) => /The above error occurred|Uncaught|Cannot read properties/.test(e));
    expect(crashes).toEqual([]);
  });

  it('unknown routes (the removed pages) land on the Overview', async () => {
    renderApp(<App />, { route: '/settings' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it('the gear opens Connections: chamber picker, AI status and hardware note; switching the chamber re-queries the API', async () => {
    const user = userEvent.setup();
    renderApp(<App />);
    await screen.findByText(FIXTURES.systemStatus.label);
    await user.click(screen.getByRole('button', { name: 'Connections' }));
    const dialog = await screen.findByRole('dialog', { name: 'Connections' });
    const select = within(dialog).getByLabelText('Chamber') as HTMLSelectElement;
    // the ESP32-CAM is a device too, but it is not a chamber – it must not be offered here
    expect(Array.from(select.options).map((o) => o.value)).toEqual(FIXTURES.devices.filter((d) => d.role !== 'camera').map((d) => d.id));
    expect(select.options[0].text).toMatch(/demo simulator/);
    expect(within(dialog).getByText('MYCO AI model')).toBeInTheDocument();
    expect(within(dialog).getByText('firmware/esp32')).toBeInTheDocument();
    expect(within(dialog).getByText('firmware/esp32cam')).toBeInTheDocument();
    const other = FIXTURES.devices[1].id;
    await user.selectOptions(select, other);
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url.startsWith('/api/telemetry/latest') && c.url.includes(`device_id=${other}`))).toBe(true));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connections' })).not.toBeInTheDocument());
  });

  it('shows the backend-unreachable state instead of crashing when the API is down', async () => {
    fetchMock.restore();
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    renderApp(<App />, { route: '/stats' });
    expect(await screen.findByText(/BACKEND UNREACHABLE/)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/DISCONNECTED/);
  });

  it('reflects live WebSocket events (alert notification + reconnect banner)', async () => {
    renderApp(<App />);
    await screen.findByRole('navigation', { name: /main navigation/i });
    const ws = WebSocketStub.instances[0];
    expect(ws).toBeDefined();
    expect(ws.url).toMatch(/\/ws\/live$/);
    act(() => ws.open());
    await waitFor(() => expect(screen.queryByText(/Live feed disconnected/)).not.toBeInTheDocument());
    act(() =>
      ws.emit('alert', {
        action: 'opened',
        alert: { id: 991, rule_key: 'temperature_out_of_range', severity: 'critical', status: 'active', title: 'Temperature above range', message: 'Temperature 27.5 °C exceeds 24 °C', device_id: 'myco-sim-01', batch_id: null, source: 'simulation', opened_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), occurrence_count: 1, acknowledged_at: null, acknowledged_by: null, resolved_at: null, resolved_reason: null, data: {} },
      }),
    );
    expect((await screen.findAllByText('Temperature above range')).length).toBeGreaterThan(0);
    act(() => ws.onclose?.());
    expect(await screen.findByText(/Live feed disconnected/)).toBeInTheDocument();
  });
});
