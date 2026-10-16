import { useMemo, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Bell, Settings2, Sparkles, Wifi, WifiOff, X } from 'lucide-react';
import { useLive } from '@/providers/LiveProvider';
import { useDevice } from '@/providers/DeviceProvider';
import { useSystemStatus } from '@/lib/queries';
import { Badge, Field, KeyValue, Modal, Select } from '@/components/ui';
import { ConnectionBadge, ModeBadge } from '@/components/domain';
import { fmtAgo, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { AssistantProvider, useAssistant } from '@/providers/AssistantProvider';
import { AssistantDrawer } from '@/components/assistant/AssistantDrawer';

/** The three pages of the app. */
export const NAV_ITEMS = [
  { to: '/', label: 'Overview', end: true, hint: 'Live readings, manual control and MYCO AI' },
  { to: '/stats', label: 'Stats', hint: 'What happened over the last days and weeks' },
  { to: '/predictions', label: 'Predictions', hint: 'What to expect next and anything unusual' },
] as const;

function Brand() {
  return (
    <NavLink to="/" className="flex items-center gap-2.5" aria-label="MYCO AI – Overview">
      <svg viewBox="0 0 32 32" className="h-8 w-8 shrink-0" aria-hidden>
        <rect width="32" height="32" rx="9" fill="rgb(var(--c-surface-3))" />
        <path d="M6 17c0-6 4.5-10 10-10s10 4 10 10c0 1.2-1 2-2.2 2H8.2C7 19 6 18.2 6 17z" fill="rgb(var(--c-brand))" />
        <path d="M13 19h6v4.5c0 1.7-1.3 3-3 3s-3-1.3-3-3V19z" fill="rgb(var(--c-brand-2))" />
      </svg>
      <span className="font-display text-lg leading-none text-ink">MYCO AI</span>
    </NavLink>
  );
}

function Nav() {
  return (
    <nav aria-label="Main navigation" className="flex items-center gap-1 rounded-full bg-surface-2 p-1">
      {NAV_ITEMS.map((item) => (
        <NavLink key={item.to} to={item.to} end={'end' in item ? item.end : false} title={item.hint} className={({ isActive }) => cn('rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors', isActive ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink')}>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/** One pill that says whether what you see is live hardware, the demo simulator or nothing at all. */
function StatusPill() {
  const { data: status, isError } = useSystemStatus();
  const { connected, reconnecting, lastEventAt } = useLive();
  const mode = useMemo(() => {
    if (isError) return { mode: 'disconnected', label: 'BACKEND UNREACHABLE', detail: 'The API server is not responding' };
    if (!status) return null;
    return { mode: status.mode, label: status.label, detail: status.detail };
  }, [status, isError]);
  return (
    <div className="flex items-center gap-2">
      {mode && (
        <span title={mode.detail}>
          <ModeBadge mode={mode.mode} label={mode.label} />
        </span>
      )}
      <span className={cn('hidden items-center gap-1.5 text-[11px] sm:inline-flex', connected ? 'text-ink-3' : 'text-danger')} title={connected ? `Live feed connected${lastEventAt ? ` · last event ${fmtAgo(lastEventAt)}` : ''}` : 'Live feed disconnected'}>
        {connected ? <Wifi className="h-3.5 w-3.5 text-brand" aria-hidden /> : <WifiOff className="h-3.5 w-3.5" aria-hidden />}
        {connected ? 'live feed' : reconnecting ? 'reconnecting…' : 'feed offline'}
      </span>
    </div>
  );
}

/** Gear → "Connections": which chamber is shown, how it is connected, and whether the AI model is reachable. */
export function ConnectionsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { devices, deviceId, setDeviceId, device } = useDevice();
  const { data: status } = useSystemStatus();
  const ai = status?.ai;
  const sim = status?.simulator;
  return (
    <Modal open={open} onClose={onClose} title="Connections" size="md">
      <div className="space-y-4 text-sm">
        <Field label="Chamber shown in the app" hint={devices.length > 1 ? 'Switch between the demo simulator and your ESP32 controller.' : undefined}>
          <Select aria-label="Chamber" value={deviceId ?? ''} onChange={(e) => setDeviceId(e.target.value)} disabled={!devices.length}>
            {!devices.length && <option value="">No chamber registered</option>}
            {devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} · {d.kind === 'simulated' ? 'demo simulator' : 'hardware'} · {d.connection_status}
              </option>
            ))}
          </Select>
        </Field>
        {device && (
          <KeyValue
            items={[
              { k: 'Status', v: <ConnectionBadge status={device.connection_status} lastSeen={device.last_seen_at} /> },
              { k: 'Device ID', v: <span className="font-mono text-xs">{device.id}</span> },
              { k: 'Transport', v: device.transport },
              { k: 'Last seen', v: device.last_seen_at ? `${fmtAgo(device.last_seen_at)} (${fmtDateTime(device.last_seen_at, 'dd MMM HH:mm')})` : 'never' },
            ]}
          />
        )}
        <div className="rounded-md border border-line bg-surface-2 p-3">
          <p className="flex items-center gap-2 text-xs font-semibold text-ink">
            MYCO AI model
            {ai ? <Badge tone={ai.configured && !ai.circuit_open ? 'brand' : 'amber'}>{!ai.configured ? 'not configured' : ai.circuit_open ? 'unreachable' : 'ready'}</Badge> : <Badge>checking…</Badge>}
          </p>
          <p className="mt-1 text-xs text-ink-2">
            {!ai ? 'Waiting for the server…' : !ai.configured ? 'No AI key on the server. The assistant answers directly from your stored readings instead.' : ai.circuit_open ? `The model could not be reached (${ai.last_error ?? 'unknown error'}); retrying in ${ai.circuit_retry_in_seconds}s. Until then the assistant answers from your data only.` : `${ai.model ?? 'model'} via ${ai.endpoint_host ?? ai.provider}. The key stays on the server.`}
          </p>
        </div>
        <div className="rounded-md border border-line bg-surface-2 p-3 text-xs text-ink-2">
          <p className="font-semibold text-ink">Your own chamber</p>
          <p className="mt-1">
            Flash <span className="font-mono">firmware/esp32</span> on the chamber controller and <span className="font-mono">firmware/esp32cam</span> on the camera with the device tokens from the server's <span className="font-mono">backend/.env</span>, pointed at this server's LAN address (see <span className="font-mono">docs/hardware.md</span>). The page shows their readings as soon as they report – nothing is invented while they are disconnected.
            {sim && 'enabled' in sim && sim.enabled && ' The demo simulator keeps running until you turn it off in the server settings.'}
          </p>
        </div>
        {status && (
          <p className="text-[11px] text-ink-3">
            Server {status.version} · {status.open_access ? 'no sign-in (local prototype mode)' : 'sign-in required for control'} · {status.label}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** The floating "Ask MYCO AI" bubble – visible on every page while the chat window is closed. */
function AskBubble() {
  const { openAssistant, open, inline } = useAssistant();
  if (inline) return null;
  return (
    <button
      type="button"
      onClick={openAssistant}
      aria-label="Ask MYCO AI"
      className={cn(
        'fixed z-40 flex h-[60px] items-center gap-2.5 rounded-full bg-spore pl-[18px] pr-6 text-base font-bold text-spore-ink shadow-pop transition-all hover:brightness-105 motion-safe:animate-glow',
        open && 'pointer-events-none scale-75 opacity-0',
      )}
      style={{ right: 'max(1rem, env(safe-area-inset-right, 0px))', bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
    >
      <Sparkles className="h-[22px] w-[22px]" aria-hidden />
      Ask MYCO AI
    </button>
  );
}

export function AppShell({ children }: { children?: ReactNode }) {
  return (
    <AssistantProvider>
      <ShellLayout>{children}</ShellLayout>
      <AssistantDrawer />
    </AssistantProvider>
  );
}

function ShellLayout({ children }: { children?: ReactNode }) {
  const [connections, setConnections] = useState(false);
  const { data: status, isError } = useSystemStatus();
  const { connected, recentAlerts, dismissAlert } = useLive();
  const disconnected = isError;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-line/70 bg-canvas/90 backdrop-blur-sm">
        <div className="mx-auto flex h-14 max-w-[1200px] items-center gap-3 px-3 sm:px-5">
          <Brand />
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <StatusPill />
            <button type="button" aria-label="Connections" title="Chamber, AI model and hardware connections" onClick={() => setConnections(true)} className="rounded-full p-2 text-ink-2 hover:bg-surface-2 hover:text-ink">
              <Settings2 className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
        <div className="mx-auto flex max-w-[1200px] px-3 pb-2 sm:px-5">
          <Nav />
        </div>
      </header>
      {!connected && (
        <div role="status" className="border-b border-amber/40 bg-amber/10 px-4 py-1.5 text-center text-xs text-amber">
          Live feed disconnected – values shown are the last ones received and refresh by polling. Reconnecting…
        </div>
      )}
      {status?.mode === 'demo' && (
        <div role="status" className="border-b border-amber/30 bg-amber/5 px-4 py-1.5 text-center text-xs text-amber">
          DEMO MODE – readings on the simulated chamber are generated by the built-in hardware simulator. {status.detail}
        </div>
      )}
      {disconnected && (
        <div role="alert" className="border-b border-danger/40 bg-danger/10 px-4 py-1.5 text-center text-xs text-danger">
          DISCONNECTED – the API server is not responding. No live measurements are available.
        </div>
      )}
      <main className="min-w-0 flex-1 px-3 py-4 sm:px-5">
        <div className="mx-auto max-w-[1200px]">{children ?? <Outlet />}</div>
      </main>
      <ConnectionsDialog open={connections} onClose={() => setConnections(false)} />
      <AskBubble />
      {/* live alert notifications */}
      <div aria-live="assertive" className="pointer-events-none fixed left-1/2 top-[6.5rem] z-[90] flex w-[min(520px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
        {recentAlerts.map((a) => (
          <div key={a.id} className={cn('pointer-events-auto flex items-start gap-2 rounded-md border bg-surface px-3 py-2 shadow-pop animate-fade-in', a.severity === 'critical' ? 'border-danger/60' : 'border-amber/50')}>
            <Bell className={cn('mt-0.5 h-4 w-4 shrink-0', a.severity === 'critical' ? 'text-danger' : 'text-amber')} aria-hidden />
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
