import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Beaker, Copy, KeyRound, Plus, Power, RefreshCw } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { qk, useDevices } from '@/lib/queries';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, KeyValue, Loading, Modal, Notice, Select, Textarea, Toggle, errorMessage } from '@/components/ui';
import { ConnectionBadge, DeviceKindIcon, SectionTitle, SourceTag } from '@/components/domain';
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber, titleCase } from '@/lib/format';
import type { Device } from '@/api/types';
import { useViewMode } from '@/providers/ViewModeProvider';

function SimulatorPanel() {
  const { canOperate, openLogin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const sim = useQuery({ queryKey: qk.simulator, queryFn: endpoints.simulatorStatus, refetchInterval: 10000 });
  const [duration, setDuration] = useState<string>('');
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: qk.simulator });
    qc.invalidateQueries({ queryKey: ['system'] });
  };
  const guard = (fn: () => void) => {
    if (!canOperate) {
      toast.warning('Operator account required');
      openLogin();
      return;
    }
    fn();
  };
  const scenario = useMutation({
    mutationFn: (name: string) => endpoints.simulatorScenario(name, duration ? Number(duration) : undefined),
    onSuccess: (_s, name) => {
      invalidate();
      toast.info(`Scenario "${titleCase(name)}" ${name === 'recover' ? 'applied' : 'started'}`);
    },
    onError: (e) => toast.error('Scenario rejected', errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (start: boolean) => (start ? endpoints.simulatorStart() : endpoints.simulatorStop()),
    onSuccess: invalidate,
    onError: (e) => toast.error('Simulator action failed', errorMessage(e)),
  });
  if (sim.isLoading) return <Loading />;
  if (sim.error) return <ErrorState error={sim.error} onRetry={() => sim.refetch()} />;
  const s = sim.data!;
  if (!s.enabled) return <p className="text-xs text-ink-3">The simulator is disabled (SIMULATOR_ENABLED=false). Enable it in the backend .env for demo data without hardware.</p>;
  const activeScenarios = Object.entries(s.scenarios);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={s.available ? 'amber' : 'neutral'} dot>
          {s.available ? 'running' : 'stopped'}
        </Badge>
        <span className="text-xs text-ink-3">
          device <span className="font-mono">{s.device_id}</span> · every {s.interval_seconds}s · {s.messages_sent} messages · last {fmtAgo(s.last_published_at)}
        </span>
        <Button size="xs" variant="outline" icon={<Power className="h-3 w-3" />} loading={toggle.isPending} onClick={() => guard(() => toggle.mutate(!s.available))}>
          {s.available ? 'Stop simulator' : 'Start simulator'}
        </Button>
      </div>
      <KeyValue
        items={[
          { k: 'Virtual chamber', v: `${fmtNumber(s.state.temperature_c, 1)} °C · ${fmtNumber(s.state.relative_humidity_percent, 0)} % RH · moisture ${s.state.substrate_moisture_raw} · ambient ${fmtNumber(s.state.ambient_temperature_c, 1)} °C` },
          { k: 'Relays', v: `fan ${s.state.fan ? 'ON' : 'off'} · heater ${s.state.heater ? 'ON' : 'off'} · humidifier ${s.state.humidifier ? 'ON' : 'off'}` },
          { k: 'Active scenarios', v: activeScenarios.length ? activeScenarios.map(([k, until]) => `${titleCase(k)}${until ? ` (until ${fmtDateTime(until, 'HH:mm')})` : ''}`).join(', ') : 'none' },
        ]}
      />
      <div>
        <p className="label mb-1.5">Trigger a scenario</p>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(s.scenarios_available).map(([key, desc]) => (
            <Button key={key} size="xs" variant={key === 'recover' ? 'primary' : 'outline'} title={desc} loading={scenario.isPending && scenario.variables === key} onClick={() => guard(() => scenario.mutate(key))}>
              {titleCase(key)}
            </Button>
          ))}
          <Input aria-label="Scenario duration minutes" type="number" min={0} max={720} placeholder="minutes (default)" value={duration} onChange={(e) => setDuration(e.target.value)} className="h-6 w-40 py-0 text-[11px]" />
        </div>
        <ul className="mt-2 space-y-0.5 text-[11px] text-ink-3">
          {Object.entries(s.scenarios_available).map(([key, desc]) => (
            <li key={key}>
              <span className="text-ink-2">{titleCase(key)}:</span> {desc}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function DeviceForm({ open, onClose, device }: { open: boolean; onClose: () => void; device?: Device | null }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState({ id: device?.id ?? '', name: device?.name ?? '', kind: device?.kind ?? 'hardware', transport: device?.transport ?? 'mqtt', hardware_notes: device?.hardware_notes ?? '', control_mode: device?.control_mode ?? 'monitor', is_enabled: device?.is_enabled ?? true, firmware_version: device?.firmware_version ?? '' });
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      if (device) return endpoints.updateDevice(device.id, { name: form.name, transport: form.transport, hardware_notes: form.hardware_notes || null, is_enabled: form.is_enabled, firmware_version: form.firmware_version || null });
      const created = await endpoints.createDevice({ id: form.id.trim(), name: form.name.trim(), kind: form.kind, transport: form.transport, hardware_notes: form.hardware_notes || null, control_mode: form.control_mode });
      if (form.kind === 'hardware') {
        const t = await endpoints.rotateToken(created.id);
        setToken(t.token);
      }
      return created;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['system'] });
      toast.success(device ? 'Device updated' : 'Device registered');
      if (device || form.kind !== 'hardware') onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={device ? `Edit ${device.id}` : 'Register device'}
      footer={
        token ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={save.isPending} onClick={() => { if (!form.name.trim() || (!device && !form.id.trim())) return setError('Device id and name are required'); setError(null); save.mutate(); }}>
              {device ? 'Save' : 'Register'}
            </Button>
          </>
        )
      }
    >
      {token ? (
        <div className="space-y-3">
          <Notice tone="brand">Device registered. Copy this token into the firmware now – it is shown only once and stored hashed on the server.</Notice>
          <TokenBox token={token} />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {!device && (
            <Field label="Device id" required hint="letters, digits, - and _ (e.g. myco-esp32-02)" htmlFor="d-id">
              <Input id="d-id" value={form.id} onChange={set('id')} pattern="^[a-zA-Z0-9_\-]+$" placeholder="myco-esp32-02" />
            </Field>
          )}
          <Field label="Name" required htmlFor="d-name">
            <Input id="d-name" value={form.name} onChange={set('name')} placeholder="Grow tent A" />
          </Field>
          {!device && (
            <Field label="Kind" htmlFor="d-kind">
              <Select id="d-kind" value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value, transport: e.target.value === 'simulated' ? 'simulator' : f.transport === 'simulator' ? 'mqtt' : f.transport }))}>
                <option value="hardware">hardware (ESP32)</option>
                <option value="simulated">simulated</option>
              </Select>
            </Field>
          )}
          <Field label="Transport" htmlFor="d-transport">
            <Select id="d-transport" value={form.transport} onChange={set('transport')} disabled={form.kind === 'simulated'}>
              {form.kind === 'simulated' ? <option value="simulator">simulator</option> : (
                <>
                  <option value="mqtt">MQTT (myco/{'{device_id}'}/…)</option>
                  <option value="http">HTTP/WS dev transport</option>
                </>
              )}
            </Select>
          </Field>
          {!device && (
            <Field label="Initial control mode" htmlFor="d-mode">
              <Select id="d-mode" value={form.control_mode} onChange={set('control_mode')}>
                <option value="monitor">monitoring</option>
                <option value="auto">automatic</option>
                <option value="manual">manual</option>
              </Select>
            </Field>
          )}
          {device && (
            <>
              <Field label="Firmware version" htmlFor="d-fw">
                <Input id="d-fw" value={form.firmware_version} onChange={set('firmware_version')} />
              </Field>
              <div className="flex items-end pb-1">
                <Toggle checked={form.is_enabled} onChange={(v) => setForm((f) => ({ ...f, is_enabled: v }))} label="Device enabled (accept telemetry & commands)" />
              </div>
            </>
          )}
          <Field label="Hardware notes" htmlFor="d-notes" className="sm:col-span-2" hint="sensor types, moisture probe calibration, relay/bulb rating, fan current…">
            <Textarea id="d-notes" value={form.hardware_notes} onChange={set('hardware_notes')} />
          </Field>
          {error && <p className="text-xs text-danger sm:col-span-2">{error}</p>}
        </div>
      )}
    </Modal>
  );
}

