import { forwardRef, useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertTriangle, Inbox, Loader2, RefreshCw, X, WifiOff, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ApiError } from '@/api/client';

/* ---------------------------------------------------------------- Button */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'xs';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

const variantClass: Record<Variant, string> = {
  primary: 'bg-brand text-canvas hover:bg-brand-2 border border-transparent font-medium',
  secondary: 'bg-surface-2 text-ink hover:bg-surface-3 border border-line-strong',
  outline: 'bg-transparent text-ink hover:bg-surface-2 border border-line-strong',
  ghost: 'bg-transparent text-ink-2 hover:bg-surface-2 hover:text-ink border border-transparent',
  danger: 'bg-danger/10 text-danger hover:bg-danger/20 border border-danger/40',
};
const sizeClass: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11px] gap-1 rounded',
  sm: 'h-8 px-2.5 text-xs gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} disabled={disabled || loading} className={cn('inline-flex items-center justify-center whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50', variantClass[variant], sizeClass[size], className)} {...rest}>
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

/* ---------------------------------------------------------------- Badge */
export type Tone = 'neutral' | 'brand' | 'teal' | 'amber' | 'danger' | 'info' | 'muted';
const toneClass: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-ink-2 border-line-strong',
  muted: 'bg-transparent text-ink-3 border-line',
  brand: 'bg-brand/15 text-brand border-brand/30',
  teal: 'bg-teal/15 text-teal border-teal/30',
  amber: 'bg-amber/15 text-amber border-amber/30',
  danger: 'bg-danger/15 text-danger border-danger/30',
  info: 'bg-info/15 text-info border-info/30',
};

export function Badge({ tone = 'neutral', className, children, title, dot }: { tone?: Tone; className?: string; children: ReactNode; title?: string; dot?: boolean }) {
  return (
    <span title={title} className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-4', toneClass[tone], className)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', tone === 'neutral' || tone === 'muted' ? 'bg-ink-3' : 'bg-current')} aria-hidden />}
      {children}
    </span>
  );
}

export function severityTone(severity: string): Tone {
  if (severity === 'critical') return 'danger';
  if (severity === 'warning') return 'amber';
  return 'info';
}

export function statusTone(status: string): Tone {
  switch (status) {
    case 'online':
    case 'confirmed':
    case 'applied':
    case 'active':
    case 'ok':
      return 'brand';
    case 'stale':
    case 'pending':
    case 'sent':
    case 'acknowledged':
    case 'mismatch':
      return 'amber';
    case 'offline':
    case 'failed':
    case 'rejected':
    case 'timeout':
    case 'critical':
      return 'danger';
    case 'resolved':
    case 'completed':
      return 'teal';
    default:
      return 'neutral';
  }
}

/* ----------------------------------------------------------------- Card */
export function Card({ title, subtitle, actions, children, className, bodyClassName, padded = true }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; padded?: boolean }) {
  return (
    <section className={cn('card flex flex-col', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-2.5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('min-w-0 flex-1', padded && 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/* --------------------------------------------------------------- States */
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-ink-3', className)} aria-label="Loading" />;
}

export function Loading({ label = 'Loading…', className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn('flex items-center gap-2 py-6 text-sm text-ink-3', className)}>
      <Spinner /> {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse2 rounded bg-surface-3', className)} />;
}

export function EmptyState({ title, description, action, icon, className }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-4 py-10 text-center', className)}>
      <div className="text-ink-3">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <p className="text-sm font-medium text-ink">{title}</p>
      {description && <p className="max-w-md text-xs text-ink-3">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Unexpected error';
}

export function ErrorState({ error, onRetry, title = 'Could not load data', className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  const unreachable = error instanceof ApiError && error.status === 0;
  const unauthorized = error instanceof ApiError && (error.status === 401 || error.status === 403);
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center gap-2 px-4 py-8 text-center', className)}>
      {unreachable ? <WifiOff className="h-6 w-6 text-danger" /> : unauthorized ? <Lock className="h-6 w-6 text-amber" /> : <AlertTriangle className="h-6 w-6 text-danger" />}
      <p className="text-sm font-medium text-ink">{unreachable ? 'Backend disconnected' : unauthorized ? 'Sign-in required' : title}</p>
      <p className="max-w-md text-xs text-ink-3">{errorMessage(error)}</p>
      {onRetry && (
        <Button size="sm" variant="outline" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Forms */
export function Field({ label, hint, error, children, required, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; required?: boolean; className?: string; htmlFor?: string }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-ink-2">
        {label}
        {required && <span className="text-danger"> *</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-danger">{error}</p> : hint ? <p className="text-[11px] text-ink-3">{hint}</p> : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn('input', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn('input min-h-[72px]', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn('input appearance-none pr-7', className)} {...rest}>
      {children}
    </select>
  );
});

export function Toggle({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean; id?: string }) {
  const autoId = useId();
  const theId = id ?? autoId;
  return (
    <label htmlFor={theId} className={cn('inline-flex cursor-pointer items-center gap-2 text-sm', disabled && 'cursor-not-allowed opacity-60')}>
      <button
        id={theId}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative h-5 w-9 rounded-full border transition-colors', checked ? 'border-brand bg-brand' : 'border-line-strong bg-surface-3')}
      >
        <span className={cn('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
      {label && <span className="text-ink-2">{label}</span>}
    </label>
  );
}

/* ---------------------------------------------------------------- Modal */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const first = ref.current?.querySelector<HTMLElement>('input,select,textarea,button:not([aria-label="Close dialog"])');
    first?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
  if (!open) return null;
  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={cn('flex max-h-[92vh] w-full flex-col rounded-t-lg border border-line bg-surface shadow-pop animate-fade-in sm:rounded-lg', width)}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          <button type="button" aria-label="Close dialog" onClick={onClose} className="rounded p-1 text-ink-3 hover:bg-surface-2 hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer && <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- Tabs */
export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <div role="tablist" className={cn('inline-flex rounded-md border border-line bg-surface-2 p-0.5', className)}>
      {items.map((it) => (
        <button key={it.value} role="tab" type="button" aria-selected={value === it.value} onClick={() => onChange(it.value)} className={cn('inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors', value === it.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink')}>
          {it.label}
          {it.count !== undefined && <span className="rounded bg-surface-3 px-1 text-[10px] text-ink-2">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- Stats */
export function Stat({ label, value, unit, hint, tone, className }: { label: ReactNode; value: ReactNode; unit?: string; hint?: ReactNode; tone?: Tone; className?: string }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'amber' ? 'text-amber' : tone === 'brand' ? 'text-brand' : 'text-ink';
  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <span className="label">{label}</span>
      <span className={cn('font-mono text-xl font-semibold leading-tight', color)}>
        {value}
        {unit && <span className="ml-1 text-xs font-normal text-ink-3">{unit}</span>}
      </span>
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </div>
  );
}

export function KeyValue({ items, className }: { items: { k: ReactNode; v: ReactNode }[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs', className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-ink-3">{it.k}</dt>
          <dd className="min-w-0 break-words text-ink-2">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Notice({ tone = 'info', children, className, icon }: { tone?: Tone; children: ReactNode; className?: string; icon?: ReactNode }) {
  return (
    <div role="note" className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', toneClass[tone], className)}>
      {icon ?? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1 text-ink-2">{children}</div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger, loading }: { open: boolean; onClose: () => void; onConfirm: () => void; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm text-ink-2">{message}</div>
    </Modal>
  );
}
