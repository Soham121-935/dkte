import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Play, ShieldAlert, ShieldCheck } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { useControl } from '@/lib/queries';
import { useDevice } from '@/providers/DeviceProvider';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { useLive } from '@/providers/LiveProvider';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, KeyValue, Loading, Notice, errorMessage, statusTone } from '@/components/ui';
import { ACTUATOR_META, ConnectionBadge, SectionTitle, SourceTag } from '@/components/domain';
import { fmtAgo, fmtDateTime, fmtDuration, fmtNumber } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { Actuator, ControlMode } from '@/api/types';

const MODE_META: Record<ControlMode, { label: string; description: string }> = {
  monitor: { label: 'Monitoring', description: 'Read-only. No commands are sent except safety interlocks that switch the heater off.' },
  auto: { label: 'Automatic', description: 'The deterministic controller keeps temperature and humidity inside the stage targets using hysteresis, minimum switching intervals and heater runtime limits.' },
  manual: { label: 'Manual', description: 'You switch actuators yourself. Safety interlocks still apply (stale sensor, absolute maximum, heater runtime).' },
};

const CONFIG_FIELDS: { key: string; label: string; unit: string; step?: number; hint: string }[] = [
  { key: 'hysteresis_temp_c', label: 'Temperature hysteresis', unit: '°C', step: 0.1, hint: 'Deadband around the limits before switching' },
  { key: 'hysteresis_rh', label: 'Humidity hysteresis', unit: '%', step: 0.5, hint: 'Deadband around the RH limits' },
  { key: 'min_switch_interval_seconds', label: 'Minimum switching interval', unit: 's', hint: 'Protects relays / humidifier from rapid cycling' },
  { key: 'heater_max_runtime_seconds', label: 'Max continuous heater runtime', unit: 's', hint: 'Heater is forced off after this and cools down' },
  { key: 'heater_cooldown_seconds', label: 'Heater cooldown', unit: 's', hint: 'Lockout after the maximum runtime' },
  { key: 'heater_absolute_max_temp_c', label: 'Absolute heater cutoff', unit: '°C', step: 0.5, hint: 'Heater is never on at/above this reading' },
  { key: 'stale_sensor_timeout_seconds', label: 'Stale sensor timeout', unit: 's', hint: 'Older readings count as stale → safe state' },
];

