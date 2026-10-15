import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * "Simple" vs "Detailed" view.
 *
 * Simple (default) hides engineering details – device ids, message ids,
 * bucket sizes, rule keys, model names, controller decision traces – and
 * explains things in plain words. Detailed shows everything. The choice is
 * remembered in localStorage.
 */
export type ViewMode = 'simple' | 'detailed';

interface ViewModeCtx {
  mode: ViewMode;
  /** true when the detailed/engineering view is active */
  detailed: boolean;
  setMode: (m: ViewMode) => void;
  toggle: () => void;
}

const Ctx = createContext<ViewModeCtx | null>(null);
export const VIEW_MODE_KEY = 'myco-view-mode';

function readInitial(): ViewMode {
  try {
    const stored = localStorage.getItem(VIEW_MODE_KEY);
    if (stored === 'simple' || stored === 'detailed') return stored;
  } catch {
    /* ignore */
  }
  return 'simple';
}

export function ViewModeProvider({ children, initial }: { children: ReactNode; initial?: ViewMode }) {
  const [mode, setModeState] = useState<ViewMode>(() => initial ?? readInitial());
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
    document.documentElement.dataset.view = mode;
  }, [mode]);
  const setMode = useCallback((m: ViewMode) => setModeState(m), []);
  const toggle = useCallback(() => setModeState((m) => (m === 'simple' ? 'detailed' : 'simple')), []);
  const value = useMemo(() => ({ mode, detailed: mode === 'detailed', setMode, toggle }), [mode, setMode, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useViewMode(): ViewModeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Allows components to be rendered outside the provider (e.g. isolated unit tests): behave as "simple".
    return { mode: 'simple', detailed: false, setMode: () => {}, toggle: () => {} };
  }
  return ctx;
}
