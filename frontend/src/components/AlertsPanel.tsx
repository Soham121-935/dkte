import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { BellOff, Check, CheckCheck } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { useAlerts } from '@/lib/queries';
import { useAuth } from '@/providers/AuthProvider';
import { useToast } from '@/providers/ToastProvider';
import { Badge, Button, EmptyState, ErrorState, Loading, Select, Tabs, errorMessage, severityTone, statusTone } from '@/components/ui';
import { SourceTag } from '@/components/domain';
import { fmtAgo, fmtDateTime } from '@/lib/format';
import type { Alert } from '@/api/types';

type Filter = 'open' | 'active' | 'acknowledged' | 'resolved' | 'all';

export function AlertsPanel({ deviceId, compact }: { deviceId?: string | null; compact?: boolean }) {
  const [filter, setFilter] = useState<Filter>('open');
  const [severity, setSeverity] = useState<string>('');
  const { canOperate, openLogin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const query = useAlerts({ status: filter === 'all' ? undefined : filter, severity: severity || undefined, device_id: deviceId ?? undefined, limit: compact ? 20 : 100 });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['alerts'] });
    qc.invalidateQueries({ queryKey: ['system'] });
  };
  const ack = useMutation({ mutationFn: (id: number) => endpoints.acknowledgeAlert(id), onSuccess: invalidate, onError: (e) => toast.error('Acknowledge failed', errorMessage(e)) });
  const resolve = useMutation({ mutationFn: (id: number) => endpoints.resolveAlert(id, 'resolved from dashboard'), onSuccess: invalidate, onError: (e) => toast.error('Resolve failed', errorMessage(e)) });

  const guard = (fn: () => void) => {
    if (!canOperate) {
      toast.warning('Sign in as operator to manage alerts');
      openLogin();
      return;
    }
    fn();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs
          value={filter}
          onChange={setFilter}
          items={[
            { value: 'open', label: 'Open' },
            { value: 'active', label: 'Active' },
            { value: 'acknowledged', label: 'Acknowledged' },
            { value: 'resolved', label: 'Resolved' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Select aria-label="Filter by severity" value={severity} onChange={(e) => setSeverity(e.target.value)} className="h-8 w-auto py-0 text-xs">
          <option value="">any severity</option>
          <option value="critical">critical</option>
          <option value="warning">warning</option>
          <option value="info">info</option>
        </Select>
      </div>
      {query.isLoading ? (
        <Loading />
      ) : query.error ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : !query.data?.length ? (
        <EmptyState icon={<BellOff className="h-5 w-5" />} title="No alerts" description={filter === 'open' ? 'No active or acknowledged alerts for this selection.' : 'Nothing matches this filter.'} className="py-6" />
      ) : (
        <ul className="divide-y divide-line">
          {query.data.map((a: Alert) => (
            <li key={a.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-start">
              <div className="flex shrink-0 items-center gap-1.5 sm:w-28 sm:flex-col sm:items-start">
                <Badge tone={severityTone(a.severity)}>{a.severity}</Badge>
                <Badge tone={statusTone(a.status)}>{a.status}</Badge>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-ink">{a.title}</p>
                <p className="text-xs text-ink-2">{a.message}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
                  <span className="font-mono">{a.rule_key}</span>
                  <span>· {a.device_id ?? 'system'}</span>
                  <span>· opened {fmtDateTime(a.opened_at)}</span>
                  <span>· last seen {fmtAgo(a.last_seen_at)}</span>
                  {a.occurrence_count > 1 && <span>· ×{a.occurrence_count}</span>}
                  <SourceTag source={a.source} compact />
                  {a.acknowledged_by && <span>· ack by {a.acknowledged_by}</span>}
                  {a.resolved_reason && <span>· resolved: {a.resolved_reason}</span>}
                </p>
              </div>
              {a.status !== 'resolved' && (
                <div className="flex shrink-0 gap-1.5">
                  {a.status === 'active' && (
                    <Button size="xs" variant="outline" icon={<Check className="h-3 w-3" />} onClick={() => guard(() => ack.mutate(a.id))} loading={ack.isPending && ack.variables === a.id}>
                      Acknowledge
                    </Button>
                  )}
                  <Button size="xs" variant="ghost" icon={<CheckCheck className="h-3 w-3" />} onClick={() => guard(() => resolve.mutate(a.id))} loading={resolve.isPending && resolve.variables === a.id}>
                    Resolve
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
