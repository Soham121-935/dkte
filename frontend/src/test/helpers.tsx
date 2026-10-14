/**
 * Shared test utilities: a fixture-backed fetch mock (recorded from the real
 * backend, see ./fixtures) and a render helper that mounts the full provider tree.
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { AuthProvider } from '@/providers/AuthProvider';
import { LiveProvider } from '@/providers/LiveProvider';
import { DeviceProvider } from '@/providers/DeviceProvider';
import { ToastProvider } from '@/providers/ToastProvider';

import systemStatus from './fixtures/system_status.json';
import devices from './fixtures/devices.json';
import latest from './fixtures/latest.json';
import series from './fixtures/series.json';
import alerts from './fixtures/alerts.json';
import alertSummary from './fixtures/alert_summary.json';
import alertChannels from './fixtures/alert_channels.json';
import batches from './fixtures/batches.json';
import batch from './fixtures/batch.json';
import timeline from './fixtures/timeline.json';
import profiles from './fixtures/profiles.json';
import control from './fixtures/control.json';
import commands from './fixtures/commands.json';
import aiStatus from './fixtures/ai_status.json';
import aiSuggestions from './fixtures/ai_suggestions.json';
import settings from './fixtures/settings.json';
import simulatorStatus from './fixtures/simulator_status.json';
import forecast from './fixtures/forecast.json';
import stage from './fixtures/stage.json';
import anomalies from './fixtures/anomalies.json';
import recommendations from './fixtures/recommendations.json';
import accuracy from './fixtures/accuracy.json';
import analyticsSummary from './fixtures/analytics_summary.json';
import analyticsPeriodic from './fixtures/analytics_periodic.json';
import diagnostics from './fixtures/diagnostics.json';
import events from './fixtures/events.json';
import predictionHistory from './fixtures/prediction_history.json';
import conversations from './fixtures/conversations.json';
import observations from './fixtures/observations.json';
import batchReport from './fixtures/batch_report.json';
import stageEnvironment from './fixtures/stage_environment.json';
import batchReadings from './fixtures/batch_readings.json';

export const FIXTURES = {
  systemStatus,
  devices,
  latest,
  series,
  alerts,
  alertSummary,
  alertChannels,
  batches,
  batch,
  timeline,
  profiles,
  control,
  commands,
  aiStatus,
  aiSuggestions,
  settings,
  simulatorStatus,
  forecast,
  stage,
  anomalies,
  recommendations,
  accuracy,
  analyticsSummary,
  analyticsPeriodic,
  diagnostics,
  events,
  predictionHistory,
  conversations,
  observations,
  batchReport,
  stageEnvironment,
  batchReadings,
};

export type RouteHandler = (req: { method: string; url: URL; body: unknown; headers: Record<string, string> }) => unknown | Response | Promise<unknown>;

/** Default GET routes. Order matters: first match wins. */
export function defaultRoutes(): [RegExp, RouteHandler][] {
  return [
    [/^\/api\/system\/health$/, () => ({ status: 'ok', time: new Date().toISOString(), version: 'test' })],
    [/^\/api\/system\/status$/, () => systemStatus],
    [/^\/api\/system\/events$/, () => events],
    [/^\/api\/devices$/, () => devices],
    [/^\/api\/devices\/[^/]+\/diagnostics$/, () => diagnostics],
    [/^\/api\/devices\/([^/]+)$/, ({ url }) => devices.find((d) => url.pathname.endsWith(`/${d.id}`)) ?? json(404, { detail: 'Device not found' })],
    [/^\/api\/telemetry\/latest$/, () => latest],
    [/^\/api\/telemetry\/series$/, () => series],
    [/^\/api\/telemetry\/readings$/, () => []],
    [/^\/api\/profiles$/, () => profiles],
    [/^\/api\/batches$/, () => batches],
    [/^\/api\/batches\/\d+\/timeline$/, () => timeline],
    [/^\/api\/batches\/\d+\/observations$/, () => observations],
    [/^\/api\/batches\/\d+\/report$/, () => batchReport],
    [/^\/api\/batches\/\d+\/readings$/, () => batchReadings],
    [/^\/api\/batches\/\d+$/, () => batch],
    [/^\/api\/control\/[^/]+\/commands$/, () => commands],
    [/^\/api\/control\/[^/]+$/, () => control],
    [/^\/api\/alerts$/, () => alerts],
    [/^\/api\/alerts\/summary$/, () => alertSummary],
    [/^\/api\/alerts\/channels$/, () => alertChannels],
    [/^\/api\/predictions\/forecast$/, () => forecast],
    [/^\/api\/predictions\/stage$/, () => stage],
    [/^\/api\/predictions\/anomalies$/, () => anomalies],
    [/^\/api\/predictions\/recommendations$/, () => recommendations],
    [/^\/api\/predictions\/accuracy$/, () => accuracy],
    [/^\/api\/predictions\/history$/, () => predictionHistory],
    [/^\/api\/analytics\/summary$/, () => analyticsSummary],
    [/^\/api\/analytics\/periodic$/, () => analyticsPeriodic],
    [/^\/api\/analytics\/stage-environment$/, () => stageEnvironment],
    [/^\/api\/ai\/status$/, () => aiStatus],
    [/^\/api\/ai\/suggestions$/, () => aiSuggestions],
    [/^\/api\/ai\/conversations$/, () => conversations],
    [/^\/api\/settings$/, () => settings],
    [/^\/api\/simulator\/status$/, () => simulatorStatus],
    [/^\/api\/auth\/me$/, () => json(401, { detail: 'Not authenticated' })],
  ];
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export interface FetchMock {
  calls: { method: string; url: string; body: unknown; headers: Record<string, string> }[];
  /** Register an additional route (checked before the defaults). */
  on: (method: string, pattern: RegExp, handler: RouteHandler) => void;
  restore: () => void;
}

/** Installs a fetch mock answering relative `/api/...` URLs from fixtures. */
export function installFetchMock(extra: [string, RegExp, RouteHandler][] = []): FetchMock {
  const routes: [string, RegExp, RouteHandler][] = [...extra];
  const defaults: [string, RegExp, RouteHandler][] = defaultRoutes().map(([re, fn]) => ['GET', re, fn]);
  const calls: FetchMock['calls'] = [];
  const original = globalThis.fetch;
  const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body) {
      body = init.body;
    }
    calls.push({ method, url: url.pathname + url.search, body, headers });
    const route = [...routes, ...defaults].find(([m, re]) => m === method && re.test(url.pathname));
    if (!route) return json(404, { detail: `no mock for ${method} ${url.pathname}` });
    const result = await route[2]({ method, url, body, headers });
    return result instanceof Response ? result : json(200, result);
  };
  globalThis.fetch = vi.fn(handler) as unknown as typeof fetch;
  return {
    calls,
    on: (method, pattern, fn) => routes.unshift([method.toUpperCase(), pattern, fn]),
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** jsdom has no WebSocket server; stub it so LiveProvider shows the reconnecting state. */
export class WebSocketStub {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: WebSocketStub[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  constructor(public url: string) {
    WebSocketStub.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
  send() {}
  /** Test helper: simulate the server opening the socket. */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(type: string, payload: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, payload, ts: new Date().toISOString() }) });
  }
}

export function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 }, mutations: { retry: false } } });
}

export function renderApp(ui: ReactElement, { route = '/', queryClient = makeQueryClient() }: { route?: string; queryClient?: QueryClient } = {}) {
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <LiveProvider>
              <DeviceProvider>
                <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
              </DeviceProvider>
            </LiveProvider>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...utils, queryClient };
}
