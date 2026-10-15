import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, RotateCcw, Save, Stethoscope } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { qk, useProfiles } from '@/lib/queries';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { useTheme } from '@/providers/ThemeProvider';
import { ViewModeSwitch } from '@/components/Technical';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, KeyValue, Loading, Modal, Notice, Select, Tabs, Toggle, errorMessage } from '@/components/ui';
import { SectionTitle, SourceTag } from '@/components/domain';
import { fmtDateTime, titleCase } from '@/lib/format';
import type { Profile, StageDefinition } from '@/api/types';

const SECTION_META: Record<string, { label: string; description: string }> = {
  validation: { label: 'Which readings are accepted', description: 'Plausibility limits for incoming readings. Values outside min/max are rejected; values outside what the sensor can measure are stored but flagged as doubtful.' },
  alerts: { label: 'Alert thresholds', description: 'How long before an alert repeats, when it clears itself, grace periods and the thresholds that trigger each alert.' },
  control_defaults: { label: 'Control defaults', description: 'Switching buffers, minimum time between switches and heater limits used by chambers without their own settings, plus default target ranges.' },
  display: { label: 'Display', description: 'Time zone and units (informational).' },
};

const FIELD_LABELS: Record<string, string> = {
  min: 'Reject below',
  max: 'Reject above',
  sensor_min: 'Sensor range min',
  sensor_max: 'Sensor range max',
  max_step_per_minute: 'Max change per minute',
  max_message_age_seconds: 'Max message age (s)',
  max_future_skew_seconds: 'Max future clock skew (s)',
  accept_unsynced_clock: 'Accept devices without NTP (use server time)',
  cooldown_seconds: 'Re-notification cooldown (s)',
  auto_resolve_after_seconds: 'Auto-resolve after condition clears (s)',
  out_of_range_grace_seconds: 'Grace before out-of-range alert (s)',
  stale_telemetry_seconds: 'Stale telemetry after (s)',
  heater_max_runtime_seconds: 'Heater max runtime (s)',
  rapid_temp_rise_c_per_10min: 'Rapid rise (°C per 10 min)',
  fluctuation_std_c_15min: 'Fluctuation std (°C, 15 min)',
  rapid_switching_count_15min: 'Rapid switching (count / 15 min)',
  command_timeout_seconds: 'Command confirmation timeout (s)',
  notify_min_severity: 'Notify externally from severity',
  hysteresis_temp_c: 'Temperature hysteresis (°C)',
  hysteresis_rh: 'Humidity hysteresis (%)',
  min_switch_interval_seconds: 'Minimum switching interval (s)',
  heater_cooldown_seconds: 'Heater cooldown (s)',
  heater_absolute_max_temp_c: 'Absolute heater cutoff (°C)',
  stale_sensor_timeout_seconds: 'Stale sensor timeout (s)',
  temperature_min_c: 'Default temp min (°C)',
  temperature_max_c: 'Default temp max (°C)',
  humidity_min_percent: 'Default RH min (%)',
  humidity_max_percent: 'Default RH max (%)',
  moisture_min_raw: 'Default moisture min (raw)',
  fae_cycle_minutes: 'FAE cycle (min)',
  fae_duration_minutes: 'FAE duration (min)',
  timezone: 'Time zone',
  temperature_unit: 'Temperature unit',
};

type Flat = Record<string, unknown>;

function flatten(obj: Record<string, unknown>, prefix = ''): Flat {
  const out: Flat = {};
  Object.entries(obj).forEach(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) Object.assign(out, flatten(v as Record<string, unknown>, key));
    else out[key] = v;
  });
  return out;
}

function unflatten(flat: Flat): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  Object.entries(flat).forEach(([k, v]) => {
    const parts = k.split('.');
    let cur = out;
    parts.forEach((p, i) => {
      if (i === parts.length - 1) cur[p] = v;
      else {
        cur[p] = (cur[p] as Record<string, unknown>) ?? {};
        cur = cur[p] as Record<string, unknown>;
      }
    });
  });
  return out;
}

