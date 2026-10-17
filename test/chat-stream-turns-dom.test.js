// What happens around a turn in the chat stream — findings of the B11 review.
//
//   * The list follows new output only while the user is at its end (#587).
//   * A chat or folder switch empties the whole composer, images included (#588).
//   * Images still being prepared hold their slot, and Send waits for them (#589).
//   * A finished tool step drops the workspace image cache (#590).
//   * Error bubbles carry their prefix from the catalogue (#591).
//   * A turn's outcome is announced once; a redraw announces nothing (#592).
//   * A run never draws into another chat's list (#593).
//   * Smaller ones from the bundle (#595): sizes by locale, the folder name.
//   * A running turn is saved after every finished step; one cut off comes
//     back marked as interrupted (#979).
//   * A streaming answer renders only its open block on each frame, and a
//     finished answer is rendered once and copied on the next redraw (#998).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom } = require('./helpers/dom.js');
const { fakeChatHistoryApi } = require('./helpers/chat-history-api.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
// happy-dom runs animation frames on a timer of its own.
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await flush();
  }
  assert.fail(`timed out waiting for ${what}`);
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function mount({
  history = { sessions: [], activeChatId: null },
  activateChatSession,
  readWorkspaceImage,
  imageLimit = null,
  upsertChatSession = null,
} = {}) {
  const dom = setupRendererDom();
  // The image intake reads files as data URLs; the helper does not hand it out.
  globalThis.FileReader = dom.window.FileReader;
  // A real `marked`, so that `![x](y)` becomes an <img>; DOMPurify passes
  // through — sanitizing is checked in real Chromium (e2e/smoke.test.mjs).
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };
  const { clearWorkspaceImageCache } = await importRenderer('chat', 'workspaceImages.js');
  clearWorkspaceImageCache();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });

  const listeners = {};
  const sends = [];
  const imageReads = [];
  // What each save sent, as IPC would carry it: copied at the call.
  const saves = [];
  const api = {
    onChatDelta: (cb) => { listeners.delta = cb; return () => {}; },
    onChatProgress: (cb) => { listeners.progress = cb; return () => {}; },
    onChatToolLine: (cb) => { listeners.toolLine = cb; return () => {}; },
    ...fakeChatHistoryApi(() => history?.sessions, { activeChatId: () => history?.activeChatId ?? null }),
    setActiveChatId: async () => {},
    upsertChatSession: async (row) => {
      saves.push(JSON.parse(JSON.stringify(row)));
      return upsertChatSession ? upsertChatSession(row) : { ok: true };
    },
    generateChatTitle: async () => ({ title: '' }),
    abortChat: () => {},
    readWorkspaceImage: async (src) => {
      imageReads.push(src);
      return readWorkspaceImage
        ? readWorkspaceImage(src, imageReads.length)
        : { ok: true, mime: 'image/png', base64: 'AAAA' };
    },
    chat: (messages, options) =>
      new Promise((resolve) => {
        const send = { messages, options, settled: false };
        // The reply and main's end marker, apart or together: the reply can
        // overtake the events, the marker comes behind the last one (#721).
        send.reply = (result) => { send.settled = true; resolve(result); };
        send.end = () => listeners.progress?.({ type: 'run-end', chatId: options?.chatId, runId: options?.runId });
        send.resolve = (result) => { send.reply(result); send.end(); };
        sends.push(send);
      }),
  };

  const chat = initChatStream({
    api,
    appStore,
    onInputChanged() {},
    stopChatVoiceListening() {},
    activeProviderConfigured: () => true,
    activeProviderSupportsImages: () => imageLimit === null,
    activeImageLimit: () => imageLimit,
    syncLiveDot() {},
    syncChatTitle() {},
    onWorkspaceFileWritten() {},
    approvalCards: { mount() {}, beginRun() {}, retainChats() {}, pendingChatIds: () => new Set() },
    ...(activateChatSession ? { activateChatSession } : {}),
  });

  appStore.chatRuns.clear();
  appStore.rootPath = '/ws';
  appStore.currentChatId = 'chat-a';
  appStore.currentChatWorkspace = '/ws';
  appStore.currentChatTitle = '';
  appStore.chatMessages = [];
  chat.renderChatMessages();

  const list = document.getElementById('chat-messages');
  const input = document.getElementById('chat-input');

  function ask(text) {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }

  function emit(channel, send, payload) {
    listeners[channel]({ ...payload, chatId: send.options.chatId, runId: send.options.runId });
  }

  function paste(name = 'shot.png') {
    const file = new File([new Uint8Array([1, 2, 3, 4])], name, { type: 'image/png' });
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { items: [{ kind: 'file', getAsFile: () => file }] },
    });
    input.dispatchEvent(event);
  }

  const chips = () => document.querySelectorAll('#chat-attachments .chat-attachment-chip').length;

  /** Fakes the list's geometry: happy-dom has no layout. */
  function layout({ scrollHeight, clientHeight = 200 }) {
    Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => scrollHeight });
    Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => clientHeight });
  }

  function scrollTo(top) {
    list.scrollTop = top;
    list.dispatchEvent(new Event('scroll'));
  }

  async function cleanup() {
    for (const send of sends) if (!send.settled) send.resolve({ cancelled: true, content: '', toolTrace: [] });
    await flush();
    await flush();
    delete globalThis.createImageBitmap;
    delete globalThis.FileReader;
    dom.cleanup();
  }

  return { cleanup, chat, appStore, sends, saves, imageReads, list, input, ask, emit, paste, chips, layout, scrollTo, setLocale };
}

