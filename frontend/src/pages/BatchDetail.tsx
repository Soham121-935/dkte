import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Camera, FileText, GitBranch, ImagePlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { qk } from '@/lib/queries';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, KeyValue, Loading, Modal, Notice, Select, Textarea, errorMessage, statusTone } from '@/components/ui';
import { SectionTitle, SourceTag } from '@/components/domain';
import { BatchForm } from '@/components/BatchForm';
import { MetricChart, toChartRows } from '@/components/charts';
import { fmtDateTime, fmtDays, titleCase } from '@/lib/format';
import { fromLocalInput, toIsoLocalInput } from '@/lib/utils';
import type { Observation, Targets } from '@/api/types';

const OBS_KINDS = ['note', 'stage_confirmation', 'contamination', 'harvest', 'measurement', 'photo'];

function TargetsTable({ targets, overrides, stages }: { targets: Targets | null | undefined; overrides: Record<string, Partial<Targets>>; stages: { key: string; name: string; targets: Targets }[] }) {
  if (!stages.length && !targets) return <p className="text-xs text-ink-3">No profile – generic default targets apply.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>Temp °C</th>
            <th>RH %</th>
            <th>FAE</th>
            <th>Source</th>
          </tr>
        </thead>
        <tbody>
          {stages.map((s) => {
            const o = overrides[s.key];
            const t = { ...s.targets, ...(o ?? {}) };
            return (
              <tr key={s.key} className={targets?.stage_key === s.key ? 'bg-brand/5' : undefined}>
                <td className="text-ink">{s.name}{targets?.stage_key === s.key && <Badge tone="brand" className="ml-1">current</Badge>}</td>
                <td className="font-mono">{t.temperature_min_c ?? '—'}–{t.temperature_max_c ?? '—'}</td>
                <td className="font-mono">{t.humidity_min_percent ?? '—'}–{t.humidity_max_percent ?? '—'}</td>
                <td className="font-mono">{t.fae_cycle_minutes ? `${t.fae_duration_minutes}/${t.fae_cycle_minutes} min` : 'off'}</td>
                <td>{o ? <SourceTag kind="user" /> : <SourceTag source={targets?.source === 'profile_user' ? 'profile_user' : 'profile_reference'} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function BatchDetail() {
  const { id } = useParams();
  const batchId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { canOperate, openLogin, user } = useAuth();
  const batch = useQuery({ queryKey: qk.batch(batchId), queryFn: () => endpoints.batch(batchId), enabled: Number.isFinite(batchId) });
  const readings = useQuery({ queryKey: ['batches', batchId, 'readings'], queryFn: () => endpoints.batchReadings(batchId, 300), enabled: Number.isFinite(batchId) });
  const [editOpen, setEditOpen] = useState(false);
  const [obsOpen, setObsOpen] = useState(false);
  const [stageOpen, setStageOpen] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteObs, setDeleteObs] = useState<Observation | null>(null);
  const [reportOpen, setReportOpen] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['batches'] });
    qc.invalidateQueries({ queryKey: ['predictions'] });
    qc.invalidateQueries({ queryKey: ['analytics'] });
  };
  const guard = (fn: () => void) => {
    if (!canOperate) {
      toast.warning('Sign in as operator to edit batches');
      openLogin();
      return;
    }
    fn();
  };

  const del = useMutation({
    mutationFn: () => endpoints.deleteBatch(batchId),
    onSuccess: () => {
      invalidate();
      toast.success('Batch deleted');
      navigate('/batches');
    },
    onError: (e) => toast.error('Delete failed', errorMessage(e)),
  });
  const delObs = useMutation({
    mutationFn: (obs: Observation) => endpoints.deleteObservation(batchId, obs.id),
    onSuccess: () => {
      invalidate();
      setDeleteObs(null);
    },
    onError: (e) => toast.error('Delete failed', errorMessage(e)),
  });

  const rows = useMemo(() => (readings.data ? toChartRows(readings.data.points, readings.data.bucket_seconds) : []), [readings.data]);

  if (batch.isLoading) return <Loading label="Loading batch…" />;
  if (batch.error) return <ErrorState error={batch.error} onRetry={() => batch.refetch()} />;
  const b = batch.data!;
  const stages = b.profile?.stages ?? [];
  const currentStageDef = stages.find((s) => s.key === b.current_stage_key);
  const lastStageEvent = b.stage_events?.length ? b.stage_events[b.stage_events.length - 1] : null;
  const observations = [...(b.observations ?? [])].sort((x, y) => (x.observed_at < y.observed_at ? 1 : -1));
  const images = observations.filter((o) => o.image_url);

  return (
    <div className="space-y-4">
      <Link to="/batches" className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
        <ArrowLeft className="h-3 w-3" /> All batches
      </Link>
      <SectionTitle
        title={`${b.code} · ${b.name}`}
        description={
          <span className="inline-flex flex-wrap items-center gap-1.5">
            <em>{b.species}</em>
            {b.strain && <span>· {b.strain}</span>}
            <Badge tone={statusTone(b.status)}>{b.status}</Badge>
            {b.is_demo && <Badge tone="amber">demo batch</Badge>}
          </span>
        }
        actions={
          <>
            <Link to={`/timeline/${b.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong px-2.5 text-xs text-ink hover:bg-surface-2">
              <GitBranch className="h-3.5 w-3.5" /> Timeline
            </Link>
            <Button size="sm" variant="outline" icon={<FileText className="h-3.5 w-3.5" />} onClick={() => setReportOpen(true)}>
              Report
            </Button>
            <Button size="sm" variant="outline" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => guard(() => setEditOpen(true))}>
              Edit
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => guard(() => setDeleteOpen(true))}>
              Delete
            </Button>
          </>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Batch record" subtitle="user-entered">
          <KeyValue
            items={[
              { k: 'Substrate', v: b.substrate_type ?? '—' },
              { k: 'Substrate details', v: b.substrate_details ?? '—' },
              { k: 'Spawn', v: b.spawn_details ?? '—' },
              { k: 'Inoculated', v: fmtDateTime(b.inoculation_date) },
              { k: 'Started', v: fmtDateTime(b.started_at) },
              { k: 'Device', v: b.device_id ? <Link className="font-mono text-brand hover:underline" to="/monitoring">{b.device_id}</Link> : 'not linked' },
              { k: 'Profile', v: b.profile ? <span className="inline-flex items-center gap-1">{b.profile.name} <SourceTag source={b.profile.source} compact /></span> : 'generic defaults' },
              { k: 'Expected harvest', v: b.expected_harvest_start ? `${fmtDateTime(b.expected_harvest_start, 'dd MMM')} – ${fmtDateTime(b.expected_harvest_end, 'dd MMM yyyy')} (user-entered)` : 'not set' },
              { k: 'Notes', v: b.notes ?? '—' },
            ]}
          />
        </Card>

        <Card
          title="Current stage"
          subtitle="confirmed by grower"
          actions={
            <Button size="sm" variant="primary" onClick={() => guard(() => setStageOpen(true))} disabled={!stages.length}>
              Confirm stage change
            </Button>
          }
        >
          {!stages.length ? (
            <p className="text-xs text-ink-3">Assign a species profile to track stages.</p>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-base font-semibold text-ink">{b.current_stage_name ?? titleCase(b.current_stage_key)}</p>
                {lastStageEvent && (
                  <p className="text-xs text-ink-3">
                    since {fmtDateTime(lastStageEvent.started_at)} · day {fmtDays((Date.now() - new Date(lastStageEvent.started_at).getTime()) / 86400000)} · {lastStageEvent.source === 'manual' ? `confirmed by ${lastStageEvent.confirmed_by ?? 'user'}` : lastStageEvent.source}
                  </p>
                )}
              </div>
              {currentStageDef && (
                <>
                  <p className="text-xs text-ink-2">{currentStageDef.description}</p>
                  {currentStageDef.typical_duration_days && (
                    <p className="text-xs text-ink-3">
                      Typical duration {currentStageDef.typical_duration_days.min}–{currentStageDef.typical_duration_days.max} days <SourceTag kind="reference" compact /> – strain, substrate and conditions change this.
                    </p>
                  )}
                  {currentStageDef.observable_signs.length > 0 && (
                    <div className="text-xs">
                      <p className="label mb-1">What to look for</p>
                      <ul className="list-disc space-y-0.5 pl-4 text-ink-2">
                        {currentStageDef.observable_signs.map((s) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <p className="text-xs text-ink-3">
                    <span className="font-medium text-ink-2">Next stage when:</span> {currentStageDef.transition_criteria || 'grower confirmation'}
                  </p>
                </>
              )}
            </div>
          )}
        </Card>

        <Card title="Stage targets" subtitle="profile values with your overrides" actions={<Button size="sm" variant="outline" onClick={() => guard(() => setOverrideOpen(true))} disabled={!stages.length}>Override</Button>}>
          <TargetsTable targets={b.effective_targets} overrides={b.target_overrides ?? {}} stages={stages} />
          {b.profile?.source === 'reference' && <p className="mt-2 text-[11px] text-ink-3">Reference ranges from general literature – not validated for your strain or chamber. Override per stage once you know what works.</p>}
        </Card>
      </div>

      <Card title="Environment during this batch" subtitle={readings.data ? `${readings.data.n_readings} readings from ${b.device_id ?? 'no device'} · ${readings.data.sources.join(', ')}` : undefined}>
        {!b.device_id ? (
          <p className="text-xs text-ink-3">No device linked – no environmental data.</p>
        ) : readings.isLoading ? (
          <Loading />
        ) : readings.error ? (
          <ErrorState error={readings.error} onRetry={() => readings.refetch()} />
        ) : !rows.length ? (
          <EmptyState title="No readings since the batch started" className="py-4" />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            <MetricChart rows={rows} metric="temperature_c" targets={b.effective_targets} height={200} />
            <MetricChart rows={rows} metric="relative_humidity_percent" targets={b.effective_targets} height={200} />
          </div>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={`Observations (${observations.length})`}
          subtitle="grower notes, stage confirmations, contamination, harvests"
          actions={
            <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => guard(() => setObsOpen(true))}>
              Add observation
            </Button>
          }
          padded={false}
        >
          {!observations.length ? (
            <EmptyState title="No observations yet" description="Record what you see – pins, colonisation, contamination – with optional photos." className="py-6" />
          ) : (
            <ul className="divide-y divide-line">
              {observations.map((o) => (
                <li key={o.id} className="flex gap-3 px-4 py-3">
                  {o.image_url ? (
                    <a href={o.image_url} target="_blank" rel="noreferrer" className="shrink-0">
                      <img src={o.image_url} alt={o.note || o.kind} className="h-16 w-16 rounded border border-line object-cover" loading="lazy" />
                    </a>
                  ) : (
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded border border-dashed border-line text-ink-3">
                      <Camera className="h-4 w-4" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={o.kind === 'contamination' ? 'danger' : o.kind === 'harvest' ? 'brand' : o.kind === 'stage_confirmation' ? 'teal' : 'neutral'}>{titleCase(o.kind)}</Badge>
                      {o.stage_key && <Badge>{stages.find((s) => s.key === o.stage_key)?.name ?? o.stage_key}</Badge>}
                      <SourceTag kind="observed" compact />
                      <span className="text-[11px] text-ink-3">
                        {fmtDateTime(o.observed_at)} · {o.recorded_by ?? 'unknown'}
                      </span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-ink-2">{o.note}</p>
                    {o.data && Object.keys(o.data).length > 0 && <pre className="mt-1 rounded bg-surface-2 p-1.5 font-mono text-[10px] text-ink-3">{JSON.stringify(o.data)}</pre>}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <ImageUploadButton batchId={b.id} observation={o} onDone={invalidate} disabled={!canOperate} />
                    <Button size="xs" variant="ghost" aria-label="Delete observation" onClick={() => guard(() => setDeleteObs(o))}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`Images (${images.length})`}>
          {!images.length ? (
            <p className="text-xs text-ink-3">Attach photos to observations to build a visual record.</p>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              {images.map((o) => (
                <a key={o.id} href={o.image_url!} target="_blank" rel="noreferrer" title={`${fmtDateTime(o.observed_at)} – ${o.note}`}>
                  <img src={o.image_url!} alt={o.note || o.kind} className="aspect-square w-full rounded border border-line object-cover" loading="lazy" />
                </a>
              ))}
            </div>
          )}
        </Card>
      </div>

      <BatchForm open={editOpen} onClose={() => setEditOpen(false)} batch={b} onSaved={() => invalidate()} />
      <ObservationDialog open={obsOpen} onClose={() => setObsOpen(false)} batchId={b.id} stages={stages} currentStage={b.current_stage_key} onSaved={invalidate} author={user?.username} />
      <StageDialog open={stageOpen} onClose={() => setStageOpen(false)} batchId={b.id} stages={stages} currentStage={b.current_stage_key} onSaved={invalidate} />
      <OverrideDialog open={overrideOpen} onClose={() => setOverrideOpen(false)} batchId={b.id} stages={stages} overrides={b.target_overrides ?? {}} onSaved={invalidate} />
      <ReportDialog open={reportOpen} onClose={() => setReportOpen(false)} batchId={b.id} code={b.code} />
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={() => del.mutate()} loading={del.isPending} danger title="Delete batch" confirmLabel="Delete" message={<>Delete <strong>{b.code}</strong> with all its observations and stage history? Sensor readings are kept.</>} />
      <ConfirmDialog open={!!deleteObs} onClose={() => setDeleteObs(null)} onConfirm={() => deleteObs && delObs.mutate(deleteObs)} loading={delObs.isPending} danger title="Delete observation" confirmLabel="Delete" message="Remove this observation and its image?" />
    </div>
  );
}

function ImageUploadButton({ batchId, observation, onDone, disabled }: { batchId: number; observation: Observation; onDone: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const upload = useMutation({
    mutationFn: (file: File) => endpoints.uploadObservationImage(batchId, observation.id, file),
    onSuccess: () => {
      toast.success('Image attached');
      onDone();
    },
    onError: (e) => toast.error('Upload failed', errorMessage(e)),
  });
  return (
    <>
      <input
        ref={ref}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            if (f.size > 8 * 1024 * 1024) {
              toast.error('Image too large', 'Maximum size is 8 MB');
            } else upload.mutate(f);
          }
          e.target.value = '';
        }}
      />
      <Button size="xs" variant="ghost" aria-label="Attach image" title={disabled ? 'Sign in to attach images' : 'Attach image'} disabled={disabled} loading={upload.isPending} onClick={() => ref.current?.click()}>
        <ImagePlus className="h-3 w-3" />
      </Button>
    </>
  );
}

function ObservationDialog({ open, onClose, batchId, stages, currentStage, onSaved, author }: { open: boolean; onClose: () => void; batchId: number; stages: { key: string; name: string }[]; currentStage: string | null; onSaved: () => void; author?: string }) {
  const toast = useToast();
  const [kind, setKind] = useState('note');
  const [note, setNote] = useState('');
  const [stageKey, setStageKey] = useState(currentStage ?? '');
  const [observedAt, setObservedAt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async () => {
      const obs = await endpoints.createObservation(batchId, { kind, note: note.trim(), stage_key: stageKey || null, observed_at: fromLocalInput(observedAt), data: null });
      if (file) await endpoints.uploadObservationImage(batchId, obs.id, file);
      return obs;
    },
    onSuccess: () => {
      toast.success('Observation recorded');
      onSaved();
      onClose();
      setNote('');
      setFile(null);
      setObservedAt('');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add observation"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => {
              if (!note.trim()) return setError('Please describe what you observed');
              setError(null);
              save.mutate();
            }}
          >
            Save observation
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" htmlFor="o-kind">
          <Select id="o-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
            {OBS_KINDS.map((k) => (
              <option key={k} value={k}>
                {titleCase(k)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Stage" htmlFor="o-stage">
          <Select id="o-stage" value={stageKey} onChange={(e) => setStageKey(e.target.value)}>
            <option value="">—</option>
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Observed at" hint="leave empty for now" htmlFor="o-at">
          <Input id="o-at" type="datetime-local" value={observedAt} onChange={(e) => setObservedAt(e.target.value)} max={toIsoLocalInput(new Date().toISOString())} />
        </Field>
        <Field label="Photo (optional, ≤ 8 MB)" htmlFor="o-file">
          <Input id="o-file" type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} className="py-1 text-xs" />
        </Field>
        <Field label="What did you observe?" required htmlFor="o-note" className="sm:col-span-2" error={error}>
          <Textarea id="o-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. first pin clusters at the lower side holes, no discolouration" />
        </Field>
        <p className="text-[11px] text-ink-3 sm:col-span-2">Recorded as user-observed{author ? ` by ${author}` : ''}. Observations are the ground truth the stage estimate is compared against.</p>
      </div>
    </Modal>
  );
}

function StageDialog({ open, onClose, batchId, stages, currentStage, onSaved }: { open: boolean; onClose: () => void; batchId: number; stages: { key: string; name: string; transition_criteria: string; observable_signs: string[] }[]; currentStage: string | null; onSaved: () => void }) {
  const toast = useToast();
  const currentIndex = stages.findIndex((s) => s.key === currentStage);
  const nextStage = stages[currentIndex + 1];
  const [stageKey, setStageKey] = useState(nextStage?.key ?? '');
  const [startedAt, setStartedAt] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const target = stages.find((s) => s.key === stageKey) ?? nextStage;
  const save = useMutation({
    mutationFn: () => endpoints.confirmStage(batchId, { stage_key: stageKey || nextStage?.key, started_at: fromLocalInput(startedAt) ?? undefined, note: note.trim() || undefined }),
    onSuccess: () => {
      toast.success('Stage confirmed');
      onSaved();
      onClose();
      setNote('');
    },
    onError: (e) => setError(errorMessage(e)),
  });
  if (!nextStage && !stageKey) {
    return (
      <Modal open={open} onClose={onClose} title="Confirm stage" size="sm">
        <p className="text-sm text-ink-2">This batch is at the last stage of its profile.</p>
      </Modal>
    );
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm stage change"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Confirm {target?.name}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice tone="info">Stage changes are recorded as grower confirmations – the system only suggests when a transition is typical, it never advances a stage automatically.</Notice>
        <Field label="New stage" htmlFor="s-key">
          <Select id="s-key" value={stageKey || nextStage?.key} onChange={(e) => setStageKey(e.target.value)}>
            {stages.map((s, i) => (
              <option key={s.key} value={s.key} disabled={i <= currentIndex}>
                {s.name}
                {i <= currentIndex ? ' (already passed)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {target && (
          <div className="rounded-md border border-line bg-surface-2 p-2.5 text-xs text-ink-2">
            <p className="font-medium text-ink">Transition criteria</p>
            <p>{target.transition_criteria || 'grower judgement'}</p>
            {target.observable_signs.length > 0 && <p className="mt-1 text-ink-3">Signs: {target.observable_signs.join(' · ')}</p>}
          </div>
        )}
        <Field label="When did it start?" hint="leave empty for now; cannot be before the previous stage" htmlFor="s-at">
          <Input id="s-at" type="datetime-local" value={startedAt} onChange={(e) => setStartedAt(e.target.value)} max={toIsoLocalInput(new Date().toISOString())} />
        </Field>
        <Field label="Note" htmlFor="s-note" error={error}>
          <Textarea id="s-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="what you saw that confirms the transition" />
        </Field>
      </div>
    </Modal>
  );
}

function OverrideDialog({ open, onClose, batchId, stages, overrides, onSaved }: { open: boolean; onClose: () => void; batchId: number; stages: { key: string; name: string; targets: Targets }[]; overrides: Record<string, Partial<Targets>>; onSaved: () => void }) {
  const toast = useToast();
  const [stageKey, setStageKey] = useState(stages[0]?.key ?? '');
  const base = stages.find((s) => s.key === stageKey);
  const existing = overrides[stageKey] ?? {};
  const [vals, setVals] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const fields: { key: keyof Targets; label: string }[] = [
    { key: 'temperature_min_c', label: 'Temp min °C' },
    { key: 'temperature_max_c', label: 'Temp max °C' },
    { key: 'humidity_min_percent', label: 'RH min %' },
    { key: 'humidity_max_percent', label: 'RH max %' },
    { key: 'fae_cycle_minutes', label: 'FAE cycle (min)' },
    { key: 'fae_duration_minutes', label: 'FAE duration (min)' },
    { key: 'moisture_min_raw', label: 'Moisture min (raw)' },
  ];
  const valueOf = (k: keyof Targets) => (vals[k] !== undefined ? vals[k] : existing[k] !== undefined && existing[k] !== null ? String(existing[k]) : '');
  const save = useMutation({
    mutationFn: (clear: boolean) => {
      const next: Record<string, Partial<Targets>> = { ...overrides };
      if (clear) {
        delete next[stageKey];
      } else {
        const o: Record<string, number> = {};
        fields.forEach((f) => {
          const v = valueOf(f.key);
          if (v !== '') o[f.key] = Number(v);
        });
        const tmin = o.temperature_min_c, tmax = o.temperature_max_c, hmin = o.humidity_min_percent, hmax = o.humidity_max_percent;
        if (tmin !== undefined && tmax !== undefined && tmin >= tmax) throw new Error('Temperature min must be lower than max');
        if (hmin !== undefined && hmax !== undefined && hmin >= hmax) throw new Error('Humidity min must be lower than max');
        next[stageKey] = o;
      }
      return endpoints.updateBatch(batchId, { target_overrides: next });
    },
    onSuccess: () => {
      toast.success('Targets updated');
      onSaved();
      onClose();
      setVals({});
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Override stage targets for this batch"
      footer={
        <>
          <Button variant="ghost" onClick={() => save.mutate(true)} disabled={!overrides[stageKey]}>
            Clear override
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(false)}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Stage" htmlFor="ov-stage">
          <Select id="ov-stage" value={stageKey} onChange={(e) => { setStageKey(e.target.value); setVals({}); }}>
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          {fields.map((f) => (
            <Field key={f.key} label={f.label} hint={base ? `profile: ${base.targets[f.key] ?? '—'}` : undefined} htmlFor={`ov-${f.key}`}>
              <Input id={`ov-${f.key}`} type="number" step="0.5" value={valueOf(f.key)} onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} placeholder="use profile" />
            </Field>
          ))}
        </div>
        {error && <p className="text-xs text-danger">{error}</p>}
        <p className="text-[11px] text-ink-3">Overrides are labelled as user-entered and take precedence over the profile for control and analytics.</p>
      </div>
    </Modal>
  );
}

function ReportDialog({ open, onClose, batchId, code }: { open: boolean; onClose: () => void; batchId: number; code: string }) {
  const report = useQuery({ queryKey: ['batches', batchId, 'report'], queryFn: () => endpoints.batchReport(batchId), enabled: open });
  const download = () => {
    if (!report.data) return;
    const blob = new Blob([JSON.stringify(report.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `myco-batch-${code}-report.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const r = report.data;
  return (
    <Modal open={open} onClose={onClose} title={`Batch report – ${code}`} size="lg" footer={<Button variant="primary" onClick={download} disabled={!r}>Download JSON</Button>}>
      {report.isLoading ? (
        <Loading />
      ) : report.error ? (
        <ErrorState error={report.error} />
      ) : r ? (
        <div className="space-y-4 text-xs">
          <p className="text-ink-3">
            Generated {fmtDateTime(r.generated_at)} · period {fmtDateTime(r.period.start)} – {fmtDateTime(r.period.end)}
          </p>
          {r.sensor_summary && (
            <div>
              <p className="label mb-1">Environment summary ({r.sensor_summary.n_readings} readings · {r.sensor_summary.sources.join(', ')})</p>
              <KeyValue
                items={[
                  { k: 'Temperature', v: `${r.sensor_summary.temperature_c.min ?? '—'} – ${r.sensor_summary.temperature_c.max ?? '—'} °C (mean ${r.sensor_summary.temperature_c.mean ?? '—'})` },
                  { k: 'Humidity', v: `${r.sensor_summary.relative_humidity_percent.min ?? '—'} – ${r.sensor_summary.relative_humidity_percent.max ?? '—'} % (mean ${r.sensor_summary.relative_humidity_percent.mean ?? '—'})` },
                  { k: 'Data completeness', v: r.sensor_summary.data_completeness !== null ? `${Math.round(r.sensor_summary.data_completeness * 100)}%` : '—' },
                  { k: 'Invalid readings', v: r.sensor_summary.invalid_readings },
                ]}
              />
            </div>
          )}
          <div>
            <p className="label mb-1">Stages</p>
            <table className="table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Mean T</th>
                  <th>Mean RH</th>
                </tr>
              </thead>
              <tbody>
                {r.stage_environment.stages.map((s) => (
                  <tr key={s.stage_key}>
                    <td>{s.stage_name}</td>
                    <td className="font-mono">{fmtDateTime(s.started_at, 'dd MMM')}</td>
                    <td>{fmtDays(s.duration_days)}</td>
                    <td className="font-mono">{s.temperature_c?.mean ?? '—'}</td>
                    <td className="font-mono">{s.relative_humidity_percent?.mean ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-1 text-[11px] text-ink-3">{r.stage_environment.note}</p>
          </div>
          <div>
            <p className="label mb-1">Alerts ({r.alerts.length})</p>
            {r.alerts.length ? (
              <ul className="space-y-0.5">
                {r.alerts.slice(0, 15).map((a, i) => (
                  <li key={i}>
                    <span className="font-mono text-ink-3">{fmtDateTime(a.opened_at, 'dd MMM HH:mm')}</span> <Badge tone={a.severity === 'critical' ? 'danger' : 'amber'}>{a.severity}</Badge> {a.title}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-ink-3">none</p>
            )}
          </div>
          <div>
            <p className="label mb-1">Observations ({r.observations.length})</p>
            <ul className="space-y-0.5">
              {r.observations.map((o, i) => (
                <li key={i}>
                  <span className="font-mono text-ink-3">{fmtDateTime(o.observed_at, 'dd MMM HH:mm')}</span> · {titleCase(o.kind)} · {o.note}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
