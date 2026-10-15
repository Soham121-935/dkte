import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, Sparkles, Square, User as UserIcon } from 'lucide-react';
import { Badge, Button, ErrorState, Loading, Textarea } from '@/components/ui';
import { useViewMode } from '@/providers/ViewModeProvider';
import { fmtAgo, fmtDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AIMessage, AIStatus } from '@/api/types';
import type { AssistantChat } from './useAssistantChat';

/** Plain-language description of whether the language model is reachable. */
export function describeAIStatus(st: AIStatus | undefined): { online: boolean; label: string; detail: string } {
  if (!st) return { online: false, label: 'Checking MYCO AI…', detail: '' };
  if (st.configured && !st.circuit_open) {
    return { online: true, label: 'MYCO AI is online', detail: `Answers are written by the language model (${st.model ?? 'configured model'}) from your stored chamber data.` };
  }
  if (!st.configured) {
    return { online: false, label: 'MYCO AI is offline – answers come straight from your data', detail: 'No AI provider key is configured on the server. The assistant still answers from stored readings using fixed templates.' };
  }
  return {
    online: false,
    label: `MYCO AI is temporarily unavailable${st.circuit_retry_in_seconds > 0 ? ` (retrying in ${st.circuit_retry_in_seconds}s)` : ''}`,
    detail: st.last_error ? `Provider error: ${st.last_error}. Answers fall back to stored data meanwhile.` : 'Answers fall back to stored data meanwhile.',
  };
}

export function AIStatusDot({ st, className, withLabel = true }: { st: AIStatus | undefined; className?: string; withLabel?: boolean }) {
  const d = describeAIStatus(st);
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px]', d.online ? 'text-ink-2' : 'text-amber', className)} title={d.detail}>
      <span className={cn('h-2 w-2 rounded-full', d.online ? 'bg-brand' : 'bg-amber')} aria-hidden />
      {withLabel && <span>{d.label}</span>}
    </span>
  );
}

/** Strip the machine footer of deterministic answers – the UI shows its own, friendlier label. */
function cleanContent(content: string): string {
  return content.replace(/\n*_Answered directly from your stored data[^\n]*_\s*$/i, '').replace(/\n*_Deterministic assistant \(AI provider unavailable\)[^\n]*_\s*$/i, '').trimEnd();
}