// --- #587 ---------------------------------------------------------------------

test('a user who scrolled up during a run stays where they are (#587)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { list, sends, ask, emit, layout, scrollTo } = env;

  ask('Explain the build.');
  await flush();
  layout({ scrollHeight: 1000 });
  scrollTo(100);

  emit('delta', sends[0], { text: 'The build starts with' });
  await nextFrame();
  await nextFrame();
  assert.match(list.textContent, /The build starts with/, 'the delta was drawn');
  assert.equal(list.scrollTop, 100, 'a streamed frame must not pull the view down');

  emit('toolLine', sends[0], { phase: 'start', line: 'Reading package.json', tool: 'read_file', callIndex: 0 });
  assert.equal(list.scrollTop, 100, 'a tool line must not pull the view down');

  sends[0].resolve({ content: 'The build starts with forge.', toolTrace: [] });
  await flush();
  assert.equal(list.scrollTop, 100, 'the settle must not pull the view down');
});

test('at the end of the list, new output is followed (#587)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { list, sends, ask, emit, layout, scrollTo } = env;

  ask('Explain the build.');
  await flush();
  layout({ scrollHeight: 1000 });
  scrollTo(790); // 10 px above the end

  layout({ scrollHeight: 1400 });
  emit('delta', sends[0], { text: 'More text' });
  await nextFrame();
  await nextFrame();
  assert.equal(list.scrollTop, 1400);

  // Scrolled up, a send of the user's own still lands at the end.
  sends[0].resolve({ content: 'Done.', toolTrace: [] });
  await flush();
  scrollTo(0);
  ask('And the tests?');
  assert.equal(list.scrollTop, 1400);
});

// --- #588 / #589 ----------------------------------------------------------------

test('a new chat and a folder switch take the pending images along with the text (#588)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, sends, input, ask, paste, chips } = env;

  paste();
  await until(() => chips() === 1, 'the chip');
  input.value = 'draft';
  await chat.startNewChat();
  assert.equal(chips(), 0, 'new chat: the chip is gone');
  assert.equal(input.value, '');

  paste();
  await until(() => chips() === 1, 'the chip');
  await chat.loadChatForWorkspace('/other');
  assert.equal(chips(), 0, 'folder switch: the chip is gone');

  ask('Hello');
  await flush();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].messages.at(-1).attachments, undefined, 'nothing from the earlier draft travels along');
});

test('an image still being prepared at a switch does not land in the next chat (#588)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, paste, chips } = env;

  const bitmap = deferred();
  globalThis.createImageBitmap = () => bitmap.promise;
  paste();
  await flush();
  await chat.startNewChat();
  bitmap.resolve(null);
  await flush();
  await flush();
  await flush();
  assert.equal(chips(), 0);
});

test('images being prepared hold their slot: a fifth paste is refused (#589)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { paste, chips } = env;

  const bitmaps = [];
  globalThis.createImageBitmap = () => {
    const d = deferred();
    bitmaps.push(d);
    return d.promise;
  };
  for (let i = 0; i < 5; i += 1) paste(`shot-${i}.png`);
  await flush();
  assert.equal(bitmaps.length, 4, 'the fifth image was not even started');
  assert.match(document.getElementById('chat-token-usage-value').textContent, /4|image/i, 'the user is told');
  for (const d of bitmaps) d.resolve(null);
  await until(() => chips() === 4, 'four chips');
  await flush();
  assert.equal(chips(), 4);
});

