// The window follows a turn it did not start (#1194, step 2b).
//
// A phone writes into a chat; main runs the turn and tells the window with
// `chat:turn-started` once the question is saved, then sends the turn's
// events on the channels the window's own turns use. Checked here: the
// question and the streaming answer show in the chat on screen, a chat off
// screen carries the turn until it is opened, the window can stop it, and
// at `run-end` the chat on screen is drawn from what main saved.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function mount() {
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const listeners = {};
  const aborted = [];
  const begun = [];
  /** What main has saved, by chat id. */
  const saved = new Map();
  const api = {
    onChatDelta: (cb) => { listeners.delta = cb; return () => {}; },
    onChatProgress: (cb) => { listeners.progress = cb; return () => {}; },
    onChatToolLine: (cb) => { listeners.toolLine = cb; return () => {}; },
    onChatTurnStarted: (cb) => { listeners.turnStarted = cb; return () => {}; },
    getChatHistory: async () => ({ sessions: [], activeChatId: null }),
    getChatSession: async (id) => (saved.has(id) ? { session: structuredClone(saved.get(id)) } : { session: null }),
    setActiveChatId: async () => {},
    writeClipboardText: async () => ({ ok: true }),
    abortChat: (chatId) => { aborted.push(chatId); },
    chat: () => new Promise(() => {}),
  };

  const chat = initChatStream({
    api,
    appStore,
    onInputChanged() {},
    stopChatVoiceListening() {},
    activeProviderConfigured: () => true,
    activeProviderSupportsImages: () => true,
    syncLiveDot() {},
    syncChatTitle() {},
    onWorkspaceFileWritten() {},
    approvalCards: { mount() {}, beginRun: (chatId) => begun.push(chatId), retainChats() {}, pendingChatIds: () => new Set() },
    onRunsChanged() {},
  });

  appStore.chatRuns.clear();
  appStore.rootPath = '/ws';
  appStore.currentChatId = 'chat-a';
  appStore.currentChatWorkspace = '/ws';
  appStore.currentChatTitle = 'Chat A';
  appStore.chatMessages = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }];
  chat.renderChatMessages();

  const screenText = () => document.getElementById('chat-messages').textContent;
  const started = (chatId, runId, content) => listeners.turnStarted({ chatId, runId, content });
  const emit = (channel, chatId, runId, payload) => listeners[channel]({ ...payload, chatId, runId });
  const end = (chatId, runId) => listeners.progress({ type: 'run-end', chatId, runId });

  async function cleanup() {
    for (const [chatId, run] of appStore.chatRuns) end(chatId, run.runId);
    await flush();
    await flush();
    dom.cleanup();
  }

  return { dom: { cleanup }, chat, appStore, saved, aborted, begun, screenText, started, emit, end };
}

test('a phone\'s turn in the chat on screen shows its question and streams its answer', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, screenText, started, emit, begun } = env;

  started('chat-a', 'run-phone', 'Question from the phone');
  assert.match(screenText(), /Earlier answer/);
  assert.match(screenText(), /Question from the phone/);
  assert.equal(chat.runs.stateOf('chat-a'), 'running');
  assert.equal(appStore.chatInFlight, true, 'the composer shows the turn running');
  assert.deepEqual(begun, ['chat-a'], 'its cards belong to its answer');

  emit('delta', 'chat-a', 'run-phone', { text: 'Streaming ' });
  emit('delta', 'chat-a', 'run-phone', { text: 'answer' });
  await nextFrame();
  await nextFrame();
  assert.match(screenText(), /Streaming answer/);
  // An event of another run finds nothing.
  emit('delta', 'chat-a', 'run-other', { text: 'stray' });
  await nextFrame();
  await nextFrame();
  assert.doesNotMatch(screenText(), /stray/);
});

test('at run-end the chat on screen is drawn from what main saved', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, saved, screenText, started, emit, end } = env;

  started('chat-a', 'run-phone', 'Question from the phone');
  emit('delta', 'chat-a', 'run-phone', { text: 'Partial' });
  saved.set('chat-a', {
    id: 'chat-a',
    workspaceRoot: '/ws',
    title: 'Named by main',
    messages: [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'user', content: 'Question from the phone' },
      { role: 'assistant', content: 'The whole answer, as main saved it.' },
    ],
  });
  end('chat-a', 'run-phone');
  await flush();
  await flush();
  assert.equal(chat.runs.stateOf('chat-a'), null);
  assert.equal(appStore.chatInFlight, false);
  assert.match(screenText(), /The whole answer, as main saved it\./);
  assert.doesNotMatch(screenText(), /Partial/);
  assert.equal(appStore.currentChatTitle, 'Named by main');
});

test('a phone\'s turn in a chat off screen runs there, and opening the chat shows it running', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, saved, screenText, started, emit } = env;
  saved.set('chat-b', {
    id: 'chat-b',
    workspaceRoot: '/ws',
    title: 'Chat B',
    messages: [
      { role: 'user', content: 'Older in B' },
      { role: 'assistant', content: 'Older answer in B' },
      { role: 'user', content: 'Phone asks in B' },
      { role: 'assistant', content: '', interrupted: true },
    ],
  });

  started('chat-b', 'run-b', 'Phone asks in B');
  await flush();
  assert.equal(chat.runs.stateOf('chat-b'), 'running', 'the history column can mark it');
  assert.equal(appStore.chatInFlight, false, 'the chat on screen is free');
  emit('delta', 'chat-b', 'run-b', { text: 'Working in B' });
  await flush();
  assert.doesNotMatch(screenText(), /Phone asks in B|Working in B/, 'nothing of B reaches the chat on screen');

  // Opened, as the history column does it: from the run, not from disk.
  assert.equal(chat.runs.canAttach('chat-b'), true);
  chat.runs.detach();
  assert.equal(chat.runs.attach('chat-b'), true);
  chat.runs.syncComposer();
  chat.renderChatMessages();
  assert.match(screenText(), /Older answer in B/);
  assert.match(screenText(), /Phone asks in B/);
  assert.match(screenText(), /Working in B/);
  assert.equal(appStore.chatInFlight, true);
  assert.equal(appStore.currentChatTitle, 'Chat B');
});

test('the window stops a turn it follows', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { appStore, aborted, started } = env;

  started('chat-a', 'run-phone', 'Question from the phone');
  document.getElementById('btn-chat-send').click();
  assert.deepEqual(aborted, ['chat-a']);
  assert.equal(appStore.chatInFlight, false);
});

test('a turn in a chat the window is running itself, or without ids, is not followed', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, started } = env;

  started('chat-a', '', 'no run id');
  started('', 'run-x', 'no chat id');
  assert.equal(appStore.chatRuns.size, 0);

  started('chat-a', 'run-1', 'first');
  const first = appStore.chatRuns.get('chat-a');
  started('chat-a', 'run-2', 'second');
  assert.equal(appStore.chatRuns.get('chat-a'), first, 'the running turn keeps its chat');
  assert.equal(chat.runs.stateOf('chat-a'), 'running');
});
