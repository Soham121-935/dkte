import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Bot, Maximize2, MessageSquarePlus, X } from 'lucide-react';
import { useAssistant } from '@/providers/AssistantProvider';
import { useDevice } from '@/providers/DeviceProvider';
import { Button } from '@/components/ui';
import { AIStatusDot, ChatPanel } from './ChatPanel';
import { useAssistantChat } from './useAssistantChat';

function DrawerBody() {
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
    <aside role="dialog" aria-modal="false" aria-label="MYCO AI assistant" className="fixed inset-y-0 right-0 z-[60] flex w-full max-w-[440px] flex-col border-l border-line bg-surface shadow-pop animate-fade-in">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-full border border-brand/40 bg-brand/10 text-brand" aria-hidden>
          <Bot className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="text-sm font-semibold text-ink">MYCO AI</p>
          <AIStatusDot st={chat.status.data} />
        </div>
        <Button size="xs" variant="ghost" icon={<MessageSquarePlus className="h-3.5 w-3.5" />} onClick={() => setConversationId(null)} title="Start a new chat">
          New
        </Button>
        <Link to="/assistant" onClick={close} className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink" title="Open the full assistant page" aria-label="Open the full assistant page">
          <Maximize2 className="h-3.5 w-3.5" />
        </Link>
        <button type="button" onClick={close} aria-label="Close assistant" className="rounded-md p-1.5 text-ink-3 hover:bg-surface-2 hover:text-ink">
          <X className="h-4 w-4" />
        </button>
      </header>
      {device && <p className="border-b border-line bg-surface-2 px-3 py-1.5 text-[11px] text-ink-3">Talking about <span className="font-medium text-ink-2">{device.name}</span>{device.kind === 'simulated' ? ' (simulated chamber)' : ''}</p>}
      <ChatPanel chat={chat} compact autoAsk={pendingQuestion} onAutoAsked={clearPending} inputId="drawer-chat-input" />
    </aside>
  );
}

/** Slide-over assistant available on every page. Mounted once in the app shell. */
export function AssistantDrawer() {
  const { open, close } = useAssistant();
  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-[55] bg-black/30 lg:bg-transparent" onClick={close} aria-hidden />
      <DrawerBody />
    </>
  );
}
