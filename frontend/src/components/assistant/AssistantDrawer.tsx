import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Maximize2, MessageSquarePlus, Sparkles, X } from 'lucide-react';
import { useAssistant } from '@/providers/AssistantProvider';
import { useDevice } from '@/providers/DeviceProvider';
import { AIStatusDot, ChatPanel } from './ChatPanel';
import { useAssistantChat } from './useAssistantChat';

function ChatWindow() {
  const { close, pendingQuestion, clearPending, conversationId, setConversationId } = useAssistant();
  const { deviceId, device } = useDevice();
  const chat = useAssistantChat({ deviceId, conversationId, onConversationChange: setConversationId, autoSelectLatest: false });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="MYCO AI assistant"
      className="fixed inset-x-0 bottom-0 z-[60] flex h-[84dvh] flex-col overflow-hidden rounded-t-[28px] border border-line bg-surface shadow-pop animate-pop-in sm:inset-x-auto sm:bottom-4 sm:right-4 sm:h-[min(640px,calc(100dvh-2rem))] sm:w-[min(400px,calc(100vw-2rem))] sm:rounded-[28px]"
    >
      <header className="flex items-center gap-3 border-b border-line py-3 pl-[18px] pr-3">
        <span className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-full bg-spore text-spore-ink" aria-hidden>
          <Sparkles className="h-[22px] w-[22px]" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="font-display text-[19px] text-ink">MYCO AI</p>
          <AIStatusDot st={chat.status.data} />
        </div>
        <button type="button" onClick={() => setConversationId(null)} title="Start a new chat" aria-label="Start a new chat" className="grid h-10 w-10 place-items-center rounded-full border border-line text-ink-3 hover:bg-surface-2 hover:text-ink">
          <MessageSquarePlus className="h-4 w-4" />
        </button>
        <Link to="/assistant" onClick={close} className="hidden h-10 w-10 place-items-center rounded-full border border-line text-ink-3 hover:bg-surface-2 hover:text-ink sm:grid" title="Open the full assistant page" aria-label="Open the full assistant page">
          <Maximize2 className="h-4 w-4" />
        </Link>
        <button type="button" onClick={close} aria-label="Close assistant" className="grid h-10 w-10 place-items-center rounded-full border border-line text-ink-3 hover:bg-surface-2 hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </header>
      {device && (
        <p className="border-b border-line bg-surface-2 px-[18px] py-1.5 text-[11px] text-ink-3">
          Talking about <span className="font-medium text-ink-2">{device.name}</span>
          {device.kind === 'simulated' ? ' (simulated chamber)' : ''}
        </p>
      )}
      <ChatPanel chat={chat} compact autoAsk={pendingQuestion} onAutoAsked={clearPending} inputId="drawer-chat-input" />
    </aside>
  );
}

/** Floating chat window available on every page (bottom sheet on phones). Mounted once in the app shell. */
export function AssistantDrawer() {
  const { open, close } = useAssistant();
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[55] bg-black/40 sm:bg-transparent" onClick={close} aria-hidden />
      <ChatWindow />
    </>
  );
}