export function MessageBubble({ m, compact }: { m: AIMessage; compact?: boolean }) {
  const { detailed } = useViewMode();
  const isUser = m.role === 'user';
  return (
    <div className={cn('flex gap-2.5', isUser ? 'flex-row-reverse' : '')}>
      {!compact && (
        <div className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', isUser ? 'border border-line-strong bg-surface-2 text-ink-2' : 'bg-spore text-spore-ink')} aria-hidden>
          {isUser ? <UserIcon className="h-3.5 w-3.5" /> : <Sparkles className="h-3.5 w-3.5" />}
        </div>
      )}
      <div className={cn('min-w-0 px-3.5 py-2.5', compact ? 'max-w-[88%]' : 'max-w-[85%]', isUser ? 'rounded-2xl rounded-br-md bg-spore text-spore-ink' : 'rounded-2xl rounded-bl-md border border-line bg-surface-2')}>
        {!isUser && !compact && <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-brand">MYCO AI</p>}
        {isUser ? (
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{m.content}</p>
        ) : (
          <div className="prose-chat">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{detailed ? m.content : cleanContent(m.content)}</ReactMarkdown>
          </div>
        )}
        <div className={cn('mt-1.5 flex flex-wrap items-center gap-1.5 text-[10px]', isUser ? 'text-spore-ink/70' : 'text-ink-3')}>
          <span title={fmtDateTime(m.created_at)}>{fmtAgo(m.created_at)}</span>
          {!isUser && m.mode === 'llm' && (
            <Badge tone="brand" title={detailed ? `${m.model} · ${m.latency_ms ?? '?'} ms · ${m.prompt_tokens ?? '?'}+${m.completion_tokens ?? '?'} tokens` : 'Written by the language model from your stored data'}>
              <Sparkles className="h-2.5 w-2.5" /> {detailed ? `AI · ${m.model}` : 'Answered by MYCO AI'}
            </Badge>
          )}
          {!isUser && m.mode === 'fallback' && (
            <Badge tone="amber" title={m.error ?? 'AI provider unavailable'}>
              {detailed ? 'AI unavailable · deterministic answer' : 'From your stored data (AI offline)'}
            </Badge>
          )}
          {detailed && !isUser && m.context_snapshot && 'current_reading' in m.context_snapshot && (
            <span title="The assistant received the latest stored reading, targets, batch and alert context from the database">
              context: {String(((m.context_snapshot as Record<string, Record<string, unknown>>).current_reading ?? {}).kind ?? 'reading').replace(/_/g, ' ')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function SuggestionChips({ questions, onPick, disabled, limit = 6, className }: { questions: string[]; onPick: (q: string) => void; disabled?: boolean; limit?: number; className?: string }) {
  if (!questions.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-1.5', className)}>
      {questions.slice(0, limit).map((q) => (
        <button key={q} type="button" onClick={() => onPick(q)} disabled={disabled} className="rounded-full border border-line bg-surface px-3 py-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:border-spore hover:text-ink disabled:opacity-50">
          {q}
        </button>
      ))}
    </div>
  );
}

/**
 * The chat itself: message list, pending indicator, suggestions and input.
 * `autoAsk` sends a question automatically once (used when the drawer is
 * opened from an "Ask MYCO AI about this" button).
 */
export function ChatPanel({ chat, compact, autoAsk, onAutoAsked, className, inputId = 'chat-input' }: { chat: AssistantChat; compact?: boolean; autoAsk?: string | null; onAutoAsked?: () => void; className?: string; inputId?: string }) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const askedRef = useRef<string | null>(null);
  const { messages, pendingUser, isSending, ask, stop, conversation, activeId, suggestions } = chat;

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pendingUser]);

  useEffect(() => {
    if (autoAsk && askedRef.current !== autoAsk && !isSending) {
      askedRef.current = autoAsk;
      if (ask(autoAsk)) onAutoAsked?.();
    }
  }, [autoAsk, ask, isSending, onAutoAsked]);

  const submit = (text?: string) => {
    const content = (text ?? draft).trim();
    if (!content) return;
    if (ask(content)) setDraft('');
  };

  const empty = !messages.length && !pendingUser;
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)}>
      <div ref={scrollRef} className={cn('flex-1 space-y-4 overflow-y-auto px-4 py-4', compact && 'px-3 py-3')} aria-live="polite">
        {activeId && conversation.isLoading ? (
          <Loading label="Opening chat…" />
        ) : conversation.error ? (
          <ErrorState error={conversation.error} onRetry={() => conversation.refetch()} />
        ) : empty ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 py-6 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-spore text-spore-ink">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <p className="font-display text-lg text-ink">Hi, I’m MYCO AI</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-ink-3">Ask me how your chamber is doing, why something switched on, or what to look for next. I answer from your real readings and tell you when a value is simulated or estimated.</p>
            </div>
            <SuggestionChips questions={suggestions} onPick={submit} disabled={isSending} className="justify-center" limit={compact ? 4 : 6} />
          </div>
        ) : (
          <>
            {messages.map((m) => (
              <MessageBubble key={m.id} m={m} compact={compact} />
            ))}
            {pendingUser && (
              <>
                <MessageBubble compact={compact} m={{ id: -1, role: 'user', content: pendingUser, created_at: new Date().toISOString(), mode: null, provider: null, model: null, prompt_tokens: null, completion_tokens: null, latency_ms: null, context_snapshot: null, error: null }} />
                <div className="flex items-center gap-2 text-xs text-ink-3">
                  <span className="inline-flex items-center gap-1 rounded-2xl rounded-bl-md border border-line bg-surface-2 px-3.5 py-3" aria-hidden>
                    <i className="h-[7px] w-[7px] rounded-full bg-ink-3 animate-blink" />
                    <i className="h-[7px] w-[7px] rounded-full bg-ink-3 animate-blink [animation-delay:150ms]" />
                    <i className="h-[7px] w-[7px] rounded-full bg-ink-3 animate-blink [animation-delay:300ms]" />
                  </span>
                  <span>MYCO AI is reading your chamber data…</span>
                  <Button size="xs" variant="ghost" icon={<Square className="h-3 w-3" />} onClick={stop}>
                    Stop
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className={cn('border-t border-line px-4 py-3', compact && 'px-3 py-2.5')}>
        {!empty && <SuggestionChips questions={suggestions} onPick={submit} disabled={isSending} className="mb-2" limit={compact ? 3 : 6} />}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label htmlFor={inputId} className="sr-only">
            Ask MYCO AI
          </label>
          <Textarea
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={compact ? 'Type your question' : 'Ask MYCO AI anything about your grow…'}
            className={cn('max-h-40 min-h-[48px]', compact && 'rounded-3xl px-4 py-3 text-[15px]')}
            rows={1}
            maxLength={4000}
            disabled={isSending}
          />
          {compact ? (
            <button type="submit" disabled={!draft.trim() || isSending} aria-label="Send" className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-spore text-spore-ink disabled:opacity-50">
              <Send className="h-4 w-4" />
            </button>
          ) : (
            <Button type="submit" variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={isSending} disabled={!draft.trim()} aria-label="Send">
              Send
            </Button>
          )}
        </form>
        <p className="mt-1.5 text-[10px] text-ink-3">MYCO AI explains and suggests – it never switches equipment on or off. Double-check important decisions against the live readings.</p>
      </div>
    </div>
  );
}
