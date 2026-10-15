import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import { useViewMode } from '@/providers/ViewModeProvider';
import { cn } from '@/lib/utils';

/** Renders its children only in the detailed (engineering) view. */
export function Advanced({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const { detailed } = useViewMode();
  return <>{detailed ? children : fallback}</>;
}

/**
 * A collapsible "technical details" block. In the simple view it starts
 * collapsed behind a small toggle; in the detailed view it is always open.
 */
export function TechDetails({ title = 'Technical details', summary, children, className, defaultOpen }: { title?: string; summary?: ReactNode; children: ReactNode; className?: string; defaultOpen?: boolean }) {
  const { detailed } = useViewMode();
  const [open, setOpen] = useState(!!defaultOpen);
  const expanded = detailed || open;
  return (
    <section className={cn('rounded-md border border-dashed border-line', className)} aria-label={title}>
      <button type="button" aria-expanded={expanded} onClick={() => setOpen((o) => !o)} disabled={detailed} className={cn('flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-ink-2', detailed ? 'cursor-default' : 'hover:bg-surface-2 hover:text-ink')}>
        <Wrench className="h-3.5 w-3.5 text-ink-3" aria-hidden />
        <span className="font-medium">{title}</span>
        {summary && <span className="truncate text-ink-3">· {summary}</span>}
        <span className="ml-auto text-ink-3">{detailed ? <span className="text-[10px] uppercase tracking-wide">detailed view</span> : expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
      </button>
      {expanded && <div className="border-t border-dashed border-line p-3">{children}</div>}
    </section>
  );
}

/** Toggle between the simple and detailed views (used in the header and in Settings). */
export function ViewModeSwitch({ className, compact }: { className?: string; compact?: boolean }) {
  const { mode, setMode } = useViewMode();
  return (
    <div role="radiogroup" aria-label="View mode" className={cn('inline-flex rounded-md border border-line bg-surface-2 p-0.5 text-[11px]', className)}>
      {(['simple', 'detailed'] as const).map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} title={m === 'simple' ? 'Plain-language view: hides ids, rule keys and model internals' : 'Detailed view: shows all engineering details'} className={cn('rounded px-2 py-0.5 capitalize transition-colors', mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-3 hover:text-ink')}>
          {compact && m === 'detailed' ? 'Detailed' : m}
        </button>
      ))}
    </div>
  );
}
