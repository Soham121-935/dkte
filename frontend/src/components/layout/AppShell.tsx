import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Activity, BarChart3, Bell, Bot, Brain, Cpu, GitBranch, LayoutDashboard, LogIn, LogOut, Menu, Moon, Package, Settings, SlidersHorizontal, Sun, Wifi, WifiOff, X, type LucideIcon } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/providers/AuthProvider';
import { useTheme } from '@/providers/ThemeProvider';
import { useLive } from '@/providers/LiveProvider';
import { useDevice } from '@/providers/DeviceProvider';
import { useSystemStatus, useAlerts } from '@/lib/queries';
import { endpoints } from '@/api/endpoints';
import { Badge, Button, Field, Input, Modal, Select, errorMessage, severityTone } from '@/components/ui';
import { ConnectionBadge, DeviceKindIcon, ModeBadge } from '@/components/domain';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useToast } from '@/providers/ToastProvider';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/monitoring', label: 'Live Monitoring', icon: Activity },
  { to: '/batches', label: 'Cultivation Batches', icon: Package },
  { to: '/timeline', label: 'Growth Timeline', icon: GitBranch },
  { to: '/predictions', label: 'AI Predictions', icon: Brain },
  { to: '/control', label: 'Environmental Control', icon: SlidersHorizontal },
  { to: '/assistant', label: 'AI Cultivation Assistant', icon: Bot },
  { to: '/analytics', label: 'Analytics and Reports', icon: BarChart3 },
  { to: '/devices', label: 'Device Management', icon: Cpu },
  { to: '/settings', label: 'System Settings', icon: Settings },
];

function Logo() {
  return (
    <div className="flex items-center gap-2.5 px-3 py-3">
      <svg viewBox="0 0 32 32" className="h-7 w-7 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="7" fill="rgb(var(--c-surface-3))" />
        <path d="M6 17c0-6 4.5-10 10-10s10 4 10 10c0 1.2-1 2-2.2 2H8.2C7 19 6 18.2 6 17z" fill="rgb(var(--c-brand))" />
        <path d="M13 19h6v4.5c0 1.7-1.3 3-3 3s-3-1.3-3-3V19z" fill="rgb(var(--c-brand-2))" />
      </svg>
      <div className="leading-tight">
        <div className="text-sm font-semibold tracking-tight text-ink">MYCO AI</div>
        <div className="text-[10px] uppercase tracking-wider text-ink-3">Cultivation monitoring</div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav aria-label="Main navigation" className="flex h-full flex-col">
      <Logo />
      <ul className="flex-1 space-y-0.5 px-2 py-1">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink to={item.to} end={item.end} onClick={onNavigate} className={({ isActive }) => cn('flex items-center gap-2.5 rounded-md px-2.5 py-2 text-[13px] transition-colors', isActive ? 'bg-brand/12 bg-surface-3 font-medium text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
              {({ isActive }) => (
                <>
                  <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-brand' : 'text-ink-3')} aria-hidden />
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="border-t border-line px-4 py-3 text-[11px] text-ink-3">
        <p>ESP32 · DHT11 · soil-moisture ADC</p>
        <p>fan · heater relay · humidifier</p>
      </div>
    </nav>
  );
}

function DeviceSelector() {
  const { devices, deviceId, setDeviceId } = useDevice();
  if (!devices.length) return <span className="text-xs text-ink-3">No devices registered</span>;
  const current = devices.find((d) => d.id === deviceId);
  return (
    <div className="flex items-center gap-2">
      {current && <DeviceKindIcon kind={current.kind} />}
      <label className="sr-only" htmlFor="device-select">
        Select device
      </label>
      <Select id="device-select" value={deviceId ?? ''} onChange={(e) => setDeviceId(e.target.value)} className="h-8 w-auto max-w-[200px] py-0 text-xs">
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} ({d.id})
          </option>
        ))}
      </Select>
      {current && <ConnectionBadge status={current.connection_status} lastSeen={current.last_seen_at} />}
    </div>
  );
}

function AlertsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data: alerts } = useAlerts({ status: 'open', limit: 20 });
  const qc = useQueryClient();
  const toast = useToast();
  const { canOperate } = useAuth();
  const ack = useMutation({
    mutationFn: (id: number) => endpoints.acknowledgeAlert(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['alerts'] }),
    onError: (e) => toast.error('Could not acknowledge', errorMessage(e)),
  });
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  const active = (alerts ?? []).filter((a) => a.status === 'active');
  const critical = active.some((a) => a.severity === 'critical');
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-label={`Alerts (${active.length} active)`} aria-expanded={open} onClick={() => setOpen((o) => !o)} className="relative rounded-md p-2 text-ink-2 hover:bg-surface-2 hover:text-ink">
        <Bell className="h-4 w-4" />
        {active.length > 0 && <span className={cn('absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full px-1 text-center text-[10px] font-semibold leading-4 text-canvas', critical ? 'bg-danger' : 'bg-amber')}>{active.length}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-[min(360px,calc(100vw-2rem))] rounded-md border border-line bg-surface shadow-pop animate-fade-in">
          <div className="flex items-center justify-between border-b border-line px-3 py-2">
            <span className="text-xs font-semibold text-ink">Open alerts</span>
            <NavLink to="/monitoring#alerts" onClick={() => setOpen(false)} className="text-[11px] text-brand hover:underline">
              View all
            </NavLink>
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {!alerts?.length && <li className="px-3 py-4 text-center text-xs text-ink-3">No open alerts</li>}
            {alerts?.map((a) => (
              <li key={a.id} className="border-b border-line/60 px-3 py-2 last:border-b-0">
                <div className="flex items-start gap-2">
                  <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-ink">{a.title}</p>
                    <p className="line-clamp-2 text-[11px] text-ink-3">{a.message}</p>
                    <p className="mt-0.5 text-[10px] text-ink-3">
                      {a.device_id ?? 'system'} · {fmtAgo(a.last_seen_at)} · {a.status}
                    </p>
                  </div>
                  {a.status === 'active' && canOperate && (
                    <Button size="xs" variant="ghost" onClick={() => ack.mutate(a.id)}>
                      Ack
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function LoginDialog() {
  const { loginOpen, closeLogin, login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={loginOpen} onClose={closeLogin} title="Sign in" size="sm">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-ink-3">Reading dashboards may be public (configurable); changing control modes, actuators, batches and settings requires an operator or admin account.</p>
        <Field label="Username" htmlFor="login-user" required>
          <Input id="login-user" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="login-pass" required>
          <Input id="login-pass" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </Field>
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={closeLogin}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy}>
            Sign in
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LiveIndicator() {
  const { connected, reconnecting, lastEventAt } = useLive();
  return (
    <span className={cn('hidden items-center gap-1.5 text-[11px] sm:inline-flex', connected ? 'text-ink-3' : 'text-danger')} title={connected ? `Live feed connected${lastEventAt ? ` · last event ${fmtAgo(lastEventAt)}` : ''}` : 'Live feed disconnected'}>
      {connected ? <Wifi className="h-3.5 w-3.5 text-brand" /> : <WifiOff className="h-3.5 w-3.5" />}
      {connected ? 'live feed' : reconnecting ? 'reconnecting…' : 'feed offline'}
    </span>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const location = useLocation();
  const { theme, toggle } = useTheme();
  const { user, openLogin, logout } = useAuth();
  const { data: status, isError } = useSystemStatus();
  const { connected } = useLive();
  const { recentAlerts, dismissAlert } = useLive();

  useEffect(() => setDrawer(false), [location.pathname]);

  const mode = useMemo(() => {
    if (isError) return { mode: 'disconnected', label: 'BACKEND UNREACHABLE', detail: 'The API server is not responding' };
    if (!status) return null;
    return { mode: status.mode, label: status.label, detail: status.detail };
  }, [status, isError]);

  return (
    <div className="flex h-full min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-line bg-surface lg:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setDrawer(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-line bg-surface shadow-pop animate-fade-in">
            <button type="button" aria-label="Close menu" onClick={() => setDrawer(false)} className="absolute right-2 top-3 rounded p-1 text-ink-3 hover:text-ink">
              <X className="h-4 w-4" />
            </button>
            <Sidebar onNavigate={() => setDrawer(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line bg-surface/95 px-3 backdrop-blur-sm sm:px-4">
          <button type="button" aria-label="Open menu" onClick={() => setDrawer(true)} className="rounded-md p-2 text-ink-2 hover:bg-surface-2 lg:hidden">
            <Menu className="h-4 w-4" />
          </button>
          <div className="hidden sm:block">
            <DeviceSelector />
          </div>
          <div className="ml-auto flex items-center gap-1.5 sm:gap-3">
            {mode && (
              <span title={mode.detail}>
                <ModeBadge mode={mode.mode} label={mode.label} />
              </span>
            )}
            <LiveIndicator />
            <AlertsMenu />
            <button type="button" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} onClick={toggle} className="rounded-md p-2 text-ink-2 hover:bg-surface-2 hover:text-ink">
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            {user ? (
              <div className="flex items-center gap-2">
                <span className="hidden text-xs text-ink-2 md:inline">
                  {user.username} <span className="text-ink-3">· {user.role}</span>
                </span>
                <Button size="sm" variant="ghost" icon={<LogOut className="h-3.5 w-3.5" />} onClick={logout} aria-label="Sign out">
                  <span className="hidden sm:inline">Sign out</span>
                </Button>
              </div>
            ) : (
              <Button size="sm" variant="outline" icon={<LogIn className="h-3.5 w-3.5" />} onClick={openLogin}>
                Sign in
              </Button>
            )}
          </div>
        </header>
        <div className="border-b border-line bg-surface px-3 py-2 sm:hidden">
          <DeviceSelector />
        </div>
        {!connected && (
          <div role="status" className="border-b border-amber/40 bg-amber/10 px-4 py-1.5 text-xs text-amber">
            Live feed disconnected – values shown are the last ones received and refresh by polling. Reconnecting…
          </div>
        )}
        {mode?.mode === 'demo' && (
          <div role="status" className="border-b border-amber/30 bg-amber/5 px-4 py-1.5 text-xs text-amber">
            DEMO MODE – all readings on simulated devices are generated by the built-in hardware simulator. {status?.detail}
          </div>
        )}
        {mode?.mode === 'disconnected' && (
          <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-xs text-danger">
            DISCONNECTED – {mode.detail}. No live measurements are available.
          </div>
        )}
        <main className="min-w-0 flex-1 px-3 py-4 sm:px-5 lg:px-6">
          <div className="mx-auto max-w-[1500px]">{children ?? <Outlet />}</div>
        </main>
      </div>
      <LoginDialog />
      {/* live alert notifications */}
      <div aria-live="assertive" className="pointer-events-none fixed left-1/2 top-16 z-[90] flex w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
        {recentAlerts.map((a) => (
          <div key={a.id} className={cn('pointer-events-auto flex items-start gap-2 rounded-md border bg-surface px-3 py-2 shadow-pop animate-fade-in', a.severity === 'critical' ? 'border-danger/60' : 'border-amber/50')}>
            <Bell className={cn('mt-0.5 h-4 w-4 shrink-0', a.severity === 'critical' ? 'text-danger' : 'text-amber')} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold text-ink">
                {a.title} <span className="font-normal text-ink-3">· {a.device_id ?? 'system'}</span>
              </p>
              <p className="text-[11px] text-ink-2">{a.message}</p>
            </div>
            <button type="button" aria-label="Dismiss alert notification" onClick={() => dismissAlert(a.id)} className="rounded p-0.5 text-ink-3 hover:text-ink">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
