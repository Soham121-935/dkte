/**
 * Predictions page: forecasts with uncertainty bands, stage timing with its
 * confidence basis, recommendations (detected / why / action), anomalies with a
 * window picker and the honest "how good were past forecasts" table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';
import { FIXTURES, WebSocketStub, installFetchMock, json, renderApp, type FetchMock } from '@/test/helpers';

describe('Predictions page', () => {
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

  it('renders forecasts, the stage estimate, recommendations and anomalies from the recorded data, all labelled as estimates', async () => {
    renderApp(<App />, { route: '/predictions' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Predictions' })).toBeInTheDocument();
    expect(screen.getByText('estimates')).toBeInTheDocument();
    // forecasts: both metrics sufficient in the fixture, trend words + bracketed range
    expect(await screen.findByText('Temperature – next hour')).toBeInTheDocument();
    expect(screen.getByText('Humidity – next hour')).toBeInTheDocument();
    expect(screen.getAllByText(new RegExp(`based on the trend of the last ${FIXTURES.forecast.window_minutes} minutes`)).length).toBe(2);
    expect(screen.getAllByText(/^\+(15|30|60) min$/).length).toBeGreaterThan(0);
    // stage timing with confidence + plain timing words
    expect(await screen.findByText(FIXTURES.stage.timing_label!)).toBeInTheDocument();
    expect(screen.getByText('Too early for a change')).toBeInTheDocument();
    // recommendation card has detected / why / action
    const rec = FIXTURES.recommendations.recommendations[0];
    expect(await screen.findByText(rec.title)).toBeInTheDocument();
    expect(screen.getByText(rec.detected)).toBeInTheDocument();
    expect(screen.getByText(rec.why)).toBeInTheDocument();
    expect(screen.getByText(rec.action)).toBeInTheDocument();
    // anomalies table
    const anomaly = FIXTURES.anomalies.anomalies[0];
    expect(await screen.findByText(anomaly.label)).toBeInTheDocument();
    // accuracy is reported from evaluated forecasts only, with its note
    expect(screen.getByText(/How good were past forecasts/)).toBeInTheDocument();
    expect(await screen.findByText(FIXTURES.accuracy.note!)).toBeInTheDocument();
    // nothing on the page claims a learned model or invented accuracy
    expect(screen.getByRole('main').textContent).not.toMatch(/\d+% accurate|trained on/i);
  });

  it('changing the anomaly window re-queries with the new hours and "Update now" posts a prediction run', async () => {
    const user = userEvent.setup();
    let runs = 0;
    fetchMock.on('POST', /^\/api\/predictions\/run$/, () => {
      runs += 1;
      return json(202, { status: 'ok' });
    });
    renderApp(<App />, { route: '/predictions' });
    await screen.findByText('Anything unusual?');
    await user.selectOptions(screen.getByLabelText('Anomaly window'), '72');
    await waitFor(() => expect(fetchMock.calls.some((c) => c.url.startsWith('/api/predictions/anomalies') && c.url.includes('hours=72'))).toBe(true));
    await user.click(screen.getByRole('button', { name: /Update now/ }));
    await waitFor(() => expect(runs).toBe(1));
    expect(await screen.findByText('Predictions updated')).toBeInTheDocument();
  });

  it('explains when there is not enough data for a forecast instead of drawing one', async () => {
    fetchMock.on('GET', /^\/api\/predictions\/forecast$/, () => ({
      ...FIXTURES.forecast,
      metrics: { ...FIXTURES.forecast.metrics, temperature_c: { ...FIXTURES.forecast.metrics.temperature_c, sufficient: false, n_points: 3, limitation: 'Only 3 valid points in the last 60 minutes.' } },
    }));
    renderApp(<App />, { route: '/predictions' });
    const card = (await screen.findByText('Temperature – next hour')).closest('section')!;
    expect(await within(card).findByText('Not enough recent data')).toBeInTheDocument();
    expect(screen.getByText('Only 3 valid points in the last 60 minutes.')).toBeInTheDocument();
  });
});
