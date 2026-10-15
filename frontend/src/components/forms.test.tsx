import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BatchForm } from '@/components/BatchForm';
import { AlertsPanel } from '@/components/AlertsPanel';
import { TimeRangePicker, useTimeRange } from '@/pages/LiveMonitoring';
import { LoginDialog } from '@/components/layout/AppShell';
import { tokenStore } from '@/api/client';
import { FIXTURES, WebSocketStub, installFetchMock, json, renderApp, type FetchMock } from '@/test/helpers';

let fetchMock: FetchMock;
beforeEach(() => {
  vi.stubGlobal('WebSocket', WebSocketStub);
  fetchMock = installFetchMock();
});
afterEach(() => {
  fetchMock.restore();
  vi.unstubAllGlobals();
  tokenStore.set(null);
});

describe('BatchForm', () => {
  it('validates required fields and future inoculation dates before sending anything', async () => {
    const user = userEvent.setup();
    renderApp(<BatchForm open onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /create batch/i }));
    expect(await within(dialog).findByText('Name is required')).toBeInTheDocument();
    expect(within(dialog).getByText('Species is required')).toBeInTheDocument();
    expect(fetchMock.calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText(/batch name/i), 'Oyster bucket #3');
    await user.type(within(dialog).getByLabelText('Species *'), 'Pleurotus ostreatus');
    const future = new Date(Date.now() + 2 * 86400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${future.getFullYear()}-${pad(future.getMonth() + 1)}-${pad(future.getDate())}T10:00`;
    const inoc = within(dialog).getByLabelText(/inoculation date/i) as HTMLInputElement;
    await user.clear(inoc);
    await user.type(inoc, local);
    expect(inoc.value).toBe(local);
    await user.click(within(dialog).getByRole('button', { name: /create batch/i }));
    expect(await within(dialog).findByText(/cannot be in the future/i)).toBeInTheDocument();
    expect(fetchMock.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('posts a normalised payload and shows server-side rejections', async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    fetchMock.on('POST', /^\/api\/batches$/, ({ body }) => {
      const b = body as Record<string, unknown>;
      if (b.device_id === 'myco-sim-01') return json(409, { detail: 'Device myco-sim-01 already has an active batch' });
      return { ...FIXTURES.batch, id: 77, code: 'B-2026-002', name: b.name, species: b.species, device_id: null };
    });
    renderApp(<BatchForm open onClose={() => {}} onSaved={onSaved} />);
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/batch name/i), '  Shiitake log A ');
    await user.type(within(dialog).getByLabelText('Species *'), 'Lentinula edodes');
    await user.type(within(dialog).getByLabelText('Strain'), 'WR46');
    // the device selector is populated from /api/devices
    const deviceSelect = within(dialog).getByLabelText('Device') as HTMLSelectElement;
    await waitFor(() => expect(deviceSelect.options.length).toBeGreaterThan(1));
    expect(Array.from(deviceSelect.options).some((o) => o.textContent?.includes('simulated'))).toBe(true);
    await user.selectOptions(deviceSelect, 'myco-sim-01');
    await user.click(within(dialog).getByRole('button', { name: /create batch/i }));
    expect(await screen.findByText(/already has an active batch/)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();

    await user.selectOptions(deviceSelect, '');
    await user.click(within(dialog).getByRole('button', { name: /create batch/i }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const post = fetchMock.calls.filter((c) => c.method === 'POST' && c.url === '/api/batches').at(-1)!;
    expect(post.body).toMatchObject({ name: 'Shiitake log A', species: 'Lentinula edodes', strain: 'WR46', device_id: null, profile_id: null, status: 'active', inoculation_date: null, notes: null });
    expect(post.headers['content-type']).toBe('application/json');
    expect(await screen.findByText(/Batch B-2026-002 created/)).toBeInTheDocument();
  });

  it('pre-fills species from a reference profile and labels it as reference data', async () => {
    const user = userEvent.setup();
    renderApp(<BatchForm open onClose={() => {}} />);
    const dialog = await screen.findByRole('dialog');
    const profileSelect = within(dialog).getByLabelText(/species profile/i) as HTMLSelectElement;
    await waitFor(() => expect(profileSelect.options.length).toBeGreaterThan(1));
    const reference = FIXTURES.profiles.find((p) => p.source === 'reference')!;
    await user.selectOptions(profileSelect, String(reference.id));
    await waitFor(() => expect((within(dialog).getByLabelText('Species *') as HTMLInputElement).value).toBe(reference.species));
    expect(within(dialog).getByText(/Reference profile:/)).toBeInTheDocument();
    const stageSelect = within(dialog).getByLabelText(/current stage/i) as HTMLSelectElement;
    expect(Array.from(stageSelect.options).map((o) => o.textContent)).toContain(reference.stages[1].name);
  });
});

function Harness({ onChange }: { onChange: (tr: unknown) => void }) {
  const ctrl = useTimeRange('24h');
  onChange(ctrl.tr);
  return <TimeRangePicker ctrl={ctrl} />;
}

describe('TimeRangePicker', () => {
  it('switches presets and builds ISO bounds for custom ranges', async () => {
    const user = userEvent.setup();
    let latest: unknown = null;
    renderApp(<Harness onChange={(tr) => (latest = tr)} />);
    expect(latest).toEqual({ range: '24h' });
    await user.click(screen.getByRole('tab', { name: '7 d' }));
    expect(latest).toEqual({ range: '7d' });
    await user.click(screen.getByRole('tab', { name: 'Custom' }));
    // custom without bounds falls back to a 24 h window rather than sending an invalid request
    expect(latest).toEqual({ from: undefined, to: undefined, range: '24h' });
    await user.type(screen.getByLabelText('From'), '2026-03-01T08:00');
    await user.type(screen.getByLabelText('To'), '2026-03-02T08:00');
    const tr = latest as { from?: string; to?: string; range?: string };
    expect(tr.range).toBeUndefined();
    expect(new Date(tr.from!).getTime()).toBe(new Date('2026-03-01T08:00').getTime());
    expect(new Date(tr.to!).getTime() - new Date(tr.from!).getTime()).toBe(24 * 3600 * 1000);
  });
});

describe('AlertsPanel', () => {
  it('filters, blocks unauthenticated actions and acknowledges when allowed', async () => {
    const user = userEvent.setup();
    let ackCalls = 0;
    fetchMock.on('POST', /^\/api\/alerts\/\d+\/acknowledge$/, ({ headers, url }) => {
      if (!headers.authorization) return json(401, { detail: 'Not authenticated' });
      ackCalls += 1;
      const id = Number(url.pathname.split('/')[3]);
      const a = FIXTURES.alerts.find((x) => x.id === id)!;
      return { ...a, status: 'acknowledged', acknowledged_by: 'operator1' };
    });
    fetchMock.on('GET', /^\/api\/alerts$/, ({ url }) => {
      const status = url.searchParams.get('status');
      const severity = url.searchParams.get('severity');
      return FIXTURES.alerts.filter((a) => (status === 'open' ? a.status !== 'resolved' : status ? a.status === status : true)).filter((a) => !severity || a.severity === severity);
    });
    renderApp(
      <>
        <AlertsPanel deviceId="myco-sim-01" />
        <LoginDialog />
      </>,
    );
    expect(await screen.findByText('Humidifier command not confirmed')).toBeInTheDocument();
    expect(screen.queryByText('Humidifier switching too frequently')).not.toBeInTheDocument();
    expect(fetchMock.calls.find((c) => c.url.startsWith('/api/alerts?'))?.url).toContain('device_id=myco-sim-01');

    // viewer (no token): the action opens the login dialog instead of calling the API
    await user.click(screen.getByRole('button', { name: /mark as seen/i }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Sign in/);
    expect(ackCalls).toBe(0);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));

    await user.click(screen.getByRole('tab', { name: 'Resolved' }));
    expect(await screen.findByText('Humidifier switching too frequently')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Filter by severity'), 'critical');
    expect(await screen.findByText('No alerts')).toBeInTheDocument();
  });

  it('calls the acknowledge endpoint with the bearer token for operators', async () => {
    const user = userEvent.setup();
    tokenStore.set('op-token');
    fetchMock.on('GET', /^\/api\/auth\/me$/, () => ({ id: 2, username: 'operator1', role: 'operator' }));
    fetchMock.on('POST', /^\/api\/alerts\/7\/acknowledge$/, ({ headers }) => (headers.authorization === 'Bearer op-token' ? { ...FIXTURES.alerts[3], status: 'acknowledged' } : json(403, { detail: 'forbidden' })));
    renderApp(<AlertsPanel />);
    const btn = await screen.findByRole('button', { name: /mark as seen/i });
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url === '/api/auth/me')).toBe(true));
    await user.click(btn);
    await waitFor(() => expect(fetchMock.calls.some((c) => c.method === 'POST' && c.url === '/api/alerts/7/acknowledge')).toBe(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
