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

// The composer during a switch (#411). A switch changes the chat on screen and
// then waits on IPC — `setActiveChatId`, `activateChatSession`. The send button
// used to follow only after those round trips, so the new chat showed the old
// one's stop button for as long as they took. Here the first round trip is
// held open, and the button is looked at while it is.

/** An IPC call that returns only once the test lets it — for the ids `holds` picks. */
function gatedCall(holds = () => true) {
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  const call = { reached: false, open };
  call.fn = async (id) => {
    if (!holds(id)) return;
    call.reached = true;
    await opened;
  };
  return call;
}

async function until(condition) {
  for (let i = 0; i < 20 && !condition(); i += 1) await flush();
  assert.ok(condition(), 'the switch got as far as its first round trip');
}

const stopShown = () => document.getElementById('btn-chat-send').classList.contains('chat-send--stop');

async function mountHistoryPanel(env, { setActiveChatId }) {
  const { initChatHistoryPanel } = await importRenderer('components', 'ChatHistoryPanel.js');
  return initChatHistoryPanel({
    api: {
      getChatHistory: async () => ({ sessions: [], activeChatId: null }),
      setActiveChatId,
      setUIPrefs: async () => ({ ok: true }),
      deleteChatSession: async () => ({ ok: true }),
    },
    appStore: env.appStore,
    stopChatVoiceListening() {},
    persistCurrentChat: async () => {},
    renderChatMessages: env.chat.renderChatMessages,
    updateChatChrome() {},
    onInputChanged() {},
    setChatTokenUsage() {},
    resetChatTokenUsage() {},
    seedGreetingIfWorkspace() {},
    onNewChatStarted: async () => {},
    runs: env.chat.runs,
  });
}

test('a new chat is free to write in before its round trips return (#411)', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, api, appStore, ask } = env;

  ask('Check the docs folder.');
  await flush();
  assert.equal(stopShown(), true, 'chat A shows its stop button');

  // Saving chat A on the way out marks it active first; the new chat's own
  // call is the one with no id.
  const ipc = gatedCall((id) => id === null);
  api.setActiveChatId = ipc.fn;
  const switching = chat.startNewChat();
  await until(() => ipc.reached);
  assert.notEqual(appStore.currentChatId, 'chat-a');
  assert.equal(stopShown(), false, 'the new chat does not wear chat A\'s stop button');
  assert.equal(appStore.chatInFlight, false);

  ipc.open();
  await switching;
  assert.equal(stopShown(), false);
  assert.equal(chat.runs.stateOf('chat-a'), 'running', 'chat A keeps working meanwhile');
});

test('opening a running chat shows its stop button before the round trips return (#411)', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, ask } = env;

  ask('Draft the release notes.');
  await flush();
  await chat.startNewChat();
  assert.equal(stopShown(), false);

  const ipc = gatedCall();
  const panel = await mountHistoryPanel(env, { setActiveChatId: ipc.fn });
  const opening = panel.openChatSession('chat-a');
  await until(() => ipc.reached);
  assert.equal(appStore.currentChatId, 'chat-a');
  assert.equal(stopShown(), true, 'chat A can be stopped the moment it is on screen');

  ipc.open();
  await opening;
  assert.equal(stopShown(), true);
});

test('opening another folder frees the composer before the round trips return (#411)', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, api, appStore, ask } = env;

  ask('Check the docs folder.');
  await flush();
  assert.equal(stopShown(), true);

  api.getChatHistory = async () => ({
    sessions: [{
      id: 'chat-b',
      workspaceRoot: '/other',
      updatedAt: 1,
      messages: [{ role: 'user', content: 'Earlier.' }, { role: 'assistant', content: 'Answer.' }],
    }],
    activeChatId: null,
  });
  // The restored chat becomes the folder's active one — that is the call held.
  const ipc = gatedCall((id) => id === 'chat-b');
  api.setActiveChatId = ipc.fn;
  const loading = chat.loadChatForWorkspace('/other');
  await until(() => ipc.reached);
  assert.equal(appStore.currentChatId, 'chat-b');
  assert.equal(stopShown(), false, 'the restored chat does not wear chat A\'s stop button');

  ipc.open();
  await loading;
  assert.equal(stopShown(), false);
  assert.equal(chat.runs.stateOf('chat-a'), 'running', 'chat A keeps working in the background');
});

