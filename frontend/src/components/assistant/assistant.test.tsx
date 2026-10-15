/**
 * The AI must be reachable from everywhere and the Overview must explain the
 * chamber in plain words. These tests drive the real App through the recorded
 * fixtures: briefing card, the chat embedded in the Overview, the floating
 * window on the other pages, status labels and the "Ask AI" shortcuts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';
import { FIXTURES, WebSocketStub, installFetchMock, json, renderApp, type FetchMock } from '@/test/helpers';

/** Stateful stand-in for the conversation endpoints (create, fetch, send). */
function installChatRoutes(fetchMock: FetchMock) {
  const sent: { conversationId: number; content: string }[] = [];
  const store = new Map<number, typeof FIXTURES.conversationReply.messages>();
  const reply = FIXTURES.conversationReply;
  fetchMock.on('POST', /^\/api\/ai\/conversations$/, ({ body }) => {
    store.set(42, []);
    return json(201, { ...reply.conversation, id: 42, title: 'New conversation', message_count: 0, messages: [], device_id: (body as { device_id?: string }).device_id ?? null });
  });
  fetchMock.on('GET', /^\/api\/ai\/conversations\/(\d+)$/, ({ url }) => {
    const id = Number(url.pathname.split('/')[4]);
    return { ...reply.conversation, id, messages: store.get(id) ?? [] };
  });
  fetchMock.on('POST', /^\/api\/ai\/conversations\/(\d+)\/messages$/, ({ url, body }) => {
    const id = Number(url.pathname.split('/')[4]);
    const content = (body as { content: string }).content;
    sent.push({ conversationId: id, content });
    const n = (store.get(id) ?? []).length;
    const messages = [
      { ...reply.messages[0], id: n + 1, content },
      { ...reply.messages[1], id: n + 2 },
    ];
    store.set(id, [...(store.get(id) ?? []), ...messages]);
    return json(201, { conversation: { ...reply.conversation, id }, messages, ai: reply.ai });
  });
  return sent;
}

describe('MYCO AI front and centre', () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    WebSocketStub.instances.length = 0;
    vi.stubGlobal('WebSocket', WebSocketStub);
    fetchMock = installFetchMock();
  });
  afterEach(() => {
    fetchMock.restore();
    vi.unstubAllGlobals();
  });

  it('shows the plain-language briefing on the home page, labelled as computed when the AI is offline', async () => {
    renderApp(<App />);
    expect(await screen.findByText(FIXTURES.aiInsight.headline)).toBeInTheDocument();
    for (const p of FIXTURES.aiInsight.points) expect(screen.getByText(p.text)).toBeInTheDocument();
    expect(screen.getByText(FIXTURES.aiInsight.next_step)).toBeInTheDocument();
    expect(screen.getByText('From your data (AI offline)')).toBeInTheDocument();
    expect(screen.getByText(FIXTURES.aiInsight.data_note!)).toBeInTheDocument();
    // the request carried the device and the active batch
    const call = fetchMock.calls.find((c) => c.url.startsWith('/api/ai/insight'));
    expect(call?.url).toContain('device_id=myco-sim-01');
    // no engineering jargon on the simple home page
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(/bucket \d+s|transport|hysteresis|rule_key|MQTT/);
  });

  it('the chat lives on the Overview: typing a question creates a conversation for the chamber and renders the labelled reply', async () => {
    const user = userEvent.setup();
    const sent = installChatRoutes(fetchMock);
    renderApp(<App />);
    await screen.findByText(FIXTURES.aiInsight.headline);
    const chat = screen.getByRole('region', { name: 'MYCO AI assistant' });
    // no floating bubble / window here – the chat is part of the page
    expect(screen.queryByRole('button', { name: 'Ask MYCO AI' })).not.toBeInTheDocument();
    expect(within(chat).getByText(/Hi, I’m MYCO AI/)).toBeInTheDocument();
    expect(within(chat).getByText(/Talking about/)).toHaveTextContent('simulated');
    await user.type(within(chat).getByLabelText('Ask MYCO AI', { selector: 'textarea' }), 'Why is humidity dropping?{Enter}');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ conversationId: 42, content: 'Why is humidity dropping?' });
    const create = fetchMock.calls.find((c) => c.method === 'POST' && c.url === '/api/ai/conversations');
    expect(create?.body).toMatchObject({ device_id: 'myco-sim-01' });
    // the reply is rendered with a friendly "offline" label and without the machine footer
    expect(await within(chat).findByText('From your stored data (AI offline)')).toBeInTheDocument();
    expect(within(chat).getByText(/Mostly fine/)).toBeInTheDocument();
    expect(within(chat).queryByText(/deterministic assistant/i)).not.toBeInTheDocument();
    // the cap's "Ask MYCO AI" button sends its question into the same embedded chat
    const cap = screen.getByRole('region', { name: 'Chamber climate' });
    await user.click(within(cap).getByRole('button', { name: /^Ask MYCO AI/ }));
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].conversationId).toBe(42);
    expect(sent[1].content).toMatch(/chamber/i);
    expect(screen.queryByRole('dialog', { name: /MYCO AI assistant/i })).not.toBeInTheDocument();
  });

  it('on the other pages the floating bubble opens the chat window and suggestion chips send a question', async () => {
    const user = userEvent.setup();
    const sent = installChatRoutes(fetchMock);
    renderApp(<App />, { route: '/stats' });
    await screen.findByRole('heading', { level: 1, name: 'Stats' });
    await user.click(screen.getByRole('button', { name: 'Ask MYCO AI' }));
    const drawer = await screen.findByRole('dialog', { name: /MYCO AI assistant/i });
    expect(within(drawer).getByText(/Hi, I’m MYCO AI/)).toBeInTheDocument();
    // the assistant status is explained in plain words (status fixture: provider configured)
    expect(within(drawer).getByText('MYCO AI is online')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: FIXTURES.aiSuggestions.questions[0] }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].content).toBe(FIXTURES.aiSuggestions.questions[0]);
    // the reply carried a fresh provider status (recorded without a key) and the label follows it
    expect(await within(drawer).findByText(/MYCO AI is offline/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Talking about/)).toHaveTextContent('simulated chamber');
    // escape closes it
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /MYCO AI assistant/i })).not.toBeInTheDocument());
  });

  it('"Ask MYCO AI" shortcuts on alerts and predictions pre-fill a question about that item', async () => {
    const user = userEvent.setup();
    const sent = installChatRoutes(fetchMock);
    const { unmount } = renderApp(<App />);
    const alert = FIXTURES.alerts.find((a) => a.status === 'active')!;
    await user.click((await screen.findAllByRole('button', { name: `Ask MYCO AI about ${alert.title}` }))[0]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].content).toContain(alert.title);
    unmount();
    renderApp(<App />, { route: '/predictions' });
    const anomaly = FIXTURES.anomalies.anomalies[0];
    await user.click(await screen.findByRole('button', { name: `Ask MYCO AI about ${anomaly.label}` }));
    const drawer = await screen.findByRole('dialog', { name: /MYCO AI assistant/i });
    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1].content).toContain(anomaly.label);
    expect(await within(drawer).findByText(/Mostly fine/)).toBeInTheDocument();
  });
});