test('Enter right after a paste waits for the image instead of sending without it (#589)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { sends, input, ask, paste } = env;

  const bitmap = deferred();
  globalThis.createImageBitmap = () => bitmap.promise;
  paste();
  await flush();
  ask('What is wrong here?');
  await flush();
  assert.equal(sends.length, 0, 'held while the image is prepared');
  assert.equal(input.value, 'What is wrong here?', 'the question stays in the input meanwhile');

  bitmap.resolve(null);
  await until(() => sends.length === 1, 'the send');
  const question = sends[0].messages.at(-1);
  assert.equal(question.content, 'What is wrong here?');
  assert.equal(question.attachments?.length, 1, 'the image went along');
});

// --- #590 -----------------------------------------------------------------------

test('a finished tool step makes the next answer read its image again (#590)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, sends, imageReads, ask, emit } = env;

  ask('Plot it.');
  await flush();
  sends[0].resolve({ content: '![plot](plot.png)', toolTrace: [] });
  await until(() => imageReads.length === 1, 'the first read');

  chat.renderChatMessages();
  await flush();
  assert.equal(imageReads.length, 1, 'a redraw is served from the cache');

  ask('Make the bars red.');
  await flush();
  emit('toolLine', sends[1], { phase: 'start', line: 'Running Python', tool: 'run_python', callIndex: 0 });
  emit('toolLine', sends[1], { phase: 'done', line: 'Ran Python', tool: 'run_python', callIndex: 0 });
  sends[1].resolve({ content: '![plot](plot.png)', toolTrace: [{ line: 'Ran Python', tool: 'run_python' }] });
  await until(() => imageReads.length >= 2, 'a fresh read');
});

test('a failed image read is asked again next time (#590)', async (t) => {
  const env = await mount({
    readWorkspaceImage: (_src, n) => (n === 1
      ? { ok: false, reason: 'NOT_FOUND' }
      : { ok: true, mime: 'image/png', base64: 'AAAA' }),
  });
  t.after(env.cleanup);
  const { chat, sends, imageReads, list, ask } = env;

  ask('Show the plot.');
  await flush();
  sends[0].resolve({ content: '![plot](missing.png)', toolTrace: [] });
  await until(() => imageReads.length === 1, 'the first read');
  await flush();
  assert.ok(list.querySelector('.chat-md-image--placeholder'));

  chat.renderChatMessages();
  await until(() => imageReads.length === 2, 'a second read');
  await until(() => list.querySelector('img.chat-md-image-img'), 'the image');
});

// --- #591 / #592 ----------------------------------------------------------------

test('the error prefix follows the interface language (#591)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { list, sends, ask, setLocale } = env;

  ask('Hi');
  await flush();
  sends[0].resolve({ error: 'The provider is not reachable.' });
  await flush();
  const prefix = () => list.querySelector('.chat-msg.error .chat-msg-error-prefix')?.textContent;
  assert.equal(prefix(), 'Error:');
  setLocale('de', { force: true });
  assert.equal(prefix(), 'Fehler:');
});

test('a redraw announces nothing; a settled turn is announced once (#592)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, list, sends, ask, emit } = env;
  const announcer = document.getElementById('chat-announcer');

  assert.equal(list.getAttribute('aria-live'), 'off', 'the redrawn list is no live region');
  assert.equal(announcer.getAttribute('aria-live'), 'polite');

  ask('Summarise.');
  await flush();
  emit('delta', sends[0], { text: 'Half' });
  await nextFrame();
  chat.renderChatMessages();
  assert.equal(announcer.textContent, '', 'nothing while the answer streams or the list is redrawn');

  sends[0].resolve({ content: 'All **done**.', toolTrace: [] });
  await flush();
  assert.equal(announcer.textContent, 'All done.');

  ask('Again.');
  await flush();
  sends[1].resolve({ error: 'Out of tokens.' });
  await flush();
  assert.equal(announcer.textContent, 'Error: Out of tokens.');
});

// --- #593 -----------------------------------------------------------------------

