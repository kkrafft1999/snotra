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

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom } = require('./helpers/dom.js');

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

async function mount({ history = { sessions: [], activeChatId: null }, activateChatSession, readWorkspaceImage } = {}) {
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
  const api = {
    onChatDelta: (cb) => { listeners.delta = cb; return () => {}; },
    onChatProgress: (cb) => { listeners.progress = cb; return () => {}; },
    onChatToolLine: (cb) => { listeners.toolLine = cb; return () => {}; },
    getChatHistory: async () => history,
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
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

  return { cleanup, chat, appStore, sends, imageReads, list, input, ask, emit, paste, chips, layout, scrollTo, setLocale };
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