export default function Control() {
  const { device, deviceId } = useDevice();
  const { canOperate, openLogin, user } = useAuth();
  const { devices: liveDevices } = useLive();
  const toast = useToast();
  const qc = useQueryClient();
  const control = useControl(deviceId);
  const [confirm, setConfirm] = useState<{ actuator: Actuator; state: boolean } | null>(null);
  const [reason, setReason] = useState('');
  const [cfg, setCfg] = useState<Record<string, string>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['control'] });
    qc.invalidateQueries({ queryKey: ['devices'] });
    qc.invalidateQueries({ queryKey: ['system'] });
  };
  const guard = (fn: () => void) => {
    if (!canOperate) {
      toast.warning('Control actions require an operator or admin account');
      openLogin();
      return;
    }
    fn();
  };

  const setMode = useMutation({
    mutationFn: (mode: ControlMode) => endpoints.setMode(deviceId!, mode),
    onSuccess: (_d, mode) => {
      invalidate();
      toast.success(`Control mode set to ${MODE_META[mode].label.toLowerCase()}`);
    },
    onError: (e) => toast.error('Mode change rejected', errorMessage(e)),
  });
  const command = useMutation({
    mutationFn: (p: { actuator: Actuator; state: boolean; reason?: string }) => endpoints.command(deviceId!, p),
    onSuccess: (cmd) => {
      invalidate();
      if (cmd.status === 'rejected' || cmd.status === 'failed') toast.error(`Command ${cmd.status}`, cmd.error ?? 'validation failed');
      else toast.info(`${ACTUATOR_META[cmd.actuator].label} → ${cmd.requested_state ? 'ON' : 'OFF'} sent`, 'Waiting for the device to confirm the new state.');
      setConfirm(null);
      setReason('');
    },
    onError: (e) => toast.error('Command rejected', errorMessage(e)),
  });
  const evaluate = useMutation({
    mutationFn: () => endpoints.evaluate(deviceId!),
    onSuccess: (ev) => {
      invalidate();
      toast.success('Controller evaluated', ev.decisions.length ? `${ev.decisions.length} decision(s): ${ev.decisions.map((d) => `${d.actuator}→${d.desired ? 'ON' : 'OFF'}`).join(', ')}` : ev.notes[0] ?? 'no action needed');
    },
    onError: (e) => toast.error('Evaluation failed', errorMessage(e)),
  });
  const saveConfig = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {};
      CONFIG_FIELDS.forEach((f) => {
        if (cfg[f.key] !== undefined && cfg[f.key] !== '') body[f.key] = Number(cfg[f.key]);
      });
      const t: Record<string, number> = {};
      Object.entries(targets).forEach(([k, v]) => {
        if (v !== '') t[k] = Number(v);
      });
      if (Object.keys(t).length) body.targets = t;
      return endpoints.updateControlConfig(deviceId!, body);
    },
    onSuccess: () => {
      invalidate();
      setCfg({});
      setTargets({});
      toast.success('Control configuration saved');
    },
    onError: (e) => toast.error('Configuration rejected', errorMessage(e)),
  });

  useEffect(() => {
    setCfg({});
    setTargets({});
  }, [deviceId]);

  if (!device) return <EmptyState title="No device selected" />;
  if (control.isLoading) return <Loading label="Loading controller state…" />;
  if (control.error) return <ErrorState error={control.error} onRetry={() => control.refetch()} />;
  const c = control.data!;
  const live = liveDevices[device.id] ?? c.device;
  const mode = live.control_mode ?? c.mode;
  const ev = c.last_evaluation;
  const offline = live.connection_status !== 'online';
  const heaterInterlock = ev?.interlocks.find((i) => i.actuator === 'heater');

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Environmental Control"
        description="All actuator changes go through the deterministic control service: hysteresis, minimum switching intervals, heater runtime limits and sensor-validity interlocks are enforced server-side. The AI assistant cannot switch anything."
        actions={
          <>
            <ConnectionBadge status={live.connection_status} lastSeen={live.last_seen_at} />
            {!user && (
              <Badge tone="amber">
                <Lock className="h-3 w-3" /> sign in to control
              </Badge>
            )}
          </>
        }
      />

      {offline && (
        <Notice tone="danger" icon={<ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}>
          <strong>Device {live.connection_status === 'offline' ? 'DISCONNECTED' : live.connection_status.toUpperCase()}.</strong> Commands are not accepted while the device is offline; reported actuator states may be outdated. The ESP32 firmware applies its own fail-safe (heater off, command watchdog) when it loses the server.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Control mode" className="lg:col-span-1">
          <div className="space-y-2">
            {(['monitor', 'auto', 'manual'] as ControlMode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={setMode.isPending}
                onClick={() => guard(() => m !== mode && setMode.mutate(m))}
                aria-pressed={mode === m}
                className={cn('flex w-full items-start gap-3 rounded-md border p-3 text-left transition-colors', mode === m ? 'border-brand bg-brand/10' : 'border-line hover:border-line-strong hover:bg-surface-2')}
              >
                <span className={cn('mt-1 h-3 w-3 shrink-0 rounded-full border', mode === m ? 'border-brand bg-brand' : 'border-line-strong')} aria-hidden />
                <span>
                  <span className="block text-sm font-medium text-ink">{MODE_META[m].label}</span>
                  <span className="block text-xs text-ink-3">{MODE_META[m].description}</span>
                </span>
              </button>
            ))}
          </div>
          <Button size="sm" variant="outline" className="mt-3" icon={<Play className="h-3.5 w-3.5" />} loading={evaluate.isPending} onClick={() => guard(() => evaluate.mutate())}>
            Evaluate controller now
          </Button>
        </Card>

        <Card title="Actuators" subtitle="requested vs. confirmed state – a sent command is not proof the relay switched" className="lg:col-span-2" padded={false}>
          <div className="divide-y divide-line">
            {(['fan', 'heater', 'humidifier'] as Actuator[]).map((a) => {
              const entry = live.actuator_state?.[a] ?? c.actuators[a] ?? {};
              const meta = ACTUATOR_META[a];
              const Icon = meta.icon;
              const confirmed = entry.confirmed ?? null;
              const status = entry.status ?? 'unknown';
              const canSwitch = mode === 'manual' && !offline;
              const cooldown = entry.cooldown_until && new Date(entry.cooldown_until).getTime() > Date.now();
              return (
                <div key={a} className="grid gap-3 px-4 py-3 sm:grid-cols-[1fr_auto]">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Icon className={cn('h-4 w-4', confirmed ? 'text-brand' : 'text-ink-3')} aria-hidden />
                      <span className="text-sm font-medium text-ink">{meta.label}</span>
                      <Badge tone={confirmed === null ? 'neutral' : confirmed ? 'brand' : 'muted'}>confirmed: {confirmed === null ? 'unknown' : confirmed ? 'ON' : 'OFF'}</Badge>
                      {entry.requested !== undefined && entry.requested !== null && <Badge tone={entry.requested === confirmed ? 'neutral' : 'amber'}>requested: {entry.requested ? 'ON' : 'OFF'}</Badge>}
                      <Badge tone={statusTone(status)}>{status}</Badge>
                      {cooldown && <Badge tone="amber">cooldown until {fmtDateTime(entry.cooldown_until!, 'HH:mm')}</Badge>}
                    </div>
                    <p className="mt-1 text-[11px] text-ink-3">{meta.hardware}</p>
                    <p className="mt-0.5 text-[11px] text-ink-3">
                      {entry.since ? `in this state since ${fmtDateTime(entry.since, 'dd MMM HH:mm')} (${fmtDuration((Date.now() - new Date(entry.since).getTime()) / 1000)})` : 'no state history'}
                      {entry.confirmed_at && ` · last report ${fmtAgo(entry.confirmed_at)}`}
                    </p>
                    {entry.last_reason && (
                      <p className="mt-0.5 text-[11px] text-ink-2">
                        Last command ({entry.last_origin ?? '—'}, {entry.requested_by ?? '—'}): {entry.last_reason}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 self-center">
                    <Button size="sm" variant={confirmed === true ? 'secondary' : 'primary'} disabled={!canSwitch || confirmed === true || (a === 'heater' && !!heaterInterlock)} onClick={() => guard(() => setConfirm({ actuator: a, state: true }))} title={!canSwitch ? 'Switch to manual mode (device must be online)' : undefined}>
                      Turn ON
                    </Button>
                    <Button size="sm" variant="outline" disabled={!canSwitch || confirmed === false} onClick={() => guard(() => setConfirm({ actuator: a, state: false }))} title={!canSwitch ? 'Switch to manual mode (device must be online)' : undefined}>
                      Turn OFF
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          {mode !== 'manual' && <p className="border-t border-line px-4 py-2 text-[11px] text-ink-3">Manual switching is only available in manual mode. In automatic mode the controller owns the actuators; in monitoring mode nothing is switched.</p>}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Last controller evaluation" subtitle={ev ? `${fmtDateTime(ev.evaluated_at, 'dd MMM HH:mm:ss')} · mode ${ev.mode}` : 'not evaluated yet'} className="lg:col-span-2">
          {!ev ? (
            <p className="text-xs text-ink-3">The controller evaluates on every accepted reading and periodically.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-3 text-xs">
                <div>
                  <p className="label mb-1">Inputs</p>
                  <KeyValue
                    items={[
                      { k: 'Temperature', v: `${fmtNumber(ev.inputs.temperature_c, 1)} °C ${ev.inputs.temperature_valid ? '' : '(invalid)'}` },
                      { k: 'Humidity', v: `${fmtNumber(ev.inputs.relative_humidity_percent, 0)} % ${ev.inputs.humidity_valid ? '' : '(invalid)'}` },
                      { k: 'Measured', v: ev.inputs.measured_at ? `${fmtDateTime(ev.inputs.measured_at, 'HH:mm:ss')} ${ev.inputs.stale ? '– STALE' : ''}` : 'no reading' },
                      { k: 'Device', v: ev.inputs.device_online ? 'online' : 'offline' },
                    ]}
                  />
                </div>
                <div>
                  <p className="label mb-1">Targets in effect</p>
                  <KeyValue
                    items={[
                      { k: 'Temperature', v: `${ev.targets.temperature_min_c ?? '—'} – ${ev.targets.temperature_max_c ?? '—'} °C` },
                      { k: 'Humidity', v: `${ev.targets.humidity_min_percent ?? '—'} – ${ev.targets.humidity_max_percent ?? '—'} %` },
                      { k: 'Fresh air', v: ev.targets.fae_cycle_minutes ? `${ev.targets.fae_duration_minutes} min every ${ev.targets.fae_cycle_minutes} min` : 'no cycle' },
                      { k: 'Source', v: <span className="inline-flex items-center gap-1"><SourceTag source={ev.targets.source} /> {ev.targets.source_label}</span> },
                    ]}
                  />
                </div>
              </div>
              <div className="space-y-3 text-xs">
                <div>
                  <p className="label mb-1">Interlocks</p>
                  {ev.interlocks.length ? (
                    <ul className="space-y-1">
                      {ev.interlocks.map((i) => (
                        <li key={i.key} className="flex items-start gap-1.5 text-amber">
                          <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" /> {i.message}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="flex items-center gap-1.5 text-ink-3">
                      <ShieldCheck className="h-3 w-3 text-brand" /> none active
                    </p>
                  )}
                </div>
                <div>
                  <p className="label mb-1">Decisions</p>
                  {ev.decisions.length ? (
                    <ul className="space-y-1">
                      {ev.decisions.map((d, i) => (
                        <li key={i} className="text-ink-2">
                          <Badge tone={d.origin === 'safety' ? 'danger' : 'brand'}>{d.origin}</Badge> {d.actuator} → {d.desired === null ? 'no change' : d.desired ? 'ON' : 'OFF'} · {d.reason}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-ink-3">no changes required</p>
                  )}
                </div>
                {ev.notes.length > 0 && (
                  <div>
                    <p className="label mb-1">Notes</p>
                    <ul className="list-disc space-y-0.5 pl-4 text-ink-3">
                      {ev.notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card title="Safety rules" subtitle="enforced on the server for every command">
          <ul className="space-y-1.5 text-xs text-ink-2">
            {c.safety_notes.map((n, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-brand" /> {n}
              </li>
            ))}
            <li className="flex items-start gap-1.5">
              <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-brand" /> The 12 V fan can only cool towards ambient; it cannot cool below room temperature.
            </li>
          </ul>
        </Card>
      </div>

      <Card title="Controller parameters" subtitle="per-device overrides of the system defaults (admin/operator)">
        <form
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            guard(() => saveConfig.mutate());
          }}
        >
          {CONFIG_FIELDS.map((f) => (
            <Field key={f.key} label={`${f.label} (${f.unit})`} hint={f.hint} htmlFor={`cfg-${f.key}`}>
              <Input id={`cfg-${f.key}`} type="number" step={f.step ?? 1} value={cfg[f.key] ?? String(c.config[f.key] ?? '')} onChange={(e) => setCfg((v) => ({ ...v, [f.key]: e.target.value }))} />
            </Field>
          ))}
          <div className="sm:col-span-2 lg:col-span-4">
            <p className="label mb-2">Device target override (used when no batch/profile target applies)</p>
            <div className="grid gap-3 sm:grid-cols-4">
              {[
                ['temperature_min_c', 'Temp min °C'],
                ['temperature_max_c', 'Temp max °C'],
                ['humidity_min_percent', 'RH min %'],
                ['humidity_max_percent', 'RH max %'],
              ].map(([k, label]) => (
                <Field key={k} label={label} htmlFor={`tg-${k}`}>
                  <Input id={`tg-${k}`} type="number" step="0.5" value={targets[k] ?? String(((c.device.control_config as Record<string, unknown> | null)?.targets as Record<string, number> | undefined)?.[k] ?? '')} onChange={(e) => setTargets((v) => ({ ...v, [k]: e.target.value }))} placeholder="batch/profile" />
                </Field>
              ))}
            </div>
          </div>
          <div className="flex items-end sm:col-span-2 lg:col-span-4">
            <Button type="submit" variant="primary" loading={saveConfig.isPending}>
              Save parameters
            </Button>
          </div>
        </form>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Command log" subtitle="every command, including rejected ones" padded={false}>
          {!c.recent_commands.length ? (
            <EmptyState title="No commands yet" className="py-6" />
          ) : (
            <div className="max-h-[380px] overflow-auto">
              <table className="table">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th>Time</th>
                    <th>Actuator</th>
                    <th>Origin</th>
                    <th>Status</th>
                    <th>Reason / error</th>
                  </tr>
                </thead>
                <tbody>
                  {c.recent_commands.map((cmd) => (
                    <tr key={cmd.id}>
                      <td className="font-mono text-xs">{fmtDateTime(cmd.created_at, 'dd MMM HH:mm:ss')}</td>
                      <td>
                        {ACTUATOR_META[cmd.actuator].label} → {cmd.requested_state ? 'ON' : 'OFF'}
                      </td>
                      <td>
                        <Badge tone={cmd.origin === 'safety' ? 'danger' : cmd.origin === 'manual' ? 'teal' : 'neutral'}>{cmd.origin}</Badge>
                        <span className="ml-1 text-[11px] text-ink-3">{cmd.requested_by}</span>
                      </td>
                      <td>
                        <Badge tone={statusTone(cmd.status)}>{cmd.status}</Badge>
                      </td>
                      <td className="text-xs">
                        {cmd.reason}
                        {cmd.error && <span className="block text-danger">{cmd.error}</span>}
                        {cmd.validation?.checks?.length ? <span className="block text-[10px] text-ink-3">checks: {cmd.validation.checks.join(', ')}</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title="Reported actuator state changes" subtitle="from device telemetry and command acknowledgements" padded={false}>
          {!c.recent_status_events.length ? (
            <EmptyState title="No state changes recorded" className="py-6" />
          ) : (
            <div className="max-h-[380px] overflow-auto">
              <table className="table">
                <thead className="sticky top-0 bg-surface">
                  <tr>
                    <th>Observed</th>
                    <th>Actuator</th>
                    <th>State</th>
                    <th>Source</th>
                    <th>Command</th>
                  </tr>
                </thead>
                <tbody>
                  {c.recent_status_events.map((e) => (
                    <tr key={e.id}>
                      <td className="font-mono text-xs">{fmtDateTime(e.observed_at, 'dd MMM HH:mm:ss')}</td>
                      <td>{ACTUATOR_META[e.actuator].label}</td>
                      <td>{e.state ? <Badge tone="brand">ON</Badge> : <Badge>OFF</Badge>}</td>
                      <td className="text-xs">{e.source}</td>
                      <td className="font-mono text-[11px] text-ink-3">{e.command_id ? e.command_id.slice(0, 8) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && command.mutate({ actuator: confirm.actuator, state: confirm.state, reason: reason.trim() || `manual ${confirm.actuator} ${confirm.state ? 'on' : 'off'} from dashboard` })}
        loading={command.isPending}
        title={confirm ? `Switch ${ACTUATOR_META[confirm.actuator].label} ${confirm.state ? 'ON' : 'OFF'}` : ''}
        confirmLabel="Send command"
        danger={confirm?.actuator === 'heater' && confirm.state}
        message={
          confirm && (
            <div className="space-y-2">
              <p>
                The command is validated by the control service (switching interval, sensor freshness, heater limits) and then sent to <span className="font-mono">{device.id}</span>. The state is only shown as ON/OFF once the device confirms it.
              </p>
              {confirm.actuator === 'heater' && confirm.state && <p className="text-amber">The heater is a tungsten bulb – make sure the independent thermal cutoff is installed.</p>}
              <Field label="Reason (logged)" htmlFor="cmd-reason">
                <Input id="cmd-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="optional" maxLength={300} />
              </Field>
            </div>
          )
        }
      />
    </div>
  );
}