test('a background run never draws into the chat on screen (#593)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, list, sends, ask, emit } = env;

  ask('Question in A');
  await flush();
  await chat.startNewChat();
  ask('Question in B');
  await flush();
  assert.equal(sends.length, 2);
  const [runA, runB] = sends;

  emit('delta', runB, { text: 'Answer of B' });
  emit('delta', runA, { text: 'Answer of A' });
  emit('toolLine', runA, { phase: 'start', line: 'Step of A', tool: 'read_file', callIndex: 0 });
  await nextFrame();
  await nextFrame();

  const bubble = list.querySelector('.chat-msg.assistant:last-of-type');
  assert.match(bubble.textContent, /Answer of B/);
  assert.doesNotMatch(list.textContent, /Answer of A|Step of A/);
});

test('a running chat opened again is drawn before the round trips (#593)', async (t) => {
  const history = { sessions: [], activeChatId: null };
  const activation = deferred();
  let holdActivation = false;
  const env = await mount({
    history,
    activateChatSession: async () => {
      if (holdActivation) await activation.promise;
    },
  });
  t.after(env.cleanup);
  const { chat, list, sends, ask, emit, appStore } = env;

  ask('Question in A');
  await flush();
  await chat.startNewChat();
  ask('Question in B');
  await flush();
  const [runA] = sends;

  // Back to A through its folder; its run is still in memory.
  history.sessions = [{ id: 'chat-a', messages: [{ role: 'user', content: 'Question in A' }] }];
  history.activeChatId = 'chat-a';
  holdActivation = true;
  const switching = chat.loadChatForWorkspace('/ws');
  await until(() => appStore.currentChatId === 'chat-a', 'A on screen');

  // The activation round trip has not answered yet.
  assert.match(list.textContent, /Question in A/, 'the list shows A already');
  assert.doesNotMatch(list.textContent, /Question in B/);
  emit('delta', runA, { text: 'Answer of A' });
  await nextFrame();
  await nextFrame();
  assert.match(list.querySelector('.chat-msg.assistant:last-of-type').textContent, /Answer of A/);

  activation.resolve();
  await switching;
});

// --- #595 -----------------------------------------------------------------------

test('the size of a pasted image follows the interface language (#595)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { input, chips, setLocale } = env;
  setLocale('de', { force: true });

  const file = new File([new Uint8Array(Math.round(2.3 * 1024 * 1024))], 'big.png', { type: 'image/png' });
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => file }] } });
  input.dispatchEvent(event);
  await until(() => chips() === 1, 'the chip');
  assert.equal(document.querySelector('.chat-attachment-size').textContent, '2,3 MB');
});

test('a folder name with Markdown in it is greeted as it is written (#595)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, appStore, list } = env;

  appStore.rootPath = '/projects/a*b*c [x](mailto:a@example.com)';
  await chat.startNewChat();
  const greeting = list.querySelector('.chat-msg.assistant .chat-md');
  assert.equal(greeting.querySelector('em, a'), null);
  assert.match(greeting.textContent, /a\*b\*c \[x\]\(mailto:a@example\.com\)/);
});

// --- #995 ---------------------------------------------------------------------

test('an image refused for the provider names Snotra and the provider, not the model (#995)', async (t) => {
  const env = await mount({ imageLimit: { limitedBy: 'provider', provider: 'Anthropic (Claude)' } });
  t.after(env.cleanup);
  const { paste, chips } = env;

  paste();
  await flush();
  assert.equal(chips(), 0);
  assert.equal(
    document.getElementById('chat-token-usage').textContent.trim(),
    'Snotra does not pass images to Anthropic (Claude) yet.',
  );
});

test('an image refused for a connection points at its switch (#995)', async (t) => {
  const env = await mount({ imageLimit: { limitedBy: 'connection', provider: '' } });
  t.after(env.cleanup);
  const { paste, chips, setLocale } = env;
  setLocale('de', { force: true });

  paste();
  await flush();
  assert.equal(chips(), 0);
  assert.equal(
    document.getElementById('chat-token-usage').textContent.trim(),
    'Für diese Verbindung sind Bild-Anhänge ausgeschaltet.',
  );
});

// --- #721 ---------------------------------------------------------------------

