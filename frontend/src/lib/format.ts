import { format, formatDistanceToNowStrict, parseISO, isValid } from 'date-fns';

export function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = typeof value === 'string' ? parseISO(value) : new Date(value);
  return isValid(d) ? d : null;
}

export function fmtDateTime(value: string | null | undefined, pattern = 'dd MMM yyyy HH:mm'): string {
  const d = parseDate(value);
  return d ? format(d, pattern) : '—';
}

export function fmtTime(value: string | null | undefined): string {
  const d = parseDate(value);
  return d ? format(d, 'HH:mm:ss') : '—';
}

export function fmtDate(value: string | null | undefined): string {
  const d = parseDate(value);
  return d ? format(d, 'dd MMM yyyy') : '—';
}

export function fmtAgo(value: string | null | undefined): string {
  const d = parseDate(value);
  if (!d) return 'never';
  const seconds = Math.round((Date.now() - d.getTime()) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${formatDistanceToNowStrict(d)} ago`;
}

export function fmtNumber(value: number | null | undefined, digits = 1, unit = ''): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${value.toFixed(digits)}${unit}`;
}

export function fmtPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || Number.isNaN(fraction)) return '—';
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

export function fmtDays(days: number | null | undefined): string {
  if (days === null || days === undefined) return '—';
  if (days < 1) return `${Math.round(days * 24)} h`;
  return `${days.toFixed(1)} d`;
}

export function titleCase(value: string | null | undefined): string {
  if (!value) return '';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export const SOURCE_LABEL: Record<string, string> = {
  hardware: 'Measured (hardware)',
  simulation: 'Simulated',
  manual: 'User-entered',
  predicted: 'Predicted',
  observed: 'User-observed',
  reference: 'Reference value',
  profile_reference: 'Reference profile',
  profile_user: 'User profile',
  batch_override: 'Batch override',
  defaults: 'System default',
};

export function sourceLabel(source: string | null | undefined): string {
  if (!source) return 'Unknown source';
  return SOURCE_LABEL[source] ?? titleCase(source);
}
