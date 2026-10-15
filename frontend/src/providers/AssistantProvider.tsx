import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/** Element id of the chat section embedded in the Overview page. */
export const INLINE_CHAT_ID = 'myco-ai';
/** Route that hosts the chat inline (no floating window there). */
const INLINE_PATH = '/';

function scrollToInlineChat() {
  // jsdom has no scrollIntoView – guard so tests and odd browsers never throw
  document.getElementById(INLINE_CHAT_ID)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
}

/**
 * Makes MYCO AI reachable from every page: `ask("…")` opens the floating chat
 * window (or scrolls to the chat embedded in the Overview when that page is
 * open) and sends the question in the current device context.
 */
interface AssistantCtx {
  open: boolean;
  /** True on the page that embeds the chat (the floating bubble is hidden there). */
  inline: boolean;
  openAssistant: () => void;
  close: () => void;
  /** Open the assistant and ask this question immediately. */
  ask: (question: string) => void;
  /** Question waiting to be sent by whichever chat surface mounts next. */
  pendingQuestion: string | null;
  clearPending: () => void;
  /** Conversation the drawer is currently showing (kept across open/close). */
  conversationId: number | null;
  setConversationId: (id: number | null) => void;
}

const Ctx = createContext<AssistantCtx | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pendingQuestion, setPending] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const location = useLocation();
  const inline = location.pathname === INLINE_PATH;

  const openAssistant = useCallback(() => {
    if (inline) scrollToInlineChat();
    else setOpen(true);
  }, [inline]);
  const close = useCallback(() => setOpen(false), []);
  const ask = useCallback(
    (question: string) => {
      setPending(question);
      if (inline) scrollToInlineChat();
      else setOpen(true);
    },
    [inline],
  );
  const clearPending = useCallback(() => setPending(null), []);
  const value = useMemo(
    () => ({ open: open && !inline, inline, openAssistant, close, ask, pendingQuestion, clearPending, conversationId, setConversationId }),
    [open, inline, openAssistant, close, ask, pendingQuestion, clearPending, conversationId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    return {
      open: false,
      inline: false,
      openAssistant: () => {},
      close: () => {},
      ask: () => {},
      pendingQuestion: null,
      clearPending: () => {},
      conversationId: null,
      setConversationId: () => {},
    };
  }
  return ctx;
}
