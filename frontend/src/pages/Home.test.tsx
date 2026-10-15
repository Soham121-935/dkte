/**
 * The Sporehouse-style home page: readings in plain words against the real
 * targets, the stage stepper (manual confirmation only), chamber switches that
 * respect the control mode / auth / connection, and honest data labelling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';
import { tokenStore } from '@/api/client';
import { FIXTURES, WebSocketStub, installFetchMock, json, renderApp, type FetchMock } from '@/test/helpers';
import { shortStage, verdict } from './Home';

const OPERATOR = { id: 2, username: 'grower', role: 'operator', is_active: true, created_at: '2026-01-01T00:00:00Z' };

function signInAsOperator(fetchMock: FetchMock) {
  tokenStore.set('tok-operator');
  fetchMock.on('GET', /^\/api\/auth\/me$/, ({ headers }) => (headers.authorization === 'Bearer tok-operator' ? OPERATOR : json(401, { detail: 'Not authenticated' })));
}

describe('verdict words', () => {
  it('turns a value and its target band into grower words without inventing anything', () => {
    expect(verdict('temp', 19.2, 15, 20)).toMatchObject({ state: 'in', words: 'Just right', bad: false });
    expect(verdict('temp', 14, 15, 20)).toMatchObject({ state: 'low', words: 'A little cool', bad: true });
    expect(verdict('temp', 9, 15, 20)).toMatchObject({ state: 'low', words: 'Too cold' });
    expect(verdict('temp', 21.5, 15, 20)).toMatchObject({ state: 'high', words: 'Running warm' });
    expect(verdict('temp', 26, 15, 20)).toMatchObject({ state: 'high', words: 'Too hot' });
    expect(verdict('rh', 92, 90, 95)).toMatchObject({ words: 'Nicely humid' });
    expect(verdict('rh', 86, 90, 95)).toMatchObject({ words: 'Air is a bit dry' });
    expect(verdict('rh', 70, 90, 95)).toMatchObject({ words: 'Air is dry' });
    expect(verdict('rh', 99, 90, 95)).toMatchObject({ words: 'Very damp' });
    // missing data is said so, never guessed
    expect(verdict('temp', null, 15, 20)).toMatchObject({ state: 'unknown', words: 'Waiting for sensor' });
    expect(verdict('temp', 19, null, null)).toMatchObject({ state: 'unknown', words: 'No target set yet' });
    expect(verdict('temp', 19, 15, 20, 'sensor_error')).toMatchObject({ state: 'invalid', words: 'Sensor problem', bad: true });
    expect(verdict('rh', null, 90, 95, 'missing')).toMatchObject({ state: 'invalid', words: 'No reading' });
  });

  it('shortens profile stage names to grower words', () => {
    expect(shortStage({ key: 'pinning', name: 'Primordia formation (pinning)' })).toBe('Pinning');
    expect(shortStage({ key: 'incubation', name: 'Incubation & colonisation' })).toBe('Colonising');
    expect(shortStage({ key: 'harvest_ready', name: 'Harvest readiness' })).toBe('Ready to pick');
    expect(shortStage({ key: 'custom_stage', name: 'Casing layer (optional)' })).toBe('Casing layer');
    expect(shortStage(null)).toBe('No stage');
  });
});

describe('home page', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    WebSocketStub.instances.length = 0;
    vi.stubGlobal('WebSocket', WebSocketStub);
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    fetchMock.restore();
    vi.unstubAllGlobals();
    tokenStore.set(null);
  });

  it('shows the chamber as a cap with big readings in plain words, the real targets and the data source', async () => {
    // the recorded reading is old – pretend it just arrived so the freshness line is the "fresh" one
    fetchMock.on('GET', /^\/api\/telemetry\/latest$/, () => ({ ...FIXTURES.latest, reading: { ...FIXTURES.latest.reading, measured_at: new Date().toISOString() } }));
    renderApp(<App />);
    const cap = await screen.findByRole('region', { name: 'Chamber climate' });
    await within(cap).findByText('Just right');
    expect(within(cap).getByText('19.2')).toBeInTheDocument();
    expect(within(cap).getByText('92')).toBeInTheDocument();
    expect(within(cap).getByText('Nicely humid')).toBeInTheDocument();
    expect(within(cap).getByText('Target 15–20 °C')).toBeInTheDocument();
    expect(within(cap).getByText('Target 90–95 %')).toBeInTheDocument();
    // simulated data is labelled as such, in the cap itself
    expect(within(cap).getByText('Demo data – simulated chamber')).toBeInTheDocument();
    expect(within(cap).getByText(/Simulated reading/)).toBeInTheDocument();
    // stage stepper: previous / current (with day count) / next
    const stage = within(cap).getByRole('group', { name: 'Growing stage' });
    expect(within(stage).getByRole('button', { pressed: true })).toHaveTextContent(/Pinning\s*· day 3/);
    expect(within(stage).getByRole('button', { name: /Colonising/ })).toBeInTheDocument();
    expect(within(stage).getByRole('button', { name: /Fruiting/ })).toBeInTheDocument();
    // the briefing headline + next step and the ask button live in the cap
    expect(within(cap).getByText(FIXTURES.aiInsight.headline)).toBeInTheDocument();
    expect(within(cap).getByRole('button', { name: /Ask MYCO AI what to do/ })).toBeInTheDocument();
    // no engineering jargon in the simple view
    expect(screen.getByRole('main').textContent).not.toMatch(/hysteresis|transport|rule_key|message_id|myco-sim-01/);
  });

  it('shows the equipment as switches that follow the chamber\'s confirmed state and the control mode', async () => {
    renderApp(<App />);
    const stem = await screen.findByRole('region', { name: 'Chamber controls' });
    const humidifier = await within(stem).findByRole('switch', { name: 'Humidifier' });
    expect(humidifier).toHaveAttribute('aria-checked', 'true');
    expect(humidifier).toHaveTextContent('Running · automatic');
    expect(within(stem).getByRole('switch', { name: 'Fan' })).toHaveAttribute('aria-checked', 'false');
    expect(within(stem).getByRole('switch', { name: 'Heater' })).toHaveTextContent('Off · automatic');
    const modes = within(stem).getByRole('group', { name: 'Control mode' });
    expect(within(modes).getByRole('button', { pressed: true })).toHaveTextContent('Automatic');
    expect(within(stem).getByText(/Choose Manual to take over/)).toBeInTheDocument();
  });

  it('never sends a command while the controller is in automatic mode – it explains what to do instead', async () => {
    const user = userEvent.setup();
    signInAsOperator(fetchMock);
    renderApp(<App />);
    const stem = await screen.findByRole('region', { name: 'Chamber controls' });
    await user.click(await within(stem).findByRole('switch', { name: 'Fan' }));
    expect(await screen.findByText(/Switch to Manual first/)).toBeInTheDocument();
    expect(fetchMock.calls.filter((c) => c.url.includes('/command'))).toHaveLength(0);
  });

  it('in manual mode an operator can switch equipment; the request goes to the control service and waits for confirmation', async () => {
    const user = userEvent.setup();
    signInAsOperator(fetchMock);
    fetchMock.on('GET', /^\/api\/control\/myco-sim-01$/, () => ({ ...FIXTURES.control, mode: 'manual' }));
    fetchMock.on('POST', /^\/api\/control\/myco-sim-01\/command$/, ({ body }) => {
      const b = body as { actuator: string; state: boolean };
      return json(201, { ...FIXTURES.commands[0], id: 999, actuator: b.actuator, requested_state: b.state, status: 'sent', result_state: null, origin: 'manual' });
    });
    renderApp(<App />);
    const stem = await screen.findByRole('region', { name: 'Chamber controls' });
    await within(stem).findByText(/You are in charge/);
    await user.click(within(stem).getByRole('switch', { name: 'Fan' }));
    await waitFor(() => expect(fetchMock.calls.filter((c) => c.url.endsWith('/command'))).toHaveLength(1));
    const call = fetchMock.calls.find((c) => c.url.endsWith('/command'))!;
    expect(call.method).toBe('POST');
    expect(call.headers.authorization).toBe('Bearer tok-operator');
    expect(call.body).toMatchObject({ actuator: 'fan', state: true });
    expect(await screen.findByText(/Fan → on sent/)).toBeInTheDocument();
  });

  it('asks viewers to sign in before changing a stage or taking manual control', async () => {
    const user = userEvent.setup();
    renderApp(<App />);
    const cap = await screen.findByRole('region', { name: 'Chamber climate' });
    const stage = await within(cap).findByRole('group', { name: 'Growing stage' });
    await user.click(within(stage).getByRole('button', { name: /Fruiting/ }));
    expect(await screen.findByRole('dialog', { name: /sign in/i })).toBeInTheDocument();
    expect(fetchMock.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/batches/1/stage'))).toHaveLength(0);
  });

  it('an operator confirms the next stage from the cap; nothing is written until they say yes', async () => {
    const user = userEvent.setup();
    signInAsOperator(fetchMock);
    fetchMock.on('POST', /^\/api\/batches\/1\/stage$/, ({ body }) => json(201, { ...FIXTURES.batches[0], current_stage_key: (body as { stage_key: string }).stage_key, current_stage_name: 'Fruiting-body development' }));
    renderApp(<App />);
    const cap = await screen.findByRole('region', { name: 'Chamber climate' });
    const stage = await within(cap).findByRole('group', { name: 'Growing stage' });
    await user.click(within(stage).getByRole('button', { name: /Fruiting/ }));
    const dialog = await screen.findByRole('dialog', { name: /reached Fruiting\?/ });
    expect(within(dialog).getByText(/Caps expanding daily/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Not yet' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetchMock.calls.filter((c) => c.url.endsWith('/stage') && c.method === 'POST')).toHaveLength(0);
    await user.click(within(stage).getByRole('button', { name: /Fruiting/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Yes, from today' }));
    await waitFor(() => expect(fetchMock.calls.filter((c) => c.url.endsWith('/batches/1/stage') && c.method === 'POST')).toHaveLength(1));
    expect(fetchMock.calls.find((c) => c.url.endsWith('/batches/1/stage'))!.body).toEqual({ stage_key: 'fruiting' });
    expect(await screen.findByText(/now in Fruiting/)).toBeInTheDocument();
  });

  it('a disconnected chamber is said so plainly and the switches stop sending', async () => {
    const user = userEvent.setup();
    signInAsOperator(fetchMock);
    const offline = FIXTURES.devices.map((d) => (d.id === 'myco-sim-01' ? { ...d, connection_status: 'offline', control_mode: 'manual' } : d));
    fetchMock.on('GET', /^\/api\/devices$/, () => offline);
    fetchMock.on('GET', /^\/api\/control\/myco-sim-01$/, () => ({ ...FIXTURES.control, mode: 'manual', device: { ...FIXTURES.control.device, connection_status: 'offline' } }));
    renderApp(<App />);
    const cap = await screen.findByRole('region', { name: 'Chamber climate' });
    expect(await within(cap).findByText(/Chamber disconnected – last reading/)).toBeInTheDocument();
    const stem = screen.getByRole('region', { name: 'Chamber controls' });
    expect(within(stem).getByText(/disconnected – the switches cannot be reached/)).toBeInTheDocument();
    await user.click(within(stem).getByRole('switch', { name: 'Heater' }));
    expect(await screen.findByText('The chamber is disconnected')).toBeInTheDocument();
    expect(fetchMock.calls.filter((c) => c.url.includes('/command'))).toHaveLength(0);
  });
});
