import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { endpoints } from '@/api/endpoints';
import { qk, useAIStatus } from '@/lib/queries';
import { useToast } from '@/providers/ToastProvider';
import { errorMessage } from '@/components/ui';
import type { AIMessage, Conversation } from '@/api/types';

export interface AssistantChatOptions {
  /** Device whose data the assistant should talk about (used when a new conversation is created). */
  deviceId: string | null;
  /** Optional batch; `null` lets the backend pick the active batch on the device. */
  batchId?: number | null;
  /** Externally controlled active conversation (e.g. remembered by the drawer). */
  conversationId?: number | null;
  onConversationChange?: (id: number | null) => void;
  /** When false, the newest existing conversation is NOT auto-selected (drawer starts fresh). */
  autoSelectLatest?: boolean;
}

/**
 * All state and server calls behind an assistant chat: conversation list,
 * active conversation, sending with abort support, optimistic "pending"
 * user message and AI status. Shared by the assistant page and the drawer.
 */
export function useAssistantChat(opts: AssistantChatOptions) {
  const { deviceId, batchId = null, autoSelectLatest = true } = opts;
  const qc = useQueryClient();
  const toast = useToast();
  const [internalId, setInternalId] = useState<number | null>(opts.conversationId ?? null);
  const controlled = opts.conversationId !== undefined;
  const activeId = controlled ? (opts.conversationId ?? null) : internalId;
  const setActiveId = useCallback(
    (id: number | null) => {
      if (!controlled) setInternalId(id);
      opts.onConversationChange?.(id);
    },
    [controlled, opts],
  );
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const status = useAIStatus();
  const suggestions = useQuery({ queryKey: ['ai', 'suggestions'], queryFn: endpoints.aiSuggestions, staleTime: Infinity });
  const conversations = useQuery({ queryKey: qk.conversations, queryFn: () => endpoints.conversations(30) });
  const conversation = useQuery({ queryKey: qk.conversation(activeId ?? 0), queryFn: () => endpoints.conversation(activeId!), enabled: !!activeId });

  useEffect(() => {
    if (autoSelectLatest && activeId === null && conversations.data?.length) setActiveId(conversations.data[0].id);
  }, [autoSelectLatest, conversations.data, activeId, setActiveId]);

  const createBody = useCallback(() => ({ device_id: deviceId || null, batch_id: batchId ?? null }), [deviceId, batchId]);

  const create = useMutation({
    mutationFn: () => endpoints.createConversation(createBody()),
    onSuccess: (c: Conversation) => {
      qc.invalidateQueries({ queryKey: qk.conversations });
      setActiveId(c.id);
    },
    onError: (e) => toast.error('Could not start a new chat', errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => endpoints.deleteConversation(id),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: qk.conversations });
      if (activeId === id) setActiveId(null);
    },
    onError: (e) => toast.error('Could not delete the chat', errorMessage(e)),
  });
  const send = useMutation({
    mutationFn: async (content: string) => {
      let id = activeId;
      if (!id) {
        const c = await endpoints.createConversation(createBody());
        id = c.id;
        setActiveId(id);
      }
      abortRef.current = new AbortController();
      return endpoints.sendMessage(id, content, abortRef.current.signal);
    },
    onMutate: (content) => setPendingUser(content),
    onSuccess: (res) => {
      const id = res.conversation.id;
      qc.setQueryData<Conversation & { messages: AIMessage[] }>(qk.conversation(id), (old) => {
        const known = new Set(res.messages.map((m) => m.id));
        return { ...(old ?? res.conversation), ...res.conversation, messages: [...(old?.messages ?? []).filter((m) => !known.has(m.id)), ...res.messages] };
      });
      qc.setQueryData(qk.aiStatus, res.ai);
      qc.invalidateQueries({ queryKey: qk.conversations, exact: true });
    },
    onError: (e) => {
      if ((e as Error).name !== 'AbortError') toast.error('MYCO AI could not answer', errorMessage(e));
    },
    onSettled: () => setPendingUser(null),
  });

  const ask = useCallback(
    (text: string) => {
      const content = text.trim();
      if (!content || send.isPending) return false;
      send.mutate(content);
      return true;
    },
    [send],
  );
  const stop = useCallback(() => abortRef.current?.abort(), []);

  const messages: AIMessage[] = conversation.data?.messages ?? [];
  return {
    activeId,
    setActiveId,
    conversations,
    conversation,
    messages,
    pendingUser,
    isSending: send.isPending,
    ask,
    stop,
    startNew: () => create.mutate(),
    creating: create.isPending,
    remove: (id: number) => remove.mutate(id),
    status,
    suggestions: suggestions.data?.questions ?? [],
  };
}

export type AssistantChat = ReturnType<typeof useAssistantChat>;
