import { useEffect, useMemo, useState } from 'react';
import { MessageSquarePlus, Trash2 } from 'lucide-react';
import { useBatches } from '@/lib/queries';
import { useDevice } from '@/providers/DeviceProvider';
import { useAuth } from '@/providers/AuthProvider';
import { useAssistant } from '@/providers/AssistantProvider';
import { useViewMode } from '@/providers/ViewModeProvider';
import { Button, Card, ErrorState, Loading, Notice, Select } from '@/components/ui';
import { SectionTitle, SourceTag } from '@/components/domain';
import { AIStatusDot, ChatPanel, describeAIStatus } from '@/components/assistant/ChatPanel';
import { useAssistantChat } from '@/components/assistant/useAssistantChat';
import { TechDetails } from '@/components/Technical';
import { fmtAgo } from '@/lib/format';
import { cn } from '@/lib/utils';

export default function Assistant() {
  const { devices, deviceId } = useDevice();
  const { user } = useAuth();
  const { detailed } = useViewMode();
  const { pendingQuestion, clearPending } = useAssistant();
  const batches = useBatches();
  const [ctxDevice, setCtxDevice] = useState<string>(deviceId ?? '');
  const [ctxBatch, setCtxBatch] = useState<string>('');
  const chat = useAssistantChat({ deviceId: ctxDevice || null, batchId: ctxBatch ? Number(ctxBatch) : null });

  useEffect(() => {
    if (!ctxDevice && deviceId) setCtxDevice(deviceId);
  }, [deviceId, ctxDevice]);

  const activeMeta = useMemo(() => chat.conversations.data?.find((c) => c.id === chat.activeId), [chat.conversations.data, chat.activeId]);
  const st = chat.status.data;
  const ai = describeAIStatus(st);
  const deviceName = (id: string | null | undefined) => devices.find((d) => d.id === id)?.name ?? (id ? id : 'no chamber');

  return (
    <div className="space-y-4">
      <SectionTitle
        title="AI Cultivation Assistant"
        description={
          detailed
            ? 'Answers are grounded in your stored data: the backend fetches the latest readings, targets, batch stage, alerts and recommendations and passes them to the model with timestamps. The assistant explains and suggests – it cannot change control modes or switch actuators.'
            : 'Ask MYCO AI anything about your chamber or your batch. It reads your real measurements, alerts and batch notes before answering, and always says when a value is simulated or only an estimate.'
        }
        actions={chat.status.isLoading ? <Loading className="py-0" /> : <AIStatusDot st={st} className="text-xs" />}
      />

      {st && !st.configured && (
        <Notice tone="amber">
          {detailed ? (
            <>
              No AI provider is configured (<code>AI_API_KEY</code> missing in the backend <code>.env</code>). The assistant still answers from stored data using deterministic templates. Add a key server-side to enable the language model – keys are never sent to the browser.
            </>
          ) : (
            <>
              <strong>The AI language model is offline right now.</strong> You can still ask questions – answers come directly from your stored readings, alerts and batch records. An administrator can enable the language model by adding the provider key on the server.
            </>
          )}
        </Notice>
      )}
      {st && st.configured && st.circuit_open && (
        <Notice tone="amber">
          <strong>MYCO AI is temporarily unavailable.</strong> {detailed ? `The configured provider (${st.endpoint_host}) could not be reached or rejected the request: ${st.last_error}.` : 'The AI service could not be reached.'} Answers come from your stored data until it is back.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="space-y-3">
          <Card title="Your chats" actions={<Button size="xs" variant="primary" icon={<MessageSquarePlus className="h-3 w-3" />} loading={chat.creating} onClick={chat.startNew}>New chat</Button>} padded={false}>
            <div className="space-y-2 border-b border-line p-3">
              <label className="label block" htmlFor="ctx-device">
                Talk about chamber
              </label>
              <Select id="ctx-device" value={ctxDevice} onChange={(e) => setCtxDevice(e.target.value)} className="h-8 py-0 text-xs">
                <option value="">none</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                    {d.kind === 'simulated' ? ' (simulated)' : ''}
                  </option>
                ))}
              </Select>
              <label className="label block" htmlFor="ctx-batch">
                Batch
              </label>
              <Select id="ctx-batch" value={ctxBatch} onChange={(e) => setCtxBatch(e.target.value)} className="h-8 py-0 text-xs">
                <option value="">the batch growing in that chamber</option>
                {batches.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </option>
                ))}
              </Select>
              <p className="text-[10px] text-ink-3">Applies to new chats.</p>
            </div>
            {chat.conversations.isLoading ? (
              <Loading className="px-3" />
            ) : chat.conversations.error ? (
              <ErrorState error={chat.conversations.error} />
            ) : !chat.conversations.data?.length ? (
              <p className="px-3 py-4 text-xs text-ink-3">No chats yet – ask a question to start one.</p>
            ) : (
              <ul className="max-h-[360px] overflow-y-auto">
                {chat.conversations.data.map((c) => (
                  <li key={c.id} className={cn('group flex items-start gap-2 border-b border-line/60 px-3 py-2 last:border-b-0', c.id === chat.activeId ? 'bg-brand/5' : 'hover:bg-surface-2')}>
                    <button type="button" onClick={() => chat.setActiveId(c.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-xs font-medium text-ink">{c.title}</p>
                      <p className="text-[10px] text-ink-3">
                        {detailed ? (c.device_id ?? 'no device') : deviceName(c.device_id)} · {c.message_count ?? 0} messages · {fmtAgo(c.updated_at)}
                      </p>
                    </button>
                    <button type="button" aria-label="Delete conversation" onClick={() => chat.remove(c.id)} className="rounded p-1 text-ink-3 opacity-0 hover:text-danger group-hover:opacity-100 focus:opacity-100">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="How to read answers">
            <ul className="space-y-1.5 text-[11px] text-ink-3">
              <li className="flex items-center gap-1.5"><SourceTag kind="measured" compact /> measured by a sensor, with its time</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="simulated" compact /> generated by the demo simulator</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="historical" compact /> summarised from stored history</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="predicted" compact /> an estimate – may be wrong</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="observed" compact /> something a grower wrote down</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="general" compact /> general growing knowledge</li>
            </ul>
            {st && (
              <TechDetails title="AI connection" className="mt-3" summary={ai.online ? 'online' : 'offline'}>
                <dl className="space-y-1 text-[11px] text-ink-3">
                  <div className="flex justify-between gap-2"><dt>Provider</dt><dd className="text-ink-2">{st.vendor ?? st.provider}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Model</dt><dd className="text-ink-2">{st.model ?? '—'}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Requests</dt><dd className="text-ink-2">{st.usage.requests} ({st.usage.failures} failed)</dd></div>
                  <div className="flex justify-between gap-2"><dt>Tokens</dt><dd className="text-ink-2">{st.usage.prompt_tokens + st.usage.completion_tokens}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Rate limit</dt><dd className="text-ink-2">{st.rate_limit_per_minute}/min</dd></div>
                  {st.last_error && <div className="flex justify-between gap-2"><dt>Last error</dt><dd className="text-right text-amber">{st.last_error}</dd></div>}
                </dl>
              </TechDetails>
            )}
          </Card>
        </div>

        <Card className="flex min-h-[560px] flex-col" title={activeMeta ? activeMeta.title : 'New chat'} subtitle={activeMeta ? `${detailed ? (activeMeta.device_id ?? 'no device context') : `about ${deviceName(activeMeta.device_id)}`}${activeMeta.batch_id ? ` · batch #${activeMeta.batch_id}` : ''}${user ? ` · ${user.username}` : ''}` : 'Ask a question to start'} padded={false} bodyClassName="flex flex-col">
          <ChatPanel chat={chat} autoAsk={pendingQuestion} onAutoAsked={clearPending} className="max-h-[640px]" />
        </Card>
      </div>
    </div>
  );
}