function SettingsSection({ section, values, defaults, onSaved }: { section: string; values: Record<string, unknown>; defaults: Record<string, unknown>; onSaved: () => void }) {
  const { isAdmin, openLogin } = useAuth();
  const toast = useToast();
  const flat = useMemo(() => flatten(values), [values]);
  const flatDefaults = useMemo(() => flatten(defaults), [defaults]);
  const [draft, setDraft] = useState<Flat>({});
  useEffect(() => setDraft({}), [values]);
  const current = (k: string) => (k in draft ? draft[k] : flat[k]);
  const save = useMutation({
    mutationFn: () => {
      const merged: Flat = { ...flat };
      Object.entries(draft).forEach(([k, v]) => {
        const base = flat[k];
        if (typeof base === 'number') {
          const n = Number(v);
          if (v === '' || Number.isNaN(n)) throw new Error(`${FIELD_LABELS[k.split('.').pop()!] ?? k} must be a number`);
          merged[k] = n;
        } else if (typeof base === 'boolean') merged[k] = Boolean(v);
        else if (base === null) merged[k] = v === '' || v === null ? null : Number.isNaN(Number(v)) ? v : Number(v);
        else merged[k] = v;
      });
      return endpoints.updateSettings(section, unflatten(merged));
    },
    onSuccess: () => {
      toast.success(`${SECTION_META[section]?.label ?? section} saved`);
      onSaved();
    },
    onError: (e) => toast.error('Settings rejected', errorMessage(e)),
  });
  const reset = useMutation({
    mutationFn: () => endpoints.updateSettings(section, defaults),
    onSuccess: () => {
      toast.success('Defaults restored');
      onSaved();
    },
    onError: (e) => toast.error('Reset failed', errorMessage(e)),
  });
  const guard = (fn: () => void) => {
    if (!isAdmin) {
      toast.warning('Admin account required to change settings');
      openLogin();
      return;
    }
    fn();
  };
  const groups = useMemo(() => {
    const g: Record<string, string[]> = {};
    Object.keys(flat).forEach((k) => {
      const parts = k.split('.');
      const group = parts.length > 1 ? parts.slice(0, -1).join('.') : '';
      (g[group] ??= []).push(k);
    });
    return g;
  }, [flat]);
  const dirty = Object.keys(draft).length > 0;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        guard(() => save.mutate());
      }}
    >
      {Object.entries(groups).map(([group, keys]) => (
        <div key={group}>
          {group && <p className="label mb-2">{titleCase(group.replace('_c', ' (°C)').replace('_percent', ' (%)').replace('_raw', ' (raw)'))}</p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {keys.map((k) => {
              const leaf = k.split('.').pop()!;
              const label = FIELD_LABELS[leaf] ?? titleCase(leaf);
              const base = flat[k];
              const val = current(k);
              const changed = k in draft && draft[k] !== flat[k];
              const isDefault = flatDefaults[k] === flat[k];
              if (typeof base === 'boolean') {
                return (
                  <div key={k} className="flex items-end pb-1">
                    <Toggle checked={Boolean(val)} onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))} label={label} />
                  </div>
                );
              }
              if (leaf === 'notify_min_severity') {
                return (
                  <Field key={k} label={label} htmlFor={`s-${k}`}>
                    <Select id={`s-${k}`} value={String(val)} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))}>
                      {['info', 'warning', 'critical'].map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </Select>
                  </Field>
                );
              }
              return (
                <Field key={k} label={<span>{label}{changed && <Badge tone="amber" className="ml-1">unsaved</Badge>}</span>} hint={isDefault ? 'default' : `default: ${String(flatDefaults[k])}`} htmlFor={`s-${k}`}>
                  <Input id={`s-${k}`} type={typeof base === 'number' || base === null ? 'number' : 'text'} step="any" value={val === null || val === undefined ? '' : String(val)} onChange={(e) => setDraft((d) => ({ ...d, [k]: e.target.value }))} placeholder={base === null ? 'not set' : undefined} />
                </Field>
              );
            })}
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" icon={<Save className="h-3.5 w-3.5" />} loading={save.isPending} disabled={!dirty}>
          Save section
        </Button>
        <Button variant="ghost" onClick={() => setDraft({})} disabled={!dirty}>
          Discard changes
        </Button>
        <Button variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={reset.isPending} onClick={() => guard(() => reset.mutate())}>
          Restore defaults
        </Button>
      </div>
    </form>
  );
}

