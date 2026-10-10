// A send that a guard turns away leaves a trace in the debug buffer (#809).
//
// The bug behind it: on a Windows runner a message sent right after the
// settings were saved never started a run, and nothing told which guard had
// stopped it. Checked here: every silent way out of sendChatMessage, and the
// send button's own changes, are recorded with their reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(t, { configured = true } = {}) {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { toolLogDebug } = await importRenderer('chat', 'toolLogDebug.js');

  const sends = [];
  const listeners = {};
  const state = { configured };
  const api = {
    onChatDelta: () => () => {},
    onChatProgress: (cb) => { listeners.progress = cb; return () => {}; },
    onChatToolLine: () => () => {},
    getChatHistory: async () => ({ sessions: [], activeChatId: null }),
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
    generateChatTitle: async () => ({ title: '' }),
    abortChat: () => {},
    chat: (messages, options) => new Promise((resolve) => sends.push({
      messages,
      options,
      resolve(result) {
        resolve(result);
        listeners.progress?.({ type: 'run-end', chatId: options?.chatId, runId: options?.runId });
      },
    })),
  };

  const chat = initChatStream({
    api,
    appStore,
    onInputChanged() {},
    stopChatVoiceListening() {},
    activeProviderConfigured: () => state.configured,
    activeProviderSupportsImages: () => false,
    syncLiveDot() {},
    syncChatTitle() {},
    onWorkspaceFileWritten() {},
    approvalCards: { mount() {}, beginRun() {}, retainChats() {}, pendingChatIds: () => new Set() },
  });

  appStore.chatRuns.clear();
  appStore.rootPath = '/ws';
  appStore.currentChatId = 'chat-a';
  appStore.currentChatWorkspace = '/ws';
  appStore.currentChatTitle = '';
  appStore.chatMessages = [];
  appStore.llmState = { chatTarget: { providerId: 'openai-compatible' }, providers: [], presets: [] };
  chat.renderChatMessages();
  toolLogDebug.clear();

  const input = document.getElementById('chat-input');
  async function send(text) {
    input.value = text;
    await chat.sendChatMessage();
  }
  const entries = (kind) => JSON.parse(toolLogDebug.serialize()).entries
    .filter((e) => e.kind === kind)
    .map((e) => e.data);

  return { chat, appStore, state, input, send, sends, entries };
}

test('a send refused for a provider that is not configured keeps its text and names the reason', async (t) => {
  const { send, sends, input, entries } = await mount(t, { configured: false });

  await send('Draw a header image.');

  assert.equal(sends.length, 0);
  assert.equal(input.value, 'Draw a header image.');
  assert.deepEqual(entries('send refused'), [
    { reason: 'provider not configured', chatId: 'chat-a', providerId: 'openai-compatible' },
  ]);
});

test('a send while the chat runs is recorded as refused, an empty input is not', async (t) => {
  const { send, sends, entries } = await mount(t);

  // The first send resolves only once its run is through.
  const first = send('First question');
  await flush();
  assert.equal(sends.length, 1);
  await send('Second question');
  assert.equal(sends.length, 1);
  assert.deepEqual(entries('send refused').map((e) => e.reason), ['run in flight']);

  sends[0].resolve({ ok: true, text: 'Done.' });
  await first;
  await send('   ');
  assert.deepEqual(entries('send refused').map((e) => e.reason), ['run in flight']);
});

test('the send button records when it turns disabled and back', async (t) => {
  const { chat, state, entries } = await mount(t);

  chat.syncChatSendButton();
  state.configured = false;
  chat.syncChatSendButton();
  chat.syncChatSendButton();
  state.configured = true;
  chat.syncChatSendButton();

  assert.equal(document.getElementById('btn-chat-send').disabled, false);
  assert.deepEqual(entries('send button').slice(-3), [
    { inFlight: false, disabled: false },
    { inFlight: false, disabled: true },
    { inFlight: false, disabled: false },
  ]);
});
