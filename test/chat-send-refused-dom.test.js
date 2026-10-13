// A send that a guard turns away leaves a trace in the debug buffer (#809),
// and one that throws before its run is under way gives its draft back (#919).
//
// The bug behind it: on a Windows runner a message sent right after the
// settings were saved never started a run, and nothing told which guard had
// stopped it. Checked here: every silent way out of sendChatMessage, and the
// send button's own changes, are recorded with their reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount(t, { configured = true, beginRun = () => {} } = {}) {
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
    approvalCards: { mount() {}, beginRun, retainChats() {}, pendingChatIds: () => new Set() },
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

test('a send that throws before its run starts gives the draft back and records why (#919)', async (t) => {
  let failures = 1;
  const { chat, appStore, send, sends, input, entries } = await mount(t, {
    beginRun() {
      if (failures > 0) {
        failures -= 1;
        throw new Error('card queue broken');
      }
    },
  });
  const logged = [];
  const consoleError = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  t.after(() => { console.error = consoleError; });

  await send('Read the page MARK-A');

  assert.equal(sends.length, 0, 'no request left');
  assert.equal(input.value, 'Read the page MARK-A');
  assert.equal(appStore.chatInFlight, false);
  assert.equal(appStore.chatRuns.has('chat-a'), false);
  assert.deepEqual(appStore.chatMessages, []);
  assert.equal(document.querySelectorAll('#chat-messages .chat-msg').length, 0);
  assert.deepEqual(entries('send failed').map((e) => e.message), ['card queue broken']);
  assert.match(logged.join('\n'), /\[chat\] send failed: Error: card queue broken/);
  assert.equal(document.getElementById('chat-token-usage-value').textContent, 'Not sent');

  // The next try goes through.
  const second = send(input.value);
  await flush();
  assert.equal(sends.length, 1);
  assert.equal(input.value, '');
  sends[0].resolve({ ok: true, text: 'Done.' });
  await second;
  assert.deepEqual(chat && appStore.chatMessages.map((m) => m.role), ['user', 'assistant']);
});

test('a draft typed over meanwhile is not overwritten by the failed one (#919)', async (t) => {
  const { send, input } = await mount(t, {
    beginRun() {
      input.value = 'typed meanwhile';
      throw new Error('broken');
    },
  });
  const consoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = consoleError; });

  await send('first');
  assert.equal(input.value, 'typed meanwhile');
});
