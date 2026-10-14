/**
 * Minimal typed fetch wrapper. All requests go to relative `/api/...` paths so the
 * Vite dev server (or the production reverse proxy) forwards them to the backend.
 * The browser never talks to the AI provider and never sees any provider secret.
 */

export class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

const TOKEN_KEY = 'myco.session.token';
let memoryToken: string | null = null;
const listeners = new Set<(token: string | null) => void>();

export const tokenStore = {
  get(): string | null {
    if (memoryToken) return memoryToken;
    try {
      memoryToken = sessionStorage.getItem(TOKEN_KEY);
    } catch {
      memoryToken = null;
    }
    return memoryToken;
  },
  set(token: string | null) {
    memoryToken = token;
    try {
      if (token) sessionStorage.setItem(TOKEN_KEY, token);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage unavailable (private mode) – keep it in memory only */
    }
    listeners.forEach((l) => l(token));
  },
  subscribe(fn: (token: string | null) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export type Query = Record<string, string | number | boolean | null | undefined>;

export function buildQuery(query?: Query): string {
  if (!query) return '';
  const params = new URLSearchParams();
  Object.entries(query).forEach(([k, v]) => {
    if (v === undefined || v === null || v === '') return;
    params.set(k, String(v));
  });
  const s = params.toString();
  return s ? `?${s}` : '';
}

export function extractErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      // FastAPI / pydantic validation errors
      return detail
        .map((d) => {
          if (d && typeof d === 'object' && 'msg' in d) {
            const loc = Array.isArray((d as { loc?: unknown[] }).loc) ? (d as { loc: unknown[] }).loc.filter((p) => p !== 'body').join('.') : '';
            const msg = String((d as { msg: string }).msg).replace(/^Value error, /, '');
            return loc ? `${loc}: ${msg}` : msg;
          }
          return String(d);
        })
        .join('; ');
    }
    if (detail && typeof detail === 'object' && 'message' in detail) return String((detail as { message: unknown }).message);
  }
  if (status === 401) return 'Authentication required';
  if (status === 403) return 'You do not have permission for this action';
  if (status === 404) return 'Not found';
  if (status >= 500) return 'Server error';
  return `Request failed (${status})`;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Query;
  formData?: FormData;
  signal?: AbortSignal;
  raw?: boolean;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.formData) {
    body = opts.formData;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(`${path}${buildQuery(opts.query)}`, { method: opts.method ?? 'GET', headers, body, signal: opts.signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Backend unreachable – check that the API server is running');
  }
  if (res.status === 204) return undefined as T;
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    if (res.status === 401 && token) tokenStore.set(null);
    throw new ApiError(res.status, extractErrorMessage(res.status, data), data);
  }
  return data as T;
}

export async function downloadFile(path: string, filename: string, query?: Query): Promise<void> {
  const headers: Record<string, string> = {};
  const token = tokenStore.get();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${path}${buildQuery(query)}`, { headers });
  if (!res.ok) {
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, extractErrorMessage(res.status, detail), detail);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
