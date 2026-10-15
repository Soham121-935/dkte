/**
 * The AI must be reachable from everywhere and the home page must explain the
 * chamber in plain words. These tests drive the real App through the recorded
 * fixtures: briefing card, ask box → drawer → POST message, status labels,
 * "Ask AI" shortcuts and the simple/detailed view switch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from '@/App';
import { tokenStore } from '@/api/client';
import { FIXTURES, WebSocketStub, installFetchMock, json, renderApp, type FetchMock } from '@/test/helpers';
import { VIEW_MODE_KEY } from '@/providers/ViewModeProvider';

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
    localStorage.removeItem(VIEW_MODE_KEY);
  });
  afterEach(() => {
    fetchMock.restore();
    vi.unstubAllGlobals();
    tokenStore.set(null);
    localStorage.removeItem(VIEW_MODE_KEY);
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

  it('asks MYCO AI from the home page: the drawer opens and the question is sent in the device context', async () => {
    const user = userEvent.setup();
    const sent = installChatRoutes(fetchMock);
    renderApp(<App />);
    await screen.findByText(FIXTURES.aiInsight.headline);
    await user.type(screen.getByLabelText('Ask MYCO AI', { selector: 'input' }), 'Why is humidity dropping?');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    const drawer = await screen.findByRole('dialog', { name: /MYCO AI assistant/i });
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ conversationId: 42, content: 'Why is humidity dropping?' });
    const create = fetchMock.calls.find((c) => c.method === 'POST' && c.url === '/api/ai/conversations');
    expect(create?.body).toMatchObject({ device_id: 'myco-sim-01' });
    // the reply is rendered with a friendly "offline" label and without the machine footer
    expect(await within(drawer).findByText('From your stored data (AI offline)')).toBeInTheDocument();
    expect(within(drawer).getByText(/Mostly fine/)).toBeInTheDocument();
    expect(within(drawer).queryByText(/deterministic assistant/i)).not.toBeInTheDocument();
    expect(within(drawer).getByText(/Talking about/)).toHaveTextContent('simulated chamber');
    // escape closes it
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /MYCO AI assistant/i })).not.toBeInTheDocument());
  });

  it('the floating bubble opens the assistant on any page and suggestion chips send a question', async () => {
    const user = userEvent.setup();
    const sent = installChatRoutes(fetchMock);
    renderApp(<App />, { route: '/monitoring' });
    await screen.findByRole('heading', { level: 1, name: 'Live Monitoring' });
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
  });

  it('"Ask AI" shortcuts on alerts pre-fill a question about that alert', async () => {
    const user = userEvent.setup();
    const sent = installChatRoutes(fetchMock);
    renderApp(<App />);
    const alert = FIXTURES.alerts[0];
    await user.click((await screen.findAllByRole('button', { name: `Ask MYCO AI about ${alert.title}` }))[0]);
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].content).toContain(alert.title);
  });

  it('the simple/detailed switch hides and reveals engineering details and is remembered', async () => {
    const user = userEvent.setup();
    renderApp(<App />);
    await screen.findByText(FIXTURES.aiInsight.headline);
    const select = screen.getAllByLabelText('Select device')[0] as HTMLSelectElement;
    expect(select.options[0].text).not.toContain('(myco-sim-01)');
    expect(screen.queryByText(/Server time/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'detailed' }));
    await waitFor(() => expect(select.options[0].text).toContain('(myco-sim-01)'));
    expect(screen.getByText('Server time')).toBeInTheDocument();
    expect(screen.getByText('Device id')).toBeInTheDocument();
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('detailed');
    await user.click(screen.getByRole('radio', { name: 'simple' }));
    await waitFor(() => expect(screen.queryByText('Server time')).not.toBeInTheDocument());
    expect(localStorage.getItem(VIEW_MODE_KEY)).toBe('simple');
  });

  it('the full assistant page uses the shared chat, explains the AI status and keeps technical stats behind a toggle', async () => {
    const user = userEvent.setup();
    const sent = installChatRoutes(fetchMock);
    renderApp(<App />, { route: '/assistant' });
    await screen.findByRole('heading', { level: 1, name: 'AI Cultivation Assistant' });
    // the floating bubble is not shown here – the page itself is the assistant
    expect(screen.queryByRole('button', { name: 'Ask MYCO AI' })).not.toBeInTheDocument();
    // existing conversations are listed with the chamber name instead of the device id
    expect(await screen.findByText(FIXTURES.conversations[0].title)).toBeInTheDocument();
    const tech = screen.getByRole('button', { name: /AI connection/ });
    expect(screen.queryByText('Rate limit')).not.toBeInTheDocument();
    await user.click(tech);
    expect(screen.getByText('Rate limit')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Ask MYCO AI', { selector: 'textarea' }), 'What changed today?{Enter}');
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ conversationId: FIXTURES.conversations[0].id, content: 'What changed today?' });
  });
});