// #538: a round that was cut off keeps the text it streamed; the reason
// follows as a message of its own, and only the reason is left out of the
// history the model sees next time.
test('a cut-off answer keeps its text and shows the reason below it (#538)', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { appStore, sends, ask, emitDelta, screenText } = env;

  ask('Write the summary.');
  await flush();
  emitDelta(sends[0], 'The first half of the summary');
  sends[0].resolve({ error: 'The answer was cut off.', code: 'INCOMPLETE', partial: true });
  await flush();
  await flush();

  assert.deepEqual(
    appStore.chatMessages.map((m) => [m.content, !!m.isError]),
    [
      ['Write the summary.', false],
      ['The first half of the summary', false],
      ['The answer was cut off.', true],
    ]
  );
  assert.match(screenText(), /The first half of the summary/);
  const error = document.querySelector('#chat-messages .chat-msg.assistant.error');
  assert.equal(error?.querySelector('.chat-msg-text')?.textContent, 'The answer was cut off.');
  assert.equal(error?.querySelector('.chat-msg-error-prefix')?.textContent, 'Error:');
});

test('an error without partial keeps removing the half answer, as before', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { appStore, sends, ask, emitDelta } = env;

  ask('Write the summary.');
  await flush();
  emitDelta(sends[0], 'Half');
  sends[0].resolve({ error: 'rate limited', code: 'API' });
  await flush();
  await flush();

  assert.deepEqual(appStore.chatMessages.map((m) => m.content), ['Write the summary.', 'rate limited']);
});

// A send while the screen changes chats (#721). The tree is drawn before the
// folder's chat is loaded, so a question could be sent into the chat about to
// be swapped out — at start-up into one with no id that was never saved. The
// run went on there unseen, and the screen showed only the greeting.

const composerText = () => document.getElementById('chat-input').value;

test('a question sent before the first chat is loaded goes into that chat (#721)', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, sends, upserts, ask, screenText } = env;
  // As at start-up: the tree is there, no chat is yet.
  appStore.currentChatId = '';
  appStore.currentChatWorkspace = null;

  ask('Summarise the documents.');
  await flush();
  assert.equal(sends.length, 0, 'no run without the chat it belongs to');
  assert.equal(composerText(), '', 'the draft is taken all the same');

  await chat.loadChatForWorkspace('/ws');
  await flush();

  assert.equal(sends.length, 1);
  assert.ok(appStore.currentChatId, 'the folder\'s chat is on screen');
  assert.equal(sends[0].options.chatId, appStore.currentChatId, 'the run belongs to the chat on screen');
  assert.match(screenText(), /Summarise the documents\./);
  assert.ok(upserts.some((row) => row.id === appStore.currentChatId
    && row.messages.some((m) => m.content === 'Summarise the documents.')), 'the question is saved with its chat');
  assert.equal(chat.runs.stateOf(''), null, 'nothing runs in a chat without an id');
});

test('a question sent during a folder switch waits for the new folder\'s chat (#721)', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, sends, upserts, ask, screenText } = env;

  // As FileTree does once main has switched: the new tree is drawn, the old
  // folder's chat is still on screen.
  const release = chat.runs.holdSwitch();
  appStore.rootPath = '/other';
  ask('List the files.');
  await flush();
  assert.equal(sends.length, 0);

  await chat.loadChatForWorkspace('/other');
  await flush();
  assert.equal(sends.length, 0, 'still held until the folder switch is through');
  release();
  await flush();

  assert.equal(sends.length, 1);
  assert.notEqual(sends[0].options.chatId, 'chat-a', 'not in the old folder\'s chat');
  assert.equal(sends[0].options.chatId, appStore.currentChatId);
  assert.equal(appStore.currentChatWorkspace, '/other');
  assert.match(screenText(), /List the files\./);
  assert.ok(!upserts.some((row) => row.id === 'chat-a'
    && row.messages.some((m) => m.content === 'List the files.')), 'chat A never got the question');
});

test('a waiting draft goes back to the composer when the chat that comes up is running (#721)', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, appStore, sends, ask } = env;
  const history = await mountHistoryPanel(env, { setActiveChatId: async () => {} });

  ask('Draft the release notes.');
  await flush();
  await chat.startNewChat();
  assert.equal(sends.length, 1);

  // Chat A is opened from the history while the question waits.
  const release = chat.runs.holdSwitch();
  ask('And the changelog?');
  await flush();
  assert.equal(composerText(), '');
  await history.openChatSession('chat-a');
  release();
  await flush();

  assert.equal(appStore.currentChatId, 'chat-a');
  assert.equal(appStore.chatInFlight, true, 'chat A is still running');
  assert.equal(sends.length, 1, 'no second run in a running chat');
  assert.equal(composerText(), 'And the changelog?', 'the draft is back in the composer');
});

test('a second send while a draft waits for its chat is not taken (#721)', async (t) => {
  const env = await mount();
  t.after(env.dom.cleanup);
  const { chat, sends, ask, screenText } = env;

  const release = chat.runs.holdSwitch();
  ask('First question');
  await flush();
  ask('Second question');
  await flush();
  assert.equal(composerText(), 'Second question', 'the second draft stays where it is');

  release();
  await flush();
  assert.equal(sends.length, 1);
  assert.match(screenText(), /First question/);
  assert.doesNotMatch(screenText(), /Second question/);
});
