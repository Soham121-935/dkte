import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';
import { tokenStore } from '@/api/client';
import { FIXTURES, WebSocketStub, installFetchMock, json, renderApp, type FetchMock } from '@/test/helpers';
import { NAV_ITEMS } from './AppShell';

const REQUIRED_SECTIONS = [
  'Overview',
  'Live Monitoring',
  'Cultivation Batches',
  'Growth Timeline',
  'AI Predictions',
  'Environmental Control',
  'AI Cultivation Assistant',
  'Analytics and Reports',
  'Device Management',
  'System Settings',
];

describe('navigation', () => {
  it('exposes exactly the ten required sections with unique routes', () => {
    expect(NAV_ITEMS.map((n) => n.label)).toEqual(REQUIRED_SECTIONS);
    expect(new Set(NAV_ITEMS.map((n) => n.to)).size).toBe(10);
    expect(NAV_ITEMS[0]).toMatchObject({ to: '/', end: true });
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
    tokenStore.set(null);
  });

  it('renders the shell, the sidebar links, the mode badge and the device selector', async () => {
    renderApp(<App />);
    const nav = await screen.findByRole('navigation', { name: /main navigation/i });
    for (const label of REQUIRED_SECTIONS) expect(within(nav).getByRole('link', { name: label })).toBeInTheDocument();
    // mode comes from /api/system/status (recorded in demo mode)
    expect(await screen.findByText(FIXTURES.systemStatus.label)).toBeInTheDocument();
    expect(screen.getAllByRole('status').map((el) => el.textContent).join(' ')).toMatch(/Live feed disconnected/);
    const select = (await screen.findAllByLabelText('Select device'))[0] as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(FIXTURES.devices.map((d) => d.id));
    // simulated devices are labelled as such and the DEMO banner is visible
    expect(screen.getAllByText(/DEMO MODE/).length).toBeGreaterThan(0);
  });

  it('navigates to every section through the sidebar and renders each page heading', async () => {
    const user = userEvent.setup();
    renderApp(<App />);
    const nav = await screen.findByRole('navigation', { name: /main navigation/i });
    for (const item of NAV_ITEMS) {
      await user.click(within(nav).getByRole('link', { name: item.label }));
      await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: item.label })).toBeInTheDocument(), { timeout: 4000 });
      expect(within(nav).getByRole('link', { name: item.label })).toHaveAttribute('aria-current', 'page');
    }
    const crashes = consoleErrors.filter((e) => /The above error occurred|Uncaught|Cannot read properties/.test(e));
    expect(crashes).toEqual([]);
  });

  it('shows the backend-unreachable state instead of crashing when the API is down', async () => {
    fetchMock.restore();
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    renderApp(<App />, { route: '/monitoring' });
    expect(await screen.findByText(/BACKEND UNREACHABLE/)).toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/DISCONNECTED/);
    expect(screen.getAllByText('No devices registered').length).toBeGreaterThan(0);
  });

  it('opens the login dialog, shows backend errors and signs in with a bearer token', async () => {
    const user = userEvent.setup();
    fetchMock.on('POST', /^\/api\/auth\/login$/, ({ body }) => {
      const b = body as { username: string; password: string };
      if (b.password !== 'admin12345') return json(401, { detail: 'Invalid credentials' });
      return { access_token: 'tok-abc', token_type: 'bearer', user: { id: 1, username: b.username, role: 'admin', is_active: true, created_at: '2026-01-01T00:00:00Z' } };
    });
    fetchMock.on('GET', /^\/api\/auth\/me$/, ({ headers }) => (headers.authorization === 'Bearer tok-abc' ? { id: 1, username: 'admin', role: 'admin' } : json(401, { detail: 'Not authenticated' })));
    renderApp(<App />);
    await user.click(await screen.findByRole('button', { name: /sign in/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/username/i), 'admin');
    await user.type(within(dialog).getByLabelText(/password/i), 'wrong-pass');
    await user.click(within(dialog).getByRole('button', { name: /^sign in$/i }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Invalid credentials');
    await user.clear(within(dialog).getByLabelText(/password/i));
    await user.type(within(dialog).getByLabelText(/password/i), 'admin12345');
    await user.click(within(dialog).getByRole('button', { name: /^sign in$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(tokenStore.get()).toBe('tok-abc');
    expect(screen.getByText((_, el) => el?.tagName === 'SPAN' && el.textContent === 'admin · admin')).toBeInTheDocument();
    // subsequent requests carry the token; the login request itself did not
    const loginCall = fetchMock.calls.find((c) => c.url === '/api/auth/login');
    expect(loginCall?.headers.authorization).toBeUndefined();
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(tokenStore.get()).toBeNull();
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
    expect(await screen.findByText('Temperature above range')).toBeInTheDocument();
    act(() => ws.onclose?.());
    expect(await screen.findByText(/Live feed disconnected/)).toBeInTheDocument();
  });
});