function TokenBox({ token }: { token: string }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-surface-2 p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">{token}</code>
      <Button size="xs" variant="outline" icon={<Copy className="h-3 w-3" />} onClick={() => navigator.clipboard?.writeText(token).then(() => toast.success('Token copied'))}>
        Copy
      </Button>
    </div>
  );
}

function DeviceCard({ d, onEdit }: { d: Device; onEdit: () => void }) {
  const { isAdmin, openLogin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const [token, setToken] = useState<string | null>(null);
  const [diagOpen, setDiagOpen] = useState(false);
  const diag = useQuery({ queryKey: ['devices', d.id, 'diagnostics'], queryFn: () => endpoints.diagnostics(d.id, 30), enabled: diagOpen });
  const rotate = useMutation({
    mutationFn: () => endpoints.rotateToken(d.id),
    onSuccess: (t) => {
      setToken(t.token);
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (e) => toast.error('Token rotation failed', errorMessage(e)),
  });
  const adminGuard = (fn: () => void) => {
    if (!isAdmin) {
      toast.warning('Admin account required');
      openLogin();
      return;
    }
    fn();
  };
  const ev = d.control_state?.last_evaluation;
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <DeviceKindIcon kind={d.kind} /> {d.name} <span className="font-mono text-xs text-ink-3">{d.id}</span>
        </span>
      }
      actions={
        <>
          <ConnectionBadge status={d.connection_status} lastSeen={d.last_seen_at} />
          {!d.is_enabled && <Badge tone="danger">disabled</Badge>}
          <Button size="xs" variant="outline" onClick={() => adminGuard(onEdit)}>
            Edit
          </Button>
        </>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        <KeyValue
          items={[
            { k: 'Kind', v: d.kind === 'simulated' ? <span className="inline-flex items-center gap-1"><Beaker className="h-3 w-3 text-amber" /> simulated – all data labelled <SourceTag kind="simulated" compact /></span> : 'hardware (ESP32)' },
            { k: 'Transport', v: d.transport },
            { k: 'Firmware', v: d.firmware_version ?? '—' },
            { k: 'Last seen', v: d.last_seen_at ? `${fmtAgo(d.last_seen_at)} (${fmtDateTime(d.last_seen_at, 'dd MMM HH:mm:ss')})` : 'never' },
            { k: 'Last telemetry', v: d.last_telemetry_at ? fmtAgo(d.last_telemetry_at) : 'never' },
            { k: 'Messages accepted', v: d.stats?.messages_accepted ?? 0 },
            { k: 'Control mode', v: d.control_mode },
            { k: 'Auth token', v: d.kind === 'simulated' ? 'not required' : d.has_token ? <Badge tone="brand">configured</Badge> : <Badge tone="danger">missing – device cannot publish</Badge> },
          ]}
        />
        <div className="space-y-2 text-xs">
          <p className="label">Hardware notes</p>
          <p className="whitespace-pre-wrap text-ink-2">{d.hardware_notes ?? 'none'}</p>
          {ev && (
            <p className="text-ink-3">
              Last evaluation {fmtAgo(ev.evaluated_at)} · {ev.interlocks.length} interlock(s) · {ev.decisions.length} decision(s)
            </p>
          )}
          <div className="flex flex-wrap gap-1.5 pt-1">
            {d.kind !== 'simulated' && (
              <Button size="xs" variant="outline" icon={<KeyRound className="h-3 w-3" />} loading={rotate.isPending} onClick={() => adminGuard(() => rotate.mutate())}>
                {d.has_token ? 'Rotate token' : 'Issue token'}
              </Button>
            )}
            <Button size="xs" variant="ghost" icon={<RefreshCw className="h-3 w-3" />} onClick={() => setDiagOpen((o) => !o)}>
              {diagOpen ? 'Hide diagnostics' : 'Diagnostics'}
            </Button>
          </div>
          {token && (
            <div className="space-y-1">
              <Notice tone="amber">New token – store it in the firmware now; the previous token stops working immediately.</Notice>
              <TokenBox token={token} />
            </div>
          )}
        </div>
      </div>
      {diagOpen && (
        <div className="mt-4 border-t border-line pt-3">
          {diag.isLoading ? (
            <Loading />
          ) : diag.error ? (
            <ErrorState error={diag.error} />
          ) : diag.data ? (
            <div className="grid gap-4 md:grid-cols-2">
              <KeyValue
                items={[
                  { k: 'Readings total', v: diag.data.readings_total },
                  { k: 'Readings 24 h', v: diag.data.readings_24h },
                  { k: 'Rejections 24 h', v: <span className={diag.data.rejections_24h ? 'text-amber' : undefined}>{diag.data.rejections_24h}</span> },
                  { k: 'First reading', v: fmtDateTime(diag.data.first_reading_at) },
                  { k: 'Telemetry age', v: diag.data.telemetry_age_seconds !== null ? fmtDuration(diag.data.telemetry_age_seconds) : '—' },
                  { k: 'Last reading quality', v: diag.data.last_reading ? Object.entries(diag.data.last_reading.quality).filter(([k, v]) => typeof v === 'string' && v !== 'ok' && k !== 'transport').map(([k, v]) => `${k}: ${v}`).join(', ') || 'all ok' : '—' },
                ]}
              />
              <div>
                <p className="label mb-1">Recent device events</p>
                <ul className="max-h-48 space-y-1 overflow-y-auto text-[11px]">
                  {diag.data.events.length === 0 && <li className="text-ink-3">no events</li>}
                  {diag.data.events.map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="shrink-0 font-mono text-ink-3">{fmtDateTime(e.created_at, 'dd MMM HH:mm:ss')}</span>
                      <Badge tone={e.level === 'error' ? 'danger' : e.level === 'warning' ? 'amber' : 'neutral'}>{e.category}</Badge>
                      <span className="text-ink-2">{e.message}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}

export default function Devices() {
  const devices = useDevices();
  const { isAdmin, openLogin } = useAuth();
  const { detailed } = useViewMode();
  const toast = useToast();
  const status = useQuery({ queryKey: qk.status, queryFn: endpoints.systemStatus, refetchInterval: 15000 });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Device Management"
        description={detailed ? 'Registered ESP32 nodes and the built-in simulator. Devices authenticate with a per-device token (MQTT payload field or X-Device-Token header); readings are tagged with their origin.' : 'Your chamber controllers (ESP32 boards) and the demo simulator. Each controller gets its own access token, and every reading is tagged with where it came from.'}
        actions={
          <Button
            size="sm"
            variant="primary"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => {
              if (!isAdmin) {
                toast.warning('Admin account required to register devices');
                openLogin();
                return;
              }
              setEditing(null);
              setFormOpen(true);
            }}
          >
            Register device
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Transports" className="lg:col-span-1">
          {status.data ? (
            <KeyValue
              items={[
                { k: 'MQTT broker', v: status.data.mqtt.enabled ? <span>{status.data.mqtt.connected ? <Badge tone="brand">connected</Badge> : <Badge tone="danger">disconnected</Badge>} <span className="text-ink-3">{status.data.mqtt.detail}</span></span> : <span><Badge>disabled</Badge> <span className="text-ink-3">set MQTT_ENABLED=true and MQTT_HOST</span></span> },
                { k: 'Topic prefix', v: <span className="font-mono">{status.data.mqtt.topic_prefix}/{'{device_id}'}/telemetry|status|commands|command-status</span> },
                { k: 'HTTP ingest', v: <span className="font-mono">POST /api/ingest/telemetry · GET /api/ingest/commands</span> },
                { k: 'Live feed', v: <span className="font-mono">WS /ws/live</span> },
                ...status.data.transports.map((t) => ({ k: titleCase(t.name), v: <span>{t.available ? <Badge tone="brand">available</Badge> : <Badge>unavailable</Badge>} <span className="text-ink-3">{t.detail}</span></span> })),
              ]}
            />
          ) : (
            <Loading />
          )}
        </Card>
        <Card title="Hardware simulator" subtitle="publishes the same schema as the firmware; all its data is marked as simulated" className="lg:col-span-2">
          <SimulatorPanel />
        </Card>
      </div>

      {devices.isLoading ? (
        <Loading />
      ) : devices.error ? (
        <ErrorState error={devices.error} onRetry={() => devices.refetch()} />
      ) : !devices.data?.length ? (
        <EmptyState title="No devices" description="Register your ESP32 to receive telemetry." />
      ) : (
        <div className="space-y-4">
          {devices.data.map((d) => (
            <DeviceCard
              key={d.id}
              d={d}
              onEdit={() => {
                setEditing(d);
                setFormOpen(true);
              }}
            />
          ))}
        </div>
      )}
      {formOpen && <DeviceForm open={formOpen} onClose={() => setFormOpen(false)} device={editing} />}
    </div>
  );
}