test('events that arrive after the reply still reach their run (#721)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { appStore, sends, list, ask, emit } = env;

  ask('Fix the second line.');
  await flush();
  emit('toolLine', sends[0], { phase: 'start', line: 'Changing file notes.txt …', tool: 'edit_file', callIndex: 0 });
  const done = {
    line: 'Changed file notes.txt',
    tool: 'edit_file',
    changes: [{ id: 'a1-1', relativePath: 'notes.txt', status: 'text', added: 1, removed: 1 }],
  };
  // The reply overtakes the done event, as it did on the macOS runner.
  sends[0].reply({ content: 'Done.', toolTrace: [done] });
  await flush();
  await flush();
  assert.equal(appStore.chatInFlight, true, 'the run waits for its end marker');

  emit('toolLine', sends[0], { phase: 'done', callIndex: 0, ...done });
  sends[0].end();
  await until(() => !appStore.chatInFlight, 'the settled run');

  const row = list.querySelector('.chat-msg.assistant:last-of-type .chat-tool-lines .chat-tool-line');
  assert.ok(row.classList.contains('chat-tool-line--done'));
  assert.equal(row.querySelector('.chat-tool-line-text').textContent, 'Changed file notes.txt');
  assert.ok(list.querySelector('.chat-changes button.chat-change-file'), 'the diff can be opened');
});

// --- #979 -----------------------------------------------------------------------

const lastTurn = (save) => save.messages[save.messages.length - 1];
const traceLines = (message) => (message.toolTrace || []).map((e) => (typeof e === 'string' ? e : e.line));

test('a finished step is saved while the run goes on, the running one is not (#979)', async (t) => {
  const held = [];
  let holdSaves = false;
  const env = await mount({
    upsertChatSession: () => (holdSaves ? new Promise((resolve) => held.push(resolve)) : { ok: true }),
  });
  t.after(env.cleanup);
  const { sends, saves, ask, emit } = env;

  ask('Read both notes.');
  await flush();
  assert.equal(saves.length, 1, 'the question is saved on send');
  assert.equal(lastTurn(saves[0]).streaming, true, 'with the turn under way');

  holdSaves = true;
  emit('toolLine', sends[0], { phase: 'start', line: 'Reading a.txt', tool: 'read_file', callIndex: 0 });
  assert.equal(saves.length, 1, 'a step that started is not a reason to save');
  emit('toolLine', sends[0], { phase: 'done', line: 'Read a.txt', tool: 'read_file', callIndex: 0 });
  await until(() => saves.length === 2, 'the save after the first step');
  assert.deepEqual(traceLines(lastTurn(saves[1])), ['Read a.txt']);

  // While that save is under way, a second step finishes and a third starts.
  emit('toolLine', sends[0], { phase: 'start', line: 'Reading b.txt', tool: 'read_file', callIndex: 1 });
  emit('toolLine', sends[0], { phase: 'done', line: 'Read b.txt', tool: 'read_file', callIndex: 1 });
  emit('toolLine', sends[0], { phase: 'start', line: 'Reading c.txt', tool: 'read_file', callIndex: 2 });
  await flush();
  assert.equal(saves.length, 2, 'one save at a time');

  holdSaves = false;
  held.shift()();
  await until(() => saves.length === 3, 'the save that takes the second step along');
  assert.deepEqual(traceLines(lastTurn(saves[2])), ['Read a.txt', 'Read b.txt'], 'the running step stays out');
  assert.equal(lastTurn(saves[2]).streaming, true);

  sends[0].resolve({ content: 'Both read.', toolTrace: [{ line: 'Read a.txt' }, { line: 'Read b.txt' }, { line: 'Read c.txt' }] });
  await until(() => saves.length === 4, 'the save when the run settles');
  await flush();
  assert.equal(saves.length, 4, 'nothing is saved from a checkpoint after the run settled');
  assert.equal(lastTurn(saves[3]).streaming, false, 'the settled turn is not cut off');
  assert.equal(lastTurn(saves[3]).content, 'Both read.');
});

test('a run in the background saves its own chat after each step (#979)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, sends, saves, ask, emit } = env;

  ask('Question in A');
  await flush();
  await chat.startNewChat();
  const before = saves.length;
  emit('toolLine', sends[0], { phase: 'start', line: 'Step of A', tool: 'read_file', callIndex: 0 });
  emit('toolLine', sends[0], { phase: 'done', line: 'Step of A done', tool: 'read_file', callIndex: 0 });
  await until(() => saves.length > before, 'the save of A');
  const save = saves[saves.length - 1];
  assert.equal(save.id, 'chat-a');
  assert.deepEqual(traceLines(lastTurn(save)), ['Step of A done']);
});

