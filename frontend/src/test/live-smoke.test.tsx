/**
 * Live smoke-render harness.
 *
 * Renders every page of the SPA in jsdom against a REAL running backend and fails on
 * React errors, uncaught rendering exceptions or visible error states. It only runs
 * when MYCO_LIVE_BACKEND is set, e.g.
 *
 *   MYCO_LIVE_BACKEND=http://127.0.0.1:8000 npx vitest run src/test/live-smoke.test.tsx
 *
 * It is intentionally excluded from the default `npm test` run so CI does not need a
 * backend process.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, waitFor, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import App from '@/App';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { AuthProvider } from '@/providers/AuthProvider';
import { LiveProvider } from '@/providers/LiveProvider';
import { DeviceProvider } from '@/providers/DeviceProvider';
import { ToastProvider } from '@/providers/ToastProvider';

const BACKEND = process.env.MYCO_LIVE_BACKEND;

const ROUTES: { path: string; expect: RegExp }[] = [
  { path: '/', expect: /Overview/ },
  { path: '/monitoring', expect: /Live Monitoring/ },
  { path: '/batches', expect: /Cultivation Batches/ },
  { path: '/batches/1', expect: /DEMO-OYS-001|Batch/ },
  { path: '/timeline', expect: /Growth Timeline/ },
  { path: '/timeline/1', expect: /Growth Timeline/ },
  { path: '/predictions', expect: /AI Predictions|Predictions/ },
  { path: '/control', expect: /Environmental Control/ },
  { path: '/assistant', expect: /AI Cultivation Assistant/ },
  { path: '/analytics', expect: /Analytics/ },
  { path: '/devices', expect: /Device Management/ },
  { path: '/settings', expect: /System Settings/ },
];

const ERROR_MARKERS = [/Backend unreachable/i, /Something went wrong/i, /Request failed/i, /Server error/i, /Not found/];

describe.skipIf(!BACKEND)('live smoke render against backend', () => {
  const realFetch = globalThis.fetch;
  const consoleErrors: string[] = [];
  let origError: typeof console.error;

  beforeAll(() => {
    // Relative /api URLs are proxied by Vite in the browser; here we prefix the backend origin.
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' && input.startsWith('/') ? `${BACKEND}${input}` : input;
      return realFetch(url as RequestInfo, init);
    }) as typeof fetch;
    // jsdom WebSocket cannot be pointed at a different host via window.location; stub it so the
    // provider shows its reconnecting state instead of throwing.
    class WSStub {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 3;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((m: unknown) => void) | null = null;
      close() {}
      send() {}
    }
    vi.stubGlobal('WebSocket', WSStub);
    origError = console.error;
    console.error = (...args: unknown[]) => {
      const text = args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ');
      consoleErrors.push(text);
      origError(...args);
    };
  });

  afterAll(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllGlobals();
    console.error = origError;
  });

  function Harness({ path }: { path: string }) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
    return (
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[path]}>
          <ThemeProvider>
            <ToastProvider>
              <AuthProvider>
                <LiveProvider>
                  <DeviceProvider>
                    <App />
                  </DeviceProvider>
                </LiveProvider>
              </AuthProvider>
            </ToastProvider>
          </ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }

  for (const route of ROUTES) {
    it(`renders ${route.path} without errors`, async () => {
      const before = consoleErrors.length;
      const { container, unmount } = render(<Harness path={route.path} />);
      await waitFor(() => expect(container.textContent).toMatch(route.expect), { timeout: 20000 });
      // Let dependent queries settle, then make sure the page does not show a backend/error state.
      await new Promise((r) => setTimeout(r, 2500));
      const text = container.textContent ?? '';
      if (process.env.MYCO_LIVE_DUMP) {
        const main = container.querySelector('main');
        // eslint-disable-next-line no-console
        console.log(`\n===== ${route.path} =====\n${(main?.textContent ?? text).replace(/\s+/g, ' ').slice(0, 2500)}`);
      }
      for (const marker of ERROR_MARKERS) {
        expect(text, `error marker ${marker} on ${route.path}`).not.toMatch(marker);
      }
      expect(screen.queryAllByText(/Loading page/).length).toBe(0);
      const newErrors = consoleErrors.slice(before).filter((e) => !/not wrapped in act|ResizeObserver|width\(0\) and height\(0\)|The width\(|The height\(/.test(e));
      expect(newErrors, `console.error output on ${route.path}:\n${newErrors.join('\n---\n')}`).toEqual([]);
      unmount();
    }, 40000);
  }
});
