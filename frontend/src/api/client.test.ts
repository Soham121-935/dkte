import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, buildQuery, downloadFile, extractErrorMessage, tokenStore } from './client';
import { json } from '@/test/helpers';

describe('buildQuery', () => {
  it('drops empty values and encodes the rest', () => {
    expect(buildQuery()).toBe('');
    expect(buildQuery({ device_id: 'myco-sim-01', range: '24h', from: undefined, to: null, q: '' })).toBe('?device_id=myco-sim-01&range=24h');
    expect(buildQuery({ a: 1, b: true, c: 'x y' })).toBe('?a=1&b=true&c=x+y');
  });
});

describe('extractErrorMessage', () => {
  it('flattens FastAPI validation errors', () => {
    const body = { detail: [{ loc: ['body', 'name'], msg: 'Field required' }, { loc: ['body', 'inoculation_date'], msg: 'Value error, inoculation_date cannot be in the future' }] };
    expect(extractErrorMessage(422, body)).toBe('name: Field required; inoculation_date: inoculation_date cannot be in the future');
  });
  it('uses string details and status fallbacks', () => {
    expect(extractErrorMessage(409, { detail: 'Device already has an active batch' })).toBe('Device already has an active batch');
    expect(extractErrorMessage(401, null)).toBe('Authentication required');
    expect(extractErrorMessage(403, {})).toBe('You do not have permission for this action');
    expect(extractErrorMessage(404, 'nope')).toBe('Not found');
    expect(extractErrorMessage(503, '')).toBe('Server error');
    expect(extractErrorMessage(418, {})).toBe('Request failed (418)');
  });
});

describe('api()', () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  let respond: (url: string, init?: RequestInit) => Response | Promise<Response>;

  beforeEach(() => {
    calls.length = 0;
    tokenStore.set(null);
    respond = () => json(200, { ok: true });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      return respond(url, init);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    tokenStore.set(null);
  });

  it('sends JSON bodies, query strings and the bearer token', async () => {
    tokenStore.set('jwt-123');
    const out = await api<{ ok: boolean }>('/api/control/myco-sim-01/command', { method: 'POST', body: { actuator: 'fan', state: true }, query: { dry: false } });
    expect(out).toEqual({ ok: true });
    expect(calls[0].url).toBe('/api/control/myco-sim-01/command?dry=false');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer jwt-123');
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ actuator: 'fan', state: true });
  });

  it('never calls an absolute AI-provider URL and never adds provider keys', async () => {
    await api('/api/ai/status');
    expect(calls[0].url.startsWith('/api/')).toBe(true);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('x-api-key');
    expect(JSON.stringify(headers)).not.toMatch(/nvapi-/);
  });

  it('raises ApiError with the server message and keeps the detail', async () => {
    respond = () => json(422, { detail: [{ loc: ['body', 'state'], msg: 'Input should be a valid boolean' }] });
    const err = (await api('/api/x', { method: 'POST', body: {} }).catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(422);
    expect(err.message).toBe('state: Input should be a valid boolean');
    expect((err.detail as { detail: { loc: string[] }[] }).detail[0].loc).toEqual(['body', 'state']);
  });

  it('clears the stored session token on 401 so the UI drops to viewer mode', async () => {
    tokenStore.set('expired');
    const seen: (string | null)[] = [];
    const unsub = tokenStore.subscribe((t) => seen.push(t));
    respond = () => json(401, { detail: 'Token expired' });
    await expect(api('/api/auth/me')).rejects.toMatchObject({ status: 401, message: 'Token expired' });
    expect(tokenStore.get()).toBeNull();
    expect(seen).toEqual([null]);
    unsub();
  });

  it('does not touch the token on 401 when none was sent', async () => {
    respond = () => json(401, { detail: 'Not authenticated' });
    const seen: (string | null)[] = [];
    const unsub = tokenStore.subscribe((t) => seen.push(t));
    await expect(api('/api/auth/me')).rejects.toBeInstanceOf(ApiError);
    expect(seen).toEqual([]);
    unsub();
  });

  it('maps network failures to a readable "backend unreachable" error', async () => {
    respond = () => {
      throw new TypeError('Failed to fetch');
    };
    const err = (await api('/api/system/status').catch((e) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/Backend unreachable/);
  });

  it('propagates aborts untouched and handles 204 / non-JSON bodies', async () => {
    respond = () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    };
    await expect(api('/api/ai/conversations/1/messages', { method: 'POST', body: { content: 'x' } })).rejects.toMatchObject({ name: 'AbortError' });
    respond = () => new Response(null, { status: 204 });
    expect(await api('/api/batches/1', { method: 'DELETE' })).toBeUndefined();
    respond = () => new Response('plain text', { status: 200 });
    expect(await api('/api/weird')).toBe('plain text');
  });

  it('keeps the token in sessionStorage, not localStorage', () => {
    tokenStore.set('abc');
    expect(sessionStorage.getItem('myco.session.token')).toBe('abc');
    expect(Object.keys(localStorage).some((k) => localStorage.getItem(k) === 'abc')).toBe(false);
  });

  it('downloadFile surfaces API errors instead of saving an error page', async () => {
    respond = () => json(404, { detail: 'Device not found' });
    await expect(downloadFile('/api/telemetry/export.csv', 'x.csv', { device_id: 'ghost' })).rejects.toMatchObject({ status: 404, message: 'Device not found' });
    expect(calls[0].url).toBe('/api/telemetry/export.csv?device_id=ghost');
  });
});