function ProfilesPanel() {
  const profiles = useProfiles();
  const qc = useQueryClient();
  const toast = useToast();
  const { canOperate, openLogin } = useAuth();
  const [editing, setEditing] = useState<Profile | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const guard = (fn: () => void) => {
    if (!canOperate) {
      toast.warning('Operator account required');
      openLogin();
      return;
    }
    fn();
  };
  const clone = useMutation({
    mutationFn: (id: number) => endpoints.cloneProfile(id),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: qk.profiles });
      toast.success(`Cloned as "${p.name}" – now editable`);
      setEditing(p);
    },
    onError: (e) => toast.error('Clone failed', errorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: number) => endpoints.deleteProfile(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.profiles });
      setDeleting(null);
      toast.success('Profile deleted');
    },
    onError: (e) => toast.error('Delete failed', errorMessage(e)),
  });
  if (profiles.isLoading) return <Loading />;
  if (profiles.error) return <ErrorState error={profiles.error} onRetry={() => profiles.refetch()} />;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-3">Reference profiles are read-only literature ranges. Clone one to adapt stages, durations and targets to your strain and chamber.</p>
        <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => guard(() => setCreating(true))}>
          New profile
        </Button>
      </div>
      {!profiles.data?.length ? (
        <EmptyState title="No profiles" />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {profiles.data.map((p) => (
            <Card key={p.id} title={<span className="inline-flex items-center gap-2">{p.name} <SourceTag source={p.source} /></span>} subtitle={<span><em>{p.species}</em>{p.strain ? ` · ${p.strain}` : ''} · {p.stages.length} stages</span>} actions={
              <>
                <Button size="xs" variant="outline" icon={<Copy className="h-3 w-3" />} loading={clone.isPending && clone.variables === p.id} onClick={() => guard(() => clone.mutate(p.id))}>
                  Clone
                </Button>
                {!p.is_builtin && (
                  <>
                    <Button size="xs" variant="outline" onClick={() => guard(() => setEditing(p))}>
                      Edit
                    </Button>
                    <Button size="xs" variant="danger" onClick={() => guard(() => setDeleting(p))}>
                      Delete
                    </Button>
                  </>
                )}
              </>
            }>
              <p className="mb-2 text-[11px] text-ink-3">{p.source_notes}</p>
              <div className="overflow-x-auto">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Stage</th>
                      <th>Typical</th>
                      <th>Temp</th>
                      <th>RH</th>
                      <th>FAE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.stages.map((s) => (
                      <tr key={s.key}>
                        <td className="text-ink">{s.name}{s.milestone && <Badge tone="teal" className="ml-1">milestone</Badge>}</td>
                        <td>{s.typical_duration_days ? `${s.typical_duration_days.min}–${s.typical_duration_days.max} d` : '—'}</td>
                        <td className="font-mono">{s.targets.temperature_min_c ?? '—'}–{s.targets.temperature_max_c ?? '—'}</td>
                        <td className="font-mono">{s.targets.humidity_min_percent ?? '—'}–{s.targets.humidity_max_percent ?? '—'}</td>
                        <td className="font-mono">{s.targets.fae_cycle_minutes ? `${s.targets.fae_duration_minutes}/${s.targets.fae_cycle_minutes}` : 'off'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ))}
        </div>
      )}
      {(editing || creating) && <ProfileEditor profile={editing} onClose={() => { setEditing(null); setCreating(false); }} />}
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} onConfirm={() => deleting && del.mutate(deleting.id)} loading={del.isPending} danger title="Delete profile" confirmLabel="Delete" message={`Delete profile "${deleting?.name}"? Batches using it keep their stage history but lose the profile link.`} />
    </div>
  );
}

