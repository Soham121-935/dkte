import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

type Kind = 'success' | 'error' | 'info' | 'warning';
interface Toast {
  id: number;
  kind: Kind;
  title: string;
  message?: string;
}
interface ToastCtx {
  push: (kind: Kind, title: string, message?: string) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);
let counter = 0;

const icons: Record<Kind, typeof Info> = { success: CheckCircle2, error: XCircle, info: Info, warning: AlertTriangle };
const colors: Record<Kind, string> = {
  success: 'border-brand/40 text-brand',
  error: 'border-danger/50 text-danger',
  info: 'border-info/40 text-info',
  warning: 'border-amber/50 text-amber',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: Kind, title: string, message?: string) => {
      const id = ++counter;
      setToasts((t) => [...t, { id, kind, title, message }].slice(-5));
      window.setTimeout(() => remove(id), kind === 'error' ? 9000 : 5000);
    },
    [remove],
  );
  const value = useMemo<ToastCtx>(
    () => ({
      push,
      success: (t, m) => push('success', t, m),
      error: (t, m) => push('error', t, m),
      info: (t, m) => push('info', t, m),
      warning: (t, m) => push('warning', t, m),
    }),
    [push],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => {
          const Icon = icons[t.kind];
          return (
            <div key={t.id} role="status" className={cn('pointer-events-auto flex items-start gap-3 rounded-md border bg-surface px-3 py-2.5 shadow-pop animate-fade-in', colors[t.kind])}>
              <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{t.title}</p>
                {t.message && <p className="mt-0.5 break-words text-xs text-ink-2">{t.message}</p>}
              </div>
              <button type="button" aria-label="Dismiss notification" onClick={() => remove(t.id)} className="rounded p-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast outside ToastProvider');
  return ctx;
}
