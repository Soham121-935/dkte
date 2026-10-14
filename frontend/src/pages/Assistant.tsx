import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, MessageSquarePlus, Send, Trash2, User as UserIcon, Square } from 'lucide-react';
import { endpoints } from '@/api/endpoints';
import { qk, useBatches } from '@/lib/queries';
import { useDevice } from '@/providers/DeviceProvider';
import { useToast } from '@/providers/ToastProvider';
import { useAuth } from '@/providers/AuthProvider';
import { Badge, Button, Card, EmptyState, ErrorState, Loading, Notice, Select, Textarea, errorMessage } from '@/components/ui';
import { SectionTitle, SourceTag } from '@/components/domain';
import { fmtAgo, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AIMessage } from '@/api/types';

function MessageBubble({ m }: { m: AIMessage }) {
  const isUser = m.role === 'user';
  return (
    <div className={cn('flex gap-2.5', isUser ? 'flex-row-reverse' : '')}>
      <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full border', isUser ? 'border-line-strong bg-surface-2 text-ink-2' : 'border-brand/40 bg-brand/10 text-brand')}>{isUser ? <UserIcon className="h-3.5 w-3.5" /> : <Bot className="h-3.5 w-3.5" />}</div>
      <div className={cn('min-w-0 max-w-[88%] rounded-lg border px-3 py-2', isUser ? 'border-line bg-surface-2' : 'border-line bg-surface')}>
        {isUser ? (
          <p className="whitespace-pre-wrap text-sm text-ink">{m.content}</p>
        ) : (
          <div className="prose-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
          </div>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px] text-ink-3">
          <span title={fmtDateTime(m.created_at)}>{fmtAgo(m.created_at)}</span>
          {!isUser && m.mode === 'llm' && (
            <Badge tone="brand" title={`${m.model} · ${m.latency_ms ?? '?'} ms · ${m.prompt_tokens ?? '?'}+${m.completion_tokens ?? '?'} tokens`}>
              LLM · {m.model}
            </Badge>
          )}
          {!isUser && m.mode === 'fallback' && (
            <Badge tone="amber" title={m.error ?? 'provider unavailable'}>
              AI unavailable · deterministic answer
            </Badge>
          )}
          {!isUser && m.context_snapshot && 'current_reading' in m.context_snapshot && (
            <span title="The assistant received the latest stored reading, targets, batch and alert context from the database">
              context: {String(((m.context_snapshot as Record<string, Record<string, unknown>>).current_reading ?? {}).kind ?? 'reading').replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Assistant() {
  const { devices, deviceId } = useDevice();
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const batches = useBatches();
  const status = useQuery({ queryKey: qk.aiStatus, queryFn: endpoints.aiStatus, refetchInterval: 30000 });
  const suggestions = useQuery({ queryKey: ['ai', 'suggestions'], queryFn: endpoints.aiSuggestions, staleTime: Infinity });
  const conversations = useQuery({ queryKey: qk.conversations, queryFn: () => endpoints.conversations(30) });
  const [activeId, setActiveId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [ctxDevice, setCtxDevice] = useState<string>(deviceId ?? '');
  const [ctxBatch, setCtxBatch] = useState<string>('');
  const conversation = useQuery({ queryKey: qk.conversation(activeId ?? 0), queryFn: () => endpoints.conversation(activeId!), enabled: !!activeId });
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [pendingUser, setPendingUser] = useState<string | null>(null);

  useEffect(() => {
    if (!ctxDevice && deviceId) setCtxDevice(deviceId);
  }, [deviceId, ctxDevice]);
  useEffect(() => {
    if (activeId === null && conversations.data?.length) setActiveId(conversations.data[0].id);
  }, [conversations.data, activeId]);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [conversation.data?.messages?.length, pendingUser]);

  const create = useMutation({
    mutationFn: () => endpoints.createConversation({ device_id: ctxDevice || null, batch_id: ctxBatch ? Number(ctxBatch) : null }),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: qk.conversations });
      setActiveId(c.id);
    },
    onError: (e) => toast.error('Could not start conversation', errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => endpoints.deleteConversation(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: qk.conversations });
      if (activeId === id) setActiveId(null);
    },
    onError: (e) => toast.error('Delete failed', errorMessage(e)),
  });
  const send = useMutation({
    mutationFn: async (content: string) => {
      let id = activeId;
      if (!id) {
        const c = await endpoints.createConversation({ device_id: ctxDevice || null, batch_id: ctxBatch ? Number(ctxBatch) : null });
        id = c.id;
        setActiveId(id);
      }
      abortRef.current = new AbortController();
      return endpoints.sendMessage(id, content, abortRef.current.signal);
    },
    onMutate: (content) => setPendingUser(content),
    onSuccess: (conv) => {
      qc.setQueryData(qk.conversation(conv.id), conv);
      qc.invalidateQueries({ queryKey: qk.conversations });
      qc.invalidateQueries({ queryKey: qk.aiStatus });
    },
    onError: (e) => {
      if ((e as Error).name !== 'AbortError') toast.error('Message failed', errorMessage(e));
    },
    onSettled: () => setPendingUser(null),
  });

  const submit = (text?: string) => {
    const content = (text ?? draft).trim();
    if (!content || send.isPending) return;
    setDraft('');
    send.mutate(content);
  };

  const active = conversation.data;
  const activeMeta = useMemo(() => conversations.data?.find((c) => c.id === activeId), [conversations.data, activeId]);
  const st = status.data;

  return (
    <div className="space-y-4">
      <SectionTitle
        title="AI Cultivation Assistant"
        description="Answers are grounded in your stored data: the backend fetches the latest readings, targets, batch stage, alerts and recommendations and passes them to the model with timestamps. The assistant explains and suggests – it cannot change control modes or switch actuators."
        actions={
          status.isLoading ? (
            <Loading className="py-0" />
          ) : st ? (
            st.configured && !st.circuit_open ? (
              <Badge tone="brand" dot>
                {st.vendor ?? st.provider} · {st.model}
              </Badge>
            ) : (
              <Badge tone="amber" dot title={st.last_error ?? undefined}>
                AI provider unavailable – deterministic fallback{st.circuit_open && st.circuit_retry_in_seconds > 0 ? ` (retry in ${st.circuit_retry_in_seconds}s)` : ''}
              </Badge>
            )
          ) : null
        }
      />

      {st && !st.configured && (
        <Notice tone="amber">
          No AI provider is configured (<code>AI_API_KEY</code> missing in the backend <code>.env</code>). The assistant still answers from stored data using deterministic templates. Add a key server-side to enable the language model – keys are never sent to the browser.
        </Notice>
      )}
      {st && st.configured && st.circuit_open && (
        <Notice tone="amber">
          The configured provider ({st.endpoint_host}) could not be reached or rejected the request: <em>{st.last_error}</em>. Answers fall back to deterministic summaries until the next retry.
        </Notice>
      )}

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        <div className="space-y-3">
          <Card title="Conversations" actions={<Button size="xs" variant="primary" icon={<MessageSquarePlus className="h-3 w-3" />} loading={create.isPending} onClick={() => create.mutate()}>New</Button>} padded={false}>
            <div className="space-y-2 border-b border-line p-3">
              <label className="label block" htmlFor="ctx-device">
                Context device
              </label>
              <Select id="ctx-device" value={ctxDevice} onChange={(e) => setCtxDevice(e.target.value)} className="h-8 py-0 text-xs">
                <option value="">none</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
              <label className="label block" htmlFor="ctx-batch">
                Context batch
              </label>
              <Select id="ctx-batch" value={ctxBatch} onChange={(e) => setCtxBatch(e.target.value)} className="h-8 py-0 text-xs">
                <option value="">auto (active batch on device)</option>
                {batches.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code}
                  </option>
                ))}
              </Select>
            </div>
            {conversations.isLoading ? (
              <Loading className="px-3" />
            ) : conversations.error ? (
              <ErrorState error={conversations.error} />
            ) : !conversations.data?.length ? (
              <p className="px-3 py-4 text-xs text-ink-3">No conversations yet – ask a question to start one.</p>
            ) : (
              <ul className="max-h-[360px] overflow-y-auto">
                {conversations.data.map((c) => (
                  <li key={c.id} className={cn('group flex items-start gap-2 border-b border-line/60 px-3 py-2 last:border-b-0', c.id === activeId ? 'bg-brand/5' : 'hover:bg-surface-2')}>
                    <button type="button" onClick={() => setActiveId(c.id)} className="min-w-0 flex-1 text-left">
                      <p className="truncate text-xs font-medium text-ink">{c.title}</p>
                      <p className="text-[10px] text-ink-3">
                        {c.device_id ?? 'no device'} · {c.message_count ?? 0} msgs · {fmtAgo(c.updated_at)}
                      </p>
                    </button>
                    <button type="button" aria-label="Delete conversation" onClick={() => remove.mutate(c.id)} className="rounded p-1 text-ink-3 opacity-0 hover:text-danger group-hover:opacity-100 focus:opacity-100">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="How to read answers">
            <ul className="space-y-1.5 text-[11px] text-ink-3">
              <li className="flex items-center gap-1.5"><SourceTag kind="measured" compact /> measured by the sensor, with timestamp</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="simulated" compact /> simulator output (demo mode)</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="historical" compact /> aggregated stored history</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="predicted" compact /> model estimate with uncertainty</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="observed" compact /> entered by a grower</li>
              <li className="flex items-center gap-1.5"><SourceTag kind="general" compact /> general cultivation knowledge</li>
            </ul>
            {st && (
              <p className="mt-3 text-[10px] text-ink-3">
                Usage this session: {st.usage.requests} requests · {st.usage.failures} failures · {st.usage.prompt_tokens + st.usage.completion_tokens} tokens · limit {st.rate_limit_per_minute}/min
              </p>
            )}
          </Card>
        </div>

        <Card className="flex min-h-[560px] flex-col" title={activeMeta ? activeMeta.title : 'New conversation'} subtitle={activeMeta ? `${activeMeta.device_id ?? 'no device context'}${activeMeta.batch_id ? ` · batch #${activeMeta.batch_id}` : ''} · ${user ? `as ${user.username}` : 'anonymous'}` : 'Select a context and ask a question'} padded={false} bodyClassName="flex flex-col">
          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4" style={{ maxHeight: 520 }}>
            {activeId && conversation.isLoading ? (
              <Loading />
            ) : conversation.error ? (
              <ErrorState error={conversation.error} onRetry={() => conversation.refetch()} />
            ) : !active?.messages?.length && !pendingUser ? (
              <EmptyState
                icon={<Bot className="h-6 w-6" />}
                title="Ask about your grow"
                description="Questions are answered from stored readings, alerts, batch stage and recommendations. Try one of the suggestions below."
                className="py-10"
              />
            ) : (
              <>
                {active?.messages?.map((m) => (
                  <MessageBubble key={m.id} m={m} />
                ))}
                {pendingUser && (
                  <>
                    <MessageBubble m={{ id: -1, role: 'user', content: pendingUser, created_at: new Date().toISOString(), mode: null, provider: null, model: null, prompt_tokens: null, completion_tokens: null, latency_ms: null, context_snapshot: null, error: null }} />
                    <div className="flex items-center gap-2 text-xs text-ink-3">
                      <Loading label="Collecting data and generating answer…" className="py-0" />
                      <Button size="xs" variant="ghost" icon={<Square className="h-3 w-3" />} onClick={() => abortRef.current?.abort()}>
                        Stop waiting
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </div>
          <div className="border-t border-line px-4 py-3">
            {suggestions.data?.questions.length ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {suggestions.data.questions.slice(0, 6).map((q) => (
                  <button key={q} type="button" onClick={() => submit(q)} disabled={send.isPending} className="rounded-full border border-line bg-surface-2 px-2.5 py-1 text-[11px] text-ink-2 hover:border-line-strong hover:text-ink disabled:opacity-50">
                    {q}
                  </button>
                ))}
              </div>
            ) : null}
            <form
              className="flex items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <label htmlFor="chat-input" className="sr-only">
                Message
              </label>
              <Textarea
                id="chat-input"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="e.g. Why did humidity drop overnight? (Enter to send, Shift+Enter for a new line)"
                className="min-h-[44px] max-h-40"
                rows={1}
                maxLength={4000}
                disabled={send.isPending}
              />
              <Button type="submit" variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={send.isPending} disabled={!draft.trim()}>
                Send
              </Button>
            </form>
            <p className="mt-1.5 text-[10px] text-ink-3">The assistant never controls hardware. It may be wrong – verify against the Live Monitoring data and your own observations.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
