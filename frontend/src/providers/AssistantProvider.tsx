import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Makes MYCO AI reachable from every page: `ask("…")` opens the assistant
 * drawer (or hands the question to the full assistant page when that page is
 * already open) and sends the question in the current device context.
 */
interface AssistantCtx {
  open: boolean;
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
  const onAssistantPage = location.pathname.startsWith('/assistant');

  const openAssistant = useCallback(() => {
    if (!onAssistantPage) setOpen(true);
  }, [onAssistantPage]);
  const close = useCallback(() => setOpen(false), []);
  const ask = useCallback(
    (question: string) => {
      setPending(question);
      if (!onAssistantPage) setOpen(true);
    },
    [onAssistantPage],
  );
  const clearPending = useCallback(() => setPending(null), []);
  const value = useMemo(
    () => ({ open: open && !onAssistantPage, openAssistant, close, ask, pendingQuestion, clearPending, conversationId, setConversationId }),
    [open, onAssistantPage, openAssistant, close, ask, pendingQuestion, clearPending, conversationId],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    return {
      open: false,
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
