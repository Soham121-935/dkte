import { useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Circle, CircleDot, Flag, Package } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { qk, useBatches } from '@/lib/queries';
import { Badge, Card, EmptyState, ErrorState, KeyValue, Loading, Notice, Select } from '@/components/ui';
import { ConfidenceTag, SectionTitle, SourceTag } from '@/components/domain';
import { fmtDateTime, fmtDays, fmtPercent, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { TimelineStage } from '@/api/types';

function stageIcon(state: string) {
  if (state === 'completed') return <Check className="h-3.5 w-3.5" />;
  if (state === 'current') return <CircleDot className="h-3.5 w-3.5" />;
  if (state === 'skipped') return <Circle className="h-3.5 w-3.5 opacity-50" />;
  return <Circle className="h-3.5 w-3.5" />;
}

function StageRow({ s, isLast }: { s: TimelineStage; isLast: boolean }) {
  const typical = s.typical_duration_days;
  const withinTypical = s.actual_duration_days !== null && typical ? (s.actual_duration_days >= typical.min && s.actual_duration_days <= typical.max ? 'within' : s.actual_duration_days < typical.min ? 'shorter' : 'longer') : null;
  return (
    <li className="relative flex gap-3">
      <div className="flex flex-col items-center">
        <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border', s.state === 'completed' ? 'border-brand bg-brand text-canvas' : s.state === 'current' ? 'border-brand bg-surface text-brand' : 'border-line-strong bg-surface text-ink-3')}>{stageIcon(s.state)}</span>
        {!isLast && <span className={cn('w-px flex-1', s.state === 'completed' ? 'bg-brand/60' : 'bg-line')} />}
      </div>
      <div className={cn('mb-5 min-w-0 flex-1 rounded-md border p-3', s.state === 'current' ? 'border-brand/50 bg-brand/5' : 'border-line bg-surface')}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className={cn('text-sm font-semibold', s.state === 'upcoming' ? 'text-ink-2' : 'text-ink')}>{s.name}</h3>
          {s.milestone && <Badge tone="teal"><Flag className="h-3 w-3" /> milestone</Badge>}
          <Badge tone={s.state === 'current' ? 'brand' : s.state === 'completed' ? 'neutral' : 'muted'}>{s.state}</Badge>
          {s.state !== 'upcoming' && s.events[0] && <SourceTag kind={s.events[0].source === 'manual' ? 'observed' : 'reference'} />}
        </div>
        <p className="mt-1 text-xs text-ink-3">{s.description}</p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
          <div>
            <dt className="text-ink-3">Started</dt>
            <dd className="text-ink-2">{s.started_at ? fmtDateTime(s.started_at, 'dd MMM HH:mm') : s.state === 'upcoming' ? 'not yet' : '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-3">{s.state === 'current' ? 'Elapsed' : 'Actual duration'}</dt>
            <dd className="text-ink-2">
              {fmtDays(s.actual_duration_days)}
              {withinTypical && s.state === 'completed' && <span className={cn('ml-1', withinTypical === 'within' ? 'text-brand' : 'text-amber')}>({withinTypical} than typical)</span>}
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">Typical duration</dt>
            <dd className="text-ink-2">
              {typical ? `${typical.min}–${typical.max} d` : '—'} <SourceTag kind="reference" compact />
            </dd>
          </div>
          <div>
            <dt className="text-ink-3">Confirmed by</dt>
            <dd className="text-ink-2">{s.events[0]?.confirmed_by ?? (s.state === 'upcoming' ? 'pending' : '—')}</dd>
          </div>
        </dl>
        {s.observable_signs.length > 0 && (
          <p className="mt-2 text-xs text-ink-3">
            <span className="text-ink-2">Observable signs:</span> {s.observable_signs.join(' · ')}
          </p>
        )}
        <p className="mt-1 text-xs text-ink-3">
          <span className="text-ink-2">Transition:</span> {s.transition_criteria || 'grower confirmation'}
        </p>
        {s.observations.length > 0 && (
          <div className="mt-2 border-t border-line pt-2">
            <p className="label mb-1">Observations in this stage ({s.observations.length})</p>
            <ul className="space-y-1">
              {s.observations.slice(0, 4).map((o) => (
                <li key={o.id} className="flex items-start gap-2 text-xs">
                  {o.image_url && <img src={o.image_url} alt="" className="h-8 w-8 rounded border border-line object-cover" />}
                  <span className="text-ink-3">{fmtDateTime(o.observed_at, 'dd MMM HH:mm')}</span>
                  <span className="text-ink-2">
                    <Badge className="mr-1">{titleCase(o.kind)}</Badge>
                    {o.note}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}

export default function GrowthTimeline() {
  const { id } = useParams();
  const navigate = useNavigate();
  const batches = useBatches();
  const list = useMemo(() => batches.data ?? [], [batches.data]);
  const selectedId = id ? Number(id) : list.find((b) => b.status === 'active')?.id ?? list[0]?.id;

  useEffect(() => {
    if (!id && selectedId) navigate(`/timeline/${selectedId}`, { replace: true });
  }, [id, selectedId, navigate]);

  const timeline = useQuery({ queryKey: qk.timeline(selectedId ?? 0), queryFn: () => endpoints.timeline(selectedId!), enabled: !!selectedId, refetchInterval: 60000 });

  if (batches.isLoading) return <Loading label="Loading batches…" />;
  if (batches.error) return <ErrorState error={batches.error} onRetry={() => batches.refetch()} />;
  if (!list.length) return <EmptyState icon={<Package className="h-6 w-6" />} title="No batches" description="Create a batch to see its growth timeline." action={<Link to="/batches" className="text-xs text-brand hover:underline">Go to batches →</Link>} />;

  const t = timeline.data;
  const est = t?.estimate;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Growth Timeline"
        description="Which stage each batch is in and what usually comes next. You confirm stage changes from what you see – the dates shown are typical timings for the species, not measurements."
        actions={
          <Select aria-label="Select batch" value={selectedId ?? ''} onChange={(e) => navigate(`/timeline/${e.target.value}`)} className="h-8 w-auto py-0 text-xs">
            {list.map((b) => (
              <option key={b.id} value={b.id}>
                {b.code} · {b.name}
              </option>
            ))}
          </Select>
        }
      />

      {timeline.isLoading ? (
        <Loading label="Loading timeline…" />
      ) : timeline.error ? (
        <ErrorState error={timeline.error} onRetry={() => timeline.refetch()} />
      ) : t ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            {!t.stages.length ? (
              <EmptyState title="No species profile" description="Assign a profile to this batch to track stages." action={<Link to={`/batches/${t.batch.id}`} className="text-xs text-brand hover:underline">Edit batch →</Link>} />
            ) : (
              <ol>
                {t.stages.map((s, i) => (
                  <StageRow key={s.key} s={s} isLast={i === t.stages.length - 1} />
                ))}
              </ol>
            )}
          </div>
          <div className="space-y-4">
            <Card title="Batch">
              <KeyValue
                items={[
                  { k: 'Code', v: <Link to={`/batches/${t.batch.id}`} className="text-brand hover:underline">{t.batch.code}</Link> },
                  { k: 'Species', v: <em>{t.batch.species}</em> },
                  { k: 'Inoculated', v: fmtDateTime(t.batch.inoculation_date, 'dd MMM yyyy') },
                  { k: 'Profile', v: t.batch.profile ? <span className="inline-flex items-center gap-1">{t.batch.profile.name} <SourceTag source={t.batch.profile.source} compact /></span> : 'none' },
                  { k: 'Current stage', v: t.batch.current_stage_name ?? '—' },
                ]}
              />
              <Link to={`/batches/${t.batch.id}`} className="mt-3 inline-block text-xs text-brand hover:underline">
                Confirm a stage change or add observations →
              </Link>
            </Card>

            <Card title="Stage estimate" subtitle={est?.model ? `${est.model.name} v${est.model.version}` : undefined}>
              {!est || !est.available ? (
                <p className="text-xs text-ink-3">{est?.reason ?? 'No estimate available for this batch.'}</p>
              ) : (
                <div className="space-y-3 text-xs">
                  <div className="flex flex-wrap gap-1.5">
                    <SourceTag kind="predicted" />
                    <ConfidenceTag level={est.confidence?.level} basis={est.confidence?.basis} />
                    <Badge tone={est.timing === 'overdue' ? 'amber' : est.timing === 'within_typical_window' ? 'brand' : 'neutral'}>{titleCase(est.timing)}</Badge>
                  </div>
                  <p className="text-ink-2">{est.timing_label}</p>
                  {est.current_stage && (
                    <KeyValue
                      items={[
                        { k: 'Stage', v: `${est.current_stage.name} (${est.current_stage.index + 1}/${est.current_stage.total})` },
                        { k: 'Elapsed', v: fmtDays(est.current_stage.elapsed_days) },
                        { k: 'Typical', v: est.current_stage.typical_duration_days ? `${est.current_stage.typical_duration_days.min}–${est.current_stage.typical_duration_days.max} d` : '—' },
                        { k: 'Progress', v: est.cycle_progress?.label ?? '—' },
                      ]}
                    />
                  )}
                  {est.next_stage && (
                    <div className="rounded-md border border-line bg-surface-2 p-2">
                      <p className="font-medium text-ink">Next: {est.next_stage.name}</p>
                      {est.next_stage.expected_window ? (
                        <p className="text-ink-3">
                          Typical window {fmtDateTime(est.next_stage.expected_window.earliest, 'dd MMM')} – {fmtDateTime(est.next_stage.expected_window.latest, 'dd MMM')} <span className="text-ink-3">(calendar-based)</span>
                        </p>
                      ) : (
                        <p className="text-ink-3">No typical duration defined.</p>
                      )}
                      <p className="mt-1 text-ink-3">Confirm when you see: {est.next_stage.observable_signs.join(', ') || est.next_stage.transition_criteria}</p>
                    </div>
                  )}
                  {est.harvest_window?.earliest && (
                    <div>
                      <p className="label">Harvest window estimate</p>
                      <p className="text-ink-2">
                        {fmtDateTime(est.harvest_window.earliest, 'dd MMM')} – {fmtDateTime(est.harvest_window.latest, 'dd MMM yyyy')}
                      </p>
                      <p className="text-ink-3">{est.harvest_window.basis}</p>
                    </div>
                  )}
                  {est.environment_conformity && (
                    <div>
                      <p className="label">Environment vs. stage targets (last 24 h)</p>
                      <p className="text-ink-2">
                        temperature in range {fmtPercent(est.environment_conformity.temperature_in_range_fraction)} · humidity in range {fmtPercent(est.environment_conformity.humidity_in_range_fraction)} <SourceTag source={est.environment_conformity.source} compact />
                      </p>
                      <p className="text-ink-3">Out-of-range time usually delays development, but the size of the effect is not estimated here.</p>
                    </div>
                  )}
                  {est.confidence?.basis?.length ? (
                    <div>
                      <p className="label">Confidence basis</p>
                      <ul className="list-disc pl-4 text-ink-3">
                        {(Array.isArray(est.confidence.basis) ? est.confidence.basis : [est.confidence.basis]).map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              )}
            </Card>

            <Notice tone="neutral">
              Growth percentages are intentionally not shown: temperature and humidity alone cannot measure colonisation or fruiting progress. The DHT11 and moisture probe give no information about mycelium biomass or contamination.
            </Notice>
          </div>
        </div>
      ) : null}
    </div>
  );
}
