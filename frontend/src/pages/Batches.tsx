import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Package, Plus } from 'lucide-react';
import { useBatches } from '@/lib/queries';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Select, Tabs, statusTone } from '@/components/ui';
import { SectionTitle, SourceTag } from '@/components/domain';
import { BatchForm } from '@/components/BatchForm';
import { fmtDate, fmtDays, titleCase } from '@/lib/format';
import type { Batch } from '@/api/types';

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

export default function Batches() {
  const [status, setStatus] = useState<'active' | 'all' | 'completed'>('active');
  const [species, setSpecies] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const { canOperate, openLogin } = useAuth();
  const toast = useToast();
  const query = useBatches(status === 'all' ? undefined : status === 'active' ? { status: 'active' } : undefined);

  const batches = useMemo(() => {
    let list = query.data ?? [];
    if (status === 'completed') list = list.filter((b) => b.status !== 'active' && b.status !== 'planned');
    if (species) list = list.filter((b) => b.species === species);
    return list;
  }, [query.data, status, species]);
  const speciesOptions = useMemo(() => Array.from(new Set((query.data ?? []).map((b) => b.species))).sort(), [query.data]);

  const newBatch = () => {
    if (!canOperate) {
      toast.warning('Sign in as operator to create batches');
      openLogin();
      return;
    }
    setFormOpen(true);
  };

  return (
    <div className="space-y-4">
      <SectionTitle
        title="Cultivation Batches"
        description="The mushrooms you are growing. Each batch keeps its species, substrate, start date, current stage, notes and photos. You confirm stage changes yourself – the app never moves a batch forward just because time has passed."
        actions={
          <Button variant="primary" size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={newBatch}>
            New batch
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={status}
          onChange={setStatus}
          items={[
            { value: 'active', label: 'Active' },
            { value: 'completed', label: 'Finished' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Select aria-label="Filter by species" value={species} onChange={(e) => setSpecies(e.target.value)} className="h-8 w-auto py-0 text-xs">
          <option value="">all species</option>
          {speciesOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>

      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !batches.length ? (
        <EmptyState icon={<Package className="h-6 w-6" />} title="No batches" description="Create your first batch to start tracking a grow." action={<Button variant="primary" size="sm" onClick={newBatch}>New batch</Button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {batches.map((b: Batch) => {
            const stageDays = daysSince(b.stage_events?.length ? b.stage_events[b.stage_events.length - 1].started_at : null);
            return (
              <Card key={b.id} className="transition-colors hover:border-line-strong">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link to={`/batches/${b.id}`} className="block truncate text-sm font-semibold text-ink hover:underline">
                      {b.code}
                    </Link>
                    <p className="truncate text-xs text-ink-2">{b.name}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge tone={statusTone(b.status)}>{b.status}</Badge>
                    {b.is_demo && <Badge tone="amber">demo</Badge>}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                  <dt className="text-ink-3">Species</dt>
                  <dd className="truncate text-ink-2" title={b.species}>
                    <em>{b.species}</em>
                  </dd>
                  <dt className="text-ink-3">Strain</dt>
                  <dd className="truncate text-ink-2">{b.strain ?? '—'}</dd>
                  <dt className="text-ink-3">Substrate</dt>
                  <dd className="truncate text-ink-2">{b.substrate_type ?? '—'}</dd>
                  <dt className="text-ink-3">Inoculated</dt>
                  <dd className="text-ink-2">{fmtDate(b.inoculation_date)}</dd>
                  <dt className="text-ink-3">Stage</dt>
                  <dd className="text-ink-2">
                    {b.current_stage_name ?? titleCase(b.current_stage_key) ?? '—'}
                    {stageDays !== null && <span className="text-ink-3"> · day {fmtDays(stageDays)}</span>}
                  </dd>
                  <dt className="text-ink-3">Device</dt>
                  <dd className="font-mono text-ink-2">{b.device_id ?? '—'}</dd>
                  <dt className="text-ink-3">Profile</dt>
                  <dd className="truncate text-ink-2">
                    {b.profile ? (
                      <span className="inline-flex items-center gap-1">
                        {b.profile.name} <SourceTag source={b.profile.source} compact />
                      </span>
                    ) : (
                      'generic defaults'
                    )}
                  </dd>
                </dl>
                <div className="mt-3 flex items-center justify-between text-[11px]">
                  <span className="text-ink-3">
                    {b.observations?.length ?? 0} observation{(b.observations?.length ?? 0) === 1 ? '' : 's'}
                  </span>
                  <div className="flex gap-3">
                    <Link to={`/timeline/${b.id}`} className="text-brand hover:underline">
                      Timeline
                    </Link>
                    <Link to={`/batches/${b.id}`} className="text-brand hover:underline">
                      Details →
                    </Link>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <BatchForm open={formOpen} onClose={() => setFormOpen(false)} />
    </div>
  );
}
