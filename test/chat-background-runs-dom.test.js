// Runs per chat in the renderer (#320).
//
// The bug: open another chat while a run is working, and the run looked dead.
// Its events went to "the last message on screen", its result was thrown away,
// and the chat was left with whatever it showed at the moment of the switch.
// Checked here: the run follows its own chat — off screen and back.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount() {
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const listeners = {};
  const sends = [];
  const upserts = [];
  const activeIds = [];
  const aborted = [];
  const runsChanged = [];
  const api = {
    onChatDelta: (cb) => { listeners.delta = cb; return () => {}; },
    onChatProgress: (cb) => { listeners.progress = cb; return () => {}; },
    onChatToolLine: (cb) => { listeners.toolLine = cb; return () => {}; },
    getChatHistory: async () => ({ sessions: [], activeChatId: null }),
    setActiveChatId: async (id) => { activeIds.push(id); },
    upsertChatSession: async (row) => {
      upserts.push(structuredClone(row));
      return { ok: true };
    },
    generateChatTitle: async () => ({ title: '' }),
    writeClipboardText: async () => ({ ok: true }),
    abortChat: (chatId) => { aborted.push(chatId); },
    chat: (messages, options) =>
      new Promise((resolve) => {
        const send = { messages, options, settled: false };
        send.resolve = (result) => { send.settled = true; resolve(result); };
        sends.push(send);
      }),
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
    approvalCards: { mount() {}, beginRun() {}, retainChats() {}, pendingChatIds: () => new Set() },
    onRunsChanged: () => runsChanged.push([...appStore.chatRuns.keys()]),
  });

  appStore.chatRuns.clear();
  appStore.rootPath = '/ws';
  appStore.currentChatId = 'chat-a';
  appStore.currentChatWorkspace = '/ws';
  appStore.currentChatTitle = '';
  appStore.chatMessages = [];
  chat.renderChatMessages();

  function ask(text) {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }

  /** An event as main sends it: named after the chat and run it belongs to. */
  function emitDelta(send, text, overrides = {}) {
    listeners.delta({ text, chatId: send.options.chatId, runId: send.options.runId, ...overrides });
  }

  function screenText() {
    return document.getElementById('chat-messages').textContent;
  }

  /** Any event, as main sends it for this run. */
  function emit(channel, send, payload) {
    listeners[channel]({ ...payload, chatId: send.options.chatId, runId: send.options.runId });
  }

  // A test that fails half-way would leave its run open — and the thinking
  // ticker with it, which keeps the file from ever finishing.
  async function cleanup() {
    for (const send of sends) if (!send.settled) send.resolve({ cancelled: true, content: '', toolTrace: [] });
    await flush();
    await flush();
    dom.cleanup();
  }

  return { dom: { cleanup }, chat, appStore, api, sends, upserts, activeIds, aborted, runsChanged, ask, emit, emitDelta, screenText };
}

test('a run goes on when another chat is opened, and writes its answer into its own chat', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, sends, upserts, ask, emitDelta, screenText } = env;

  ask('Check the docs folder.');
  await flush();
  assert.equal(sends.length, 1);
  const run = sends[0];
  assert.equal(run.options.chatId, 'chat-a');
  assert.ok(run.options.runId, 'the turn carries a run id');
  emitDelta(run, 'Looking');
  assert.equal(chat.runs.stateOf('chat-a'), 'running');

  await chat.startNewChat();
  const newChatId = appStore.currentChatId;
  assert.notEqual(newChatId, 'chat-a');
  assert.equal(appStore.chatInFlight, false, 'the new chat can be written in right away');
  assert.equal(chat.runs.stateOf('chat-a'), 'running', 'still working in the background');

  emitDelta(run, ' through the files');
  assert.doesNotMatch(screenText(), /through the files/, 'nothing of chat A reaches the chat on screen');

  upserts.length = 0;
  env.activeIds.length = 0;
  run.resolve({ content: 'Two dead links.', toolTrace: [] });
  await flush();
  await flush();

  const written = upserts.find((row) => row.id === 'chat-a');
  assert.ok(written, 'the answer is written into chat A');
  assert.deepEqual(written.messages.map((m) => m.content), ['Check the docs folder.', 'Two dead links.']);
  assert.equal(written.workspaceRoot, '/ws');
  assert.equal(appStore.currentChatId, newChatId, 'the screen stays where the user is');
  assert.equal(chat.runs.stateOf('chat-a'), null);
  assert.equal(appStore.chatRuns.size, 0);
  assert.deepEqual(env.activeIds, [], 'a background answer does not make chat A the folder\'s active chat again');
});