const EMPTY_STAGE: StageDefinition = { key: '', name: '', description: '', milestone: false, typical_duration_days: { min: 0, max: 0 }, targets: { temperature_min_c: null, temperature_max_c: null, humidity_min_percent: null, humidity_max_percent: null, moisture_min_raw: null, fae_cycle_minutes: 0, fae_duration_minutes: 0 }, observable_signs: [], transition_criteria: '', requires_confirmation: true };

function ProfileEditor({ profile, onClose }: { profile: Profile | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [meta, setMeta] = useState({ name: profile?.name ?? '', species: profile?.species ?? '', strain: profile?.strain ?? '', cultivation_method: profile?.cultivation_method ?? '', substrate_type: profile?.substrate_type ?? '', source_notes: profile?.source_notes ?? '' });
  const [stages, setStages] = useState<StageDefinition[]>(profile?.stages.map((s) => ({ ...s, typical_duration_days: s.typical_duration_days ?? { min: 0, max: 0 } })) ?? [{ ...EMPTY_STAGE, key: 'incubation', name: 'Incubation' }]);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      if (!meta.name.trim() || !meta.species.trim()) throw new Error('Name and species are required');
      const keys = stages.map((s) => s.key);
      if (keys.some((k) => !/^[a-z0-9_]+$/.test(k))) throw new Error('Stage keys must be lowercase letters, digits or underscores');
      if (new Set(keys).size !== keys.length) throw new Error('Stage keys must be unique');
      for (const s of stages) {
        if (!s.name.trim()) throw new Error(`Stage ${s.key || '?'} needs a name`);
        const t = s.targets;
        if (t.temperature_min_c !== null && t.temperature_max_c !== null && t.temperature_min_c >= t.temperature_max_c) throw new Error(`${s.name}: temperature min must be below max`);
        if (t.humidity_min_percent !== null && t.humidity_max_percent !== null && t.humidity_min_percent >= t.humidity_max_percent) throw new Error(`${s.name}: humidity min must be below max`);
        if (s.typical_duration_days && s.typical_duration_days.min > s.typical_duration_days.max) throw new Error(`${s.name}: typical duration min > max`);
      }
      const body = { ...meta, strain: meta.strain || null, cultivation_method: meta.cultivation_method || null, substrate_type: meta.substrate_type || null, source_notes: meta.source_notes || null, stages: stages.map((s) => ({ ...s, typical_duration_days: s.typical_duration_days && (s.typical_duration_days.max > 0 || s.typical_duration_days.min > 0) ? s.typical_duration_days : null })) };
      return profile ? endpoints.updateProfile(profile.id, body) : endpoints.createProfile({ ...body, source: 'user' });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.profiles });
      qc.invalidateQueries({ queryKey: ['batches'] });
      toast.success('Profile saved');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  const updStage = (i: number, patch: Partial<StageDefinition>) => setStages((st) => st.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const updTarget = (i: number, k: keyof StageDefinition['targets'], v: string) => setStages((st) => st.map((s, j) => (j === i ? { ...s, targets: { ...s.targets, [k]: v === '' ? (k.startsWith('fae') ? 0 : null) : Number(v) } } : s)));
  const move = (i: number, dir: -1 | 1) => setStages((st) => {
    const n = [...st];
    const j = i + dir;
    if (j < 0 || j >= n.length) return st;
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });
  return (
    <Modal open onClose={onClose} title={profile ? `Edit profile – ${profile.name}` : 'New species profile'} size="xl" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save profile</Button></>}>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Profile name" required htmlFor="p-name"><Input id="p-name" value={meta.name} onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))} /></Field>
          <Field label="Species" required htmlFor="p-species"><Input id="p-species" value={meta.species} onChange={(e) => setMeta((m) => ({ ...m, species: e.target.value }))} /></Field>
          <Field label="Strain" htmlFor="p-strain"><Input id="p-strain" value={meta.strain} onChange={(e) => setMeta((m) => ({ ...m, strain: e.target.value }))} /></Field>
          <Field label="Cultivation method" htmlFor="p-method"><Input id="p-method" value={meta.cultivation_method} onChange={(e) => setMeta((m) => ({ ...m, cultivation_method: e.target.value }))} /></Field>
          <Field label="Substrate type" htmlFor="p-substrate"><Input id="p-substrate" value={meta.substrate_type} onChange={(e) => setMeta((m) => ({ ...m, substrate_type: e.target.value }))} /></Field>
          <Field label="Source notes" hint="where these values come from" htmlFor="p-notes"><Input id="p-notes" value={meta.source_notes} onChange={(e) => setMeta((m) => ({ ...m, source_notes: e.target.value }))} /></Field>
        </div>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="label">Stages (in order)</p>
            <Button size="xs" variant="outline" icon={<Plus className="h-3 w-3" />} onClick={() => setStages((s) => [...s, { ...EMPTY_STAGE, key: `stage_${s.length + 1}`, name: `Stage ${s.length + 1}` }])}>Add stage</Button>
          </div>
          {stages.map((s, i) => (
            <div key={i} className="rounded-md border border-line bg-surface-2 p-3">
              <div className="grid gap-2 sm:grid-cols-4">
                <Field label="Key" htmlFor={`st-key-${i}`}><Input id={`st-key-${i}`} value={s.key} onChange={(e) => updStage(i, { key: e.target.value })} /></Field>
                <Field label="Name" htmlFor={`st-name-${i}`}><Input id={`st-name-${i}`} value={s.name} onChange={(e) => updStage(i, { name: e.target.value })} /></Field>
                <Field label="Typical days min–max" htmlFor={`st-dmin-${i}`}>
                  <div className="flex gap-1">
                    <Input id={`st-dmin-${i}`} type="number" min={0} value={s.typical_duration_days?.min ?? 0} onChange={(e) => updStage(i, { typical_duration_days: { min: Number(e.target.value), max: s.typical_duration_days?.max ?? 0 } })} />
                    <Input aria-label="Typical days max" type="number" min={0} value={s.typical_duration_days?.max ?? 0} onChange={(e) => updStage(i, { typical_duration_days: { min: s.typical_duration_days?.min ?? 0, max: Number(e.target.value) } })} />
                  </div>
                </Field>
                <div className="flex flex-wrap items-end gap-2 pb-1">
                  <Toggle checked={s.milestone} onChange={(v) => updStage(i, { milestone: v })} label="milestone" />
                  <Button size="xs" variant="ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</Button>
                  <Button size="xs" variant="ghost" onClick={() => move(i, 1)} disabled={i === stages.length - 1} aria-label="Move down">↓</Button>
                  <Button size="xs" variant="danger" onClick={() => setStages((st) => st.filter((_, j) => j !== i))} disabled={stages.length === 1}>Remove</Button>
                </div>
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-6">
                {([
                  ['temperature_min_c', 'T min °C'], ['temperature_max_c', 'T max °C'], ['humidity_min_percent', 'RH min %'], ['humidity_max_percent', 'RH max %'], ['fae_cycle_minutes', 'FAE cycle min'], ['fae_duration_minutes', 'FAE dur. min'],
                ] as [keyof StageDefinition['targets'], string][]).map(([k, label]) => (
                  <Field key={k} label={label} htmlFor={`st-${k}-${i}`}><Input id={`st-${k}-${i}`} type="number" step="0.5" value={s.targets[k] ?? ''} onChange={(e) => updTarget(i, k, e.target.value)} /></Field>
                ))}
              </div>
              <div className="mt-2 grid gap-2 sm:grid-cols-3">
                <Field label="Description" htmlFor={`st-desc-${i}`}><Input id={`st-desc-${i}`} value={s.description} onChange={(e) => updStage(i, { description: e.target.value })} /></Field>
                <Field label="Observable signs (comma separated)" htmlFor={`st-signs-${i}`}><Input id={`st-signs-${i}`} value={s.observable_signs.join(', ')} onChange={(e) => updStage(i, { observable_signs: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
                <Field label="Transition criteria" htmlFor={`st-trans-${i}`}><Input id={`st-trans-${i}`} value={s.transition_criteria} onChange={(e) => updStage(i, { transition_criteria: e.target.value })} /></Field>
              </div>
            </div>
          ))}
        </div>
        {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      </div>
    </Modal>
  );
}

function UsersPanel() {
  const { isAdmin, user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: qk.users, queryFn: endpoints.users, enabled: isAdmin });
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' });
  const [pw, setPw] = useState({ current: '', next: '' });
  const create = useMutation({
    mutationFn: () => endpoints.createUser(form),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.users });
      setForm({ username: '', password: '', role: 'viewer' });
      toast.success('User created');
    },
    onError: (e) => toast.error('Could not create user', errorMessage(e)),
  });
  const update = useMutation({
    mutationFn: (p: { id: number; body: { role?: string; is_active?: boolean } }) => endpoints.updateUser(p.id, p.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.users }),
    onError: (e) => toast.error('Update failed', errorMessage(e)),
  });
  const changePw = useMutation({
    mutationFn: () => endpoints.changePassword(pw.current, pw.next),
    onSuccess: () => {
      setPw({ current: '', next: '' });
      toast.success('Password changed');
    },
    onError: (e) => toast.error('Password change failed', errorMessage(e)),
  });
  if (!user) return <Notice tone="amber">Sign in to manage your account. Admins can also manage other users.</Notice>;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Change my password">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); changePw.mutate(); }}>
          <Field label="Current password" htmlFor="pw-cur"><Input id="pw-cur" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw((p) => ({ ...p, current: e.target.value }))} required /></Field>
          <Field label="New password" hint="at least 8 characters" htmlFor="pw-new"><Input id="pw-new" type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={(e) => setPw((p) => ({ ...p, next: e.target.value }))} required /></Field>
          <Button type="submit" variant="primary" loading={changePw.isPending} icon={<KeyRound className="h-3.5 w-3.5" />}>Change password</Button>
        </form>
      </Card>
      {isAdmin && (
        <Card title="Users" subtitle="roles: viewer (read), operator (control, batches, alerts), admin (settings, devices, users)">
          {users.isLoading ? <Loading /> : users.error ? <ErrorState error={users.error} /> : (
            <table className="table">
              <thead><tr><th>User</th><th>Role</th><th>Active</th><th>Created</th></tr></thead>
              <tbody>
                {users.data?.map((u) => (
                  <tr key={u.id}>
                    <td className="text-ink">{u.username}{u.id === user.id && <span className="text-ink-3"> (you)</span>}</td>
                    <td>
                      <Select aria-label={`Role for ${u.username}`} value={u.role} disabled={u.id === user.id} onChange={(e) => update.mutate({ id: u.id, body: { role: e.target.value } })} className="h-7 w-auto py-0 text-xs">
                        {['viewer', 'operator', 'admin'].map((r) => <option key={r} value={r}>{r}</option>)}
                      </Select>
                    </td>
                    <td><Toggle checked={u.is_active ?? true} disabled={u.id === user.id} onChange={(v) => update.mutate({ id: u.id, body: { is_active: v } })} /></td>
                    <td className="text-xs">{fmtDateTime(u.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form className="mt-4 grid gap-2 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
            <Field label="Username" htmlFor="u-name"><Input id="u-name" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} minLength={3} required /></Field>
            <Field label="Password" htmlFor="u-pass"><Input id="u-pass" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} minLength={8} required autoComplete="new-password" /></Field>
            <Field label="Role" htmlFor="u-role"><Select id="u-role" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>{['viewer', 'operator', 'admin'].map((r) => <option key={r} value={r}>{r}</option>)}</Select></Field>
            <div className="flex items-end"><Button type="submit" variant="primary" loading={create.isPending} icon={<Plus className="h-3.5 w-3.5" />}>Add user</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

function AIPanel() {
  const { isAdmin } = useAuth();
  const toast = useToast();
  const status = useQuery({ queryKey: qk.aiStatus, queryFn: endpoints.aiStatus });
  const [diag, setDiag] = useState<Record<string, unknown> | null>(null);
  const run = useMutation({
    mutationFn: endpoints.aiDiagnostics,
    onSuccess: (d) => {
      setDiag(d);
      status.refetch();
    },
    onError: (e) => toast.error('Diagnostics failed', errorMessage(e)),
  });
  const channels = useQuery({ queryKey: ['alerts', 'channels'], queryFn: endpoints.alertChannels });
  if (status.isLoading) return <Loading />;
  if (status.error) return <ErrorState error={status.error} />;
  const s = status.data!;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="AI provider" subtitle="configured only through the backend .env – the browser never receives the key">
        <KeyValue
          items={[
            { k: 'Configured', v: s.configured ? <Badge tone="brand">yes</Badge> : <Badge tone="amber">no – deterministic fallback only</Badge> },
            { k: 'Provider', v: `${s.vendor ?? s.provider}${s.endpoint_host ? ` (${s.endpoint_host})` : ''}` },
            { k: 'Model', v: <span className="font-mono">{s.model ?? '—'}</span> },
            { k: 'API key', v: s.key_present ? <span className="font-mono">{s.key_hint} (masked, server-side)</span> : 'not set' },
            { k: 'Rate limit', v: `${s.rate_limit_per_minute} requests / min` },
            { k: 'JSON mode', v: s.json_mode_enabled ? 'enabled' : 'disabled' },
            { k: 'Circuit breaker', v: s.circuit_open ? <Badge tone="amber">open – retry in {s.circuit_retry_in_seconds}s</Badge> : <Badge tone="brand">closed</Badge> },
            { k: 'Last success', v: s.last_success_at ? fmtDateTime(s.last_success_at) : 'never' },
            { k: 'Last error', v: s.last_error ?? '—' },
            { k: 'Usage', v: `${s.usage.requests} req · ${s.usage.failures} failed · ${s.usage.prompt_tokens} prompt + ${s.usage.completion_tokens} completion tokens` },
            { k: 'Fallback', v: s.fallback },
          ]}
        />
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="outline" icon={<Stethoscope className="h-3.5 w-3.5" />} loading={run.isPending} onClick={() => run.mutate()} disabled={!isAdmin} title={isAdmin ? 'Sends a minimal test prompt to the provider' : 'Admin only'}>
            Test provider connection
          </Button>
          {!isAdmin && <span className="text-[11px] text-ink-3">admin only</span>}
        </div>
        {diag && <pre className="mt-2 max-h-56 overflow-auto rounded bg-surface-2 p-2 font-mono text-[11px] text-ink-2">{JSON.stringify(diag, null, 2)}</pre>}
        <Notice tone="neutral" className="mt-3">
          Environment variables: <code>AI_API_KEY</code>, <code>AI_BASE_URL</code>, <code>AI_MODEL</code>, <code>AI_TIMEOUT_SECONDS</code>, <code>AI_MAX_RETRIES</code>, <code>AI_RATE_LIMIT_PER_MINUTE</code>. Rotate the key if it was ever shared in chat or committed.
        </Notice>
      </Card>
      <Card title="Notification channels" subtitle="external channels use separate backend credentials">
        {channels.isLoading ? <Loading /> : channels.error ? <ErrorState error={channels.error} /> : (
          <KeyValue items={(channels.data ?? []).map((c) => ({ k: titleCase(c.name), v: <span>{c.enabled ? <Badge tone="brand">enabled</Badge> : <Badge>disabled</Badge>} <span className="text-ink-3">{c.detail}</span></span> }))} />
        )}
        <p className="mt-3 text-[11px] text-ink-3">In-app notifications (bell + banners) are always active. Configure <code>NOTIFY_WEBHOOK_URL</code> or SMTP settings in the backend .env to forward alerts at or above the configured severity.</p>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const settings = useQuery({ queryKey: qk.settings, queryFn: endpoints.settings });
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<'validation' | 'alerts' | 'control_defaults' | 'profiles' | 'ai' | 'users' | 'runtime'>('alerts');
  const sections = settings.data?.sections ?? {};
  const defaults = settings.data?.defaults ?? {};

  return (
    <div className="space-y-4">
      <SectionTitle title="System Settings" description="Alert thresholds, controller defaults, which readings count as plausible, species profiles, the AI connection and user accounts. Changes take effect immediately on the server." />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { value: 'alerts', label: 'Alerts' },
            { value: 'control_defaults', label: 'Control defaults' },
            { value: 'validation', label: 'Validation' },
            { value: 'profiles', label: 'Species profiles' },
            { value: 'ai', label: 'AI & notifications' },
            { value: 'users', label: 'Account & users' },
            { value: 'runtime', label: 'Runtime' },
          ]}
        />
        <div className="flex flex-wrap items-center gap-3 text-xs text-ink-3">
          <span className="flex items-center gap-2">
            View <ViewModeSwitch />
          </span>
          <span className="flex items-center gap-2">
            Theme
            <Tabs value={theme} onChange={(t) => setTheme(t)} items={[{ value: 'dark' as const, label: 'Dark' }, { value: 'light' as const, label: 'Light' }]} />
          </span>
        </div>
      </div>

      {['alerts', 'control_defaults', 'validation'].includes(tab) && (
        <Card title={SECTION_META[tab]?.label} subtitle={SECTION_META[tab]?.description}>
          {settings.isLoading ? <Loading /> : settings.error ? <ErrorState error={settings.error} onRetry={() => settings.refetch()} /> : sections[tab] ? (
            <SettingsSection section={tab} values={sections[tab]} defaults={defaults[tab] ?? {}} onSaved={() => { qc.invalidateQueries({ queryKey: qk.settings }); qc.invalidateQueries({ queryKey: ['control'] }); qc.invalidateQueries({ queryKey: ['alerts'] }); }} />
          ) : <EmptyState title="Section not available" />}
        </Card>
      )}
      {tab === 'profiles' && <ProfilesPanel />}
      {tab === 'ai' && <AIPanel />}
      {tab === 'users' && <UsersPanel />}
      {tab === 'runtime' && (
        <Card title="Runtime configuration" subtitle="read-only values from the backend environment">
          {settings.isLoading ? <Loading /> : settings.error ? <ErrorState error={settings.error} /> : (
            <KeyValue items={Object.entries(settings.data?.runtime ?? {}).map(([k, v]) => ({ k: titleCase(k), v: typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v) }))} />
          )}
          <Notice tone="neutral" className="mt-3">
            Secrets (JWT secret, AI key, MQTT password, device tokens) are never returned by the API. See <code>backend/.env.example</code> for all variables.
          </Notice>
        </Card>
      )}
    </div>
  );
}