test('a turn cut off by a crash or reload comes back marked as interrupted (#979)', async (t) => {
  const history = {
    sessions: [{
      id: 'chat-a',
      workspaceRoot: '/ws',
      messages: [
        { role: 'user', content: 'Read the notes.' },
        { role: 'assistant', content: '', toolTrace: [{ line: 'Read a.txt', tool: 'read_file' }], interrupted: true, streaming: false, isError: false, reasoningText: '' },
      ],
    }],
    activeChatId: 'chat-a',
  };
  const env = await mount({ history });
  t.after(env.cleanup);
  const { chat, list, setLocale } = env;

  await chat.loadChatForWorkspace('/ws');
  const note = list.querySelector('.chat-msg.assistant .chat-interrupted-note');
  assert.ok(note, 'the note is there');
  assert.equal(note.getAttribute('role'), 'note');
  assert.match(note.textContent, /^Interrupted\. Snotra was closed or reloaded/);
  assert.match(list.textContent, /Read a\.txt/, 'the finished step is shown above it');

  setLocale('de', { force: true });
  assert.match(note.textContent, /^Unterbrochen\. Snotra wurde geschlossen oder neu geladen/, 'the note follows the language');
});

test('an answer that settled carries no interrupted note (#979)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { list, sends, ask } = env;
  ask('Hello');
  await flush();
  sends[0].resolve({ content: 'Hi.', toolTrace: [] });
  await until(() => /Hi\./.test(list.textContent), 'the answer');
  assert.equal(list.querySelector('.chat-interrupted-note'), null);
});

test('a run stopped by a reload is not saved as one the user stopped (#979)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { sends, saves, ask, emit } = env;

  ask('Read the notes.');
  await flush();
  emit('toolLine', sends[0], { phase: 'start', line: 'Reading a.txt', tool: 'read_file', callIndex: 0 });
  emit('toolLine', sends[0], { phase: 'done', line: 'Read a.txt', tool: 'read_file', callIndex: 0 });
  await until(() => saves.length === 2, 'the save after the step');

  // The window reloads; main stops the run and its reply still comes in.
  window.dispatchEvent(new Event('beforeunload'));
  emit('toolLine', sends[0], { phase: 'start', line: 'Reading b.txt', tool: 'read_file', callIndex: 1 });
  emit('toolLine', sends[0], { phase: 'done', line: 'Read b.txt', tool: 'read_file', callIndex: 1 });
  sends[0].resolve({ cancelled: true, content: '', toolTrace: [{ line: 'Read a.txt' }, { line: 'Read b.txt' }] });
  await flush();
  await flush();
  assert.equal(saves.length, 2, 'the save mid-run is the last one');
  assert.equal(lastTurn(saves[1]).streaming, true);
});

// --- #998 -----------------------------------------------------------------------

/**
 * Records what marked was asked to parse, until the test ends. Its exports are
 * getters that ignore an assignment, so the spy is a copy of them.
 */
function spyOnMarkdown(t) {
  const original = globalThis.marked;
  const parsed = [];
  const spy = {};
  for (const key of Object.keys(original)) spy[key] = original[key];
  spy.parse = (text, options) => {
    parsed.push(text);
    return original.parse(text, options);
  };
  globalThis.marked = spy;
  t.after(() => { globalThis.marked = original; });
  return parsed;
}

/** What rendering `markdown` as a whole puts into the answer, for comparison. */
function wholeRender(markdown) {
  const template = document.createElement('template');
  template.innerHTML = globalThis.marked.parse(markdown, { breaks: true, gfm: true });
  return template.innerHTML;
}