test('opening a running chat again shows what it did in the meantime', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, sends, ask, emitDelta, screenText } = env;

  ask('Draft the release notes.');
  await flush();
  const run = sends[0];
  emitDelta(run, 'Draft ');
  await chat.startNewChat();
  emitDelta(run, 'in progress');

  chat.runs.detach();
  assert.equal(chat.runs.attach('chat-a'), true);
  chat.renderChatMessages();
  chat.runs.afterSwitch();

  assert.equal(appStore.currentChatId, 'chat-a');
  assert.equal(appStore.chatInFlight, true, 'the stop button is back');
  assert.match(screenText(), /Draft in progress/);

  run.resolve({ content: 'Draft in progress — done.', toolTrace: [] });
  await flush();
  await flush();
  assert.match(screenText(), /done\./);
  assert.equal(appStore.chatInFlight, false);
});

test('two chats can run at once; stop only stops the chat on screen', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, sends, aborted, ask } = env;

  ask('First question.');
  await flush();
  await chat.startNewChat();
  const chatB = appStore.currentChatId;
  ask('Second question.');
  await flush();
  assert.equal(sends.length, 2);
  assert.equal(sends[1].options.chatId, chatB);
  assert.equal(chat.runs.stateOf('chat-a'), 'running');
  assert.equal(chat.runs.stateOf(chatB), 'running');

  document.getElementById('btn-chat-send').click(); // now the stop button
  assert.deepEqual(aborted, [chatB]);
  assert.equal(chat.runs.stateOf('chat-a'), 'running', 'the other chat keeps working');

  sends[1].resolve({ cancelled: true, content: '', toolTrace: [] });
  sends[0].resolve({ content: 'Answer A.', toolTrace: [] });
  await flush();
  await flush();
  assert.equal(appStore.chatRuns.size, 0);
});

test('a late event of an earlier turn finds nothing to write into', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { appStore, sends, ask, emitDelta } = env;

  ask('Question.');
  await flush();
  emitDelta(sends[0], 'stale', { runId: 'some-older-run' });
  emitDelta(sends[0], 'fresh');
  const last = appStore.chatMessages[appStore.chatMessages.length - 1];
  assert.equal(last.content, 'fresh');
  sends[0].resolve({ content: 'fresh', toolTrace: [] });
  await flush();
});

test('deleting a running chat stops it, and its answer does not bring it back', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, sends, upserts, aborted, ask } = env;

  ask('Question.');
  await flush();
  await chat.startNewChat();
  chat.runs.discard('chat-a');
  assert.deepEqual(aborted, ['chat-a']);
  assert.equal(appStore.chatRuns.has('chat-a'), false);

  upserts.length = 0;
  sends[0].resolve({ cancelled: true, content: '', toolTrace: [] });
  await flush();
  await flush();
  assert.equal(upserts.some((row) => row.id === 'chat-a'), false);
});

test('a step waiting for an approval still says so when its chat is opened again', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, sends, ask, emit } = env;

  ask('Remember something.');
  await flush();
  const run = sends[0];
  emit('toolLine', run, { phase: 'start', line: 'Running remember …', tool: 'remember', callIndex: 0 });
  emit('progress', run, { type: 'permission', event: 'awaiting', callIndex: 0, tool: 'remember' });

  const runningRow = () => document.querySelector('#chat-messages .chat-msg.assistant:last-of-type .chat-tool-lines > .chat-tool-line--running');
  const before = { text: runningRow()?.textContent, permission: runningRow()?.dataset.permission };
  assert.equal(before.permission, 'awaiting');

  await chat.startNewChat();
  chat.runs.detach();
  chat.runs.attach('chat-a');
  chat.renderChatMessages();
  chat.runs.afterSwitch();

  const row = runningRow();
  assert.ok(row, 'the step is still running, not done');
  assert.equal(row.dataset.permission, 'awaiting');
  assert.equal(row.textContent, before.text, 'and reads exactly as before the switch');
  assert.equal(row.dataset.callIndex, '0', 'so that the answer to the card finds its row');

  run.resolve({ content: 'Done.', toolTrace: [] });
  await flush();
  await flush();
});