test('a streaming answer renders only its open block on each frame (#998)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { list, sends, ask, emit } = env;
  ask('Plan it.');
  await flush();
  const stream = () => list.querySelector('.chat-msg.assistant:last-of-type .chat-md-streaming');

  // Node identity is compared with `===`: a failing assert.equal on a
  // happy-dom node spends minutes printing it.
  emit('delta', sends[0], { text: '## The plan\n\nFirst we read the notes.\n\n' });
  await nextFrame();
  const heading = stream().querySelector('h2');
  assert.ok(heading);

  const text = '## The plan\n\nFirst we read the notes.\n\n- one\n- two\n\nThen we write the summary.\n';
  const whole = wholeRender(text);
  const parsed = spyOnMarkdown(t);
  emit('delta', sends[0], { text: '- one\n- two\n' });
  await nextFrame();
  // The paragraph is closed now, the list is the open block.
  const paragraph = stream().querySelector('p');
  assert.ok(paragraph);
  emit('delta', sends[0], { text: '\nThen we write' });
  await nextFrame();
  emit('delta', sends[0], { text: ' the summary.\n' });
  await nextFrame();

  assert.equal(stream().innerHTML, whole, 'the pieces add up to the whole answer');
  assert.ok(stream().querySelector('h2') === heading, 'a finished block stays the node it was');
  assert.ok(stream().querySelector('p') === paragraph, 'so does the paragraph closed on the way');
  assert.ok(parsed.every((markdown) => !markdown.includes('The plan')), 'the heading is not parsed again');
  assert.equal(parsed.filter((markdown) => markdown.includes('First we read')).length, 1, 'the paragraph is parsed once more, as it closes');
  assert.equal(parsed.at(-1), 'Then we write the summary.\n', 'the last frame parses the open block alone');
});

test('a streaming answer with raw HTML is rendered whole on each frame (#998)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { list, sends, ask, emit } = env;
  ask('Fold it.');
  await flush();
  const parsed = spyOnMarkdown(t);

  emit('delta', sends[0], { text: '<details>\n\nInside the fold.\n\n' });
  await nextFrame();
  emit('delta', sends[0], { text: '</details>\n\nAfter' });
  await nextFrame();

  const text = '<details>\n\nInside the fold.\n\n</details>\n\nAfter';
  assert.equal(parsed.at(-1), text);
  const stream = list.querySelector('.chat-msg.assistant:last-of-type .chat-md-streaming');
  assert.equal(stream.innerHTML, wholeRender(text));
  assert.match(stream.querySelector('details').textContent, /Inside the fold/, 'the fold holds what was written into it');
});

test('a finished answer renders as the whole text once its run settles (#998)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { list, sends, ask, emit } = env;
  ask('Plan it.');
  await flush();
  const text = 'First.\n\n- one\n- two\n\nLast.';
  emit('delta', sends[0], { text });
  await nextFrame();
  sends[0].resolve({ content: text, toolTrace: [] });
  await until(() => !list.querySelector('.chat-md-streaming'), 'the settled answer');
  const answer = list.querySelector('.chat-msg.assistant:last-of-type .chat-md');
  assert.equal(answer.innerHTML, wholeRender(text));
});

test('a finished answer is rendered once and copied on the next redraw (#998)', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, appStore, list, imageReads } = env;
  const answers = ['## One\n\nFirst answer.', '## Two\n\n![chart](chart.png)\n\nSecond answer.'];
  appStore.chatMessages = [
    { role: 'user', content: 'First?' },
    { role: 'assistant', content: answers[0] },
    { role: 'user', content: 'Second?' },
    { role: 'assistant', content: answers[1] },
  ];
  const parsed = spyOnMarkdown(t);
  chat.renderChatMessages();
  const before = [...list.querySelectorAll('.chat-msg.assistant .chat-md')];
  await until(() => imageReads.length === 1, 'the image read');
  await until(() => list.querySelector('.chat-md img')?.getAttribute('src'), 'the image shown');
  assert.deepEqual(parsed, answers);

  // Away and back: a chat switch draws the same answers again.
  appStore.chatMessages = [{ role: 'user', content: 'Elsewhere' }];
  chat.renderChatMessages();
  appStore.chatMessages = [
    { role: 'user', content: 'First?' },
    { role: 'assistant', content: answers[0] },
    { role: 'user', content: 'Second?' },
    { role: 'assistant', content: answers[1] },
  ];
  chat.renderChatMessages();
  const after = [...list.querySelectorAll('.chat-msg.assistant .chat-md')];
  assert.deepEqual(parsed, answers, 'nothing was parsed again');
  assert.equal(after.length, 2);
  assert.ok(after[0].firstChild !== before[0].firstChild, 'each redraw gets nodes of its own');
  assert.equal(after[0].innerHTML, before[0].innerHTML);
  // The image is filled in on the copy, from the image cache this time.
  await until(() => after[1].querySelector('img')?.getAttribute('src'), 'the image in the copy');
  assert.equal(after[1].innerHTML, before[1].innerHTML);
});
