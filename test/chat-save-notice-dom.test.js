// A chat that cannot be saved says so (#977).
//
// The bug: main skipped a save over an unreadable history and answered
// `{ ok: false }`, the renderer never looked, and a save that threw for any
// other reason ended as an unhandled rejection of a `void` call. The user went
// on writing in chats that were gone after the next quit.
// Checked here: the banner under the header names the cause, stays while saves
// fail, goes once one succeeds — and no save rejects into the void.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mount() {
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');

  const listeners = {};
  const sends = [];
  const manualOpened = [];
  // What the next saves answer: a value, or an Error to reject with.
  const saveAnswers = [];
  const api = {
    onChatDelta: (cb) => { listeners.delta = cb; return () => {}; },
    onChatProgress: (cb) => { listeners.progress = cb; return () => {}; },
    onChatToolLine: (cb) => { listeners.toolLine = cb; return () => {}; },
    getChatHistory: async () => ({ sessions: [], activeChatId: null }),
    setActiveChatId: async () => ({ ok: true }),
    upsertChatSession: async () => {
      const answer = saveAnswers.length ? saveAnswers.shift() : { ok: true };
      if (answer instanceof Error) throw answer;
      return answer;
    },
    generateChatTitle: async () => ({ title: '' }),
    openManual: async (target) => { manualOpened.push(target); return { ok: true }; },
    abortChat() {},
    chat: (messages, options) =>
      new Promise((resolve) => {
        const send = { messages, options, settled: false };
        send.resolve = (result) => {
          send.settled = true;
          resolve(result);
          listeners.progress?.({ type: 'run-end', chatId: options?.chatId, runId: options?.runId });
        };
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

  /** Answers the open run and waits for its save. */
  async function answer(text) {
    const send = sends.at(-1);
    send.resolve({ content: text, toolTrace: [] });
    for (let i = 0; i < 4; i += 1) await flush();
  }

  const notice = () => document.getElementById('chat-save-notice');
  const noticeText = () => document.getElementById('chat-save-notice-text').textContent;

  async function cleanup() {
    for (const send of sends) if (!send.settled) send.resolve({ cancelled: true, content: '', toolTrace: [] });
    await flush();
    await flush();
    await setLocale('en');
    dom.cleanup();
  }

  return { cleanup, chat, ask, answer, saveAnswers, manualOpened, notice, noticeText, setLocale };
}

test('a save skipped over an unreadable history shows the banner, a save that goes through hides it', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { ask, answer, saveAnswers, notice, noticeText } = env;

  assert.equal(notice().hidden, true, 'no banner while nothing went wrong');
  // The question's save and the answer's save are both skipped.
  saveAnswers.push({ ok: false, unreadable: true }, { ok: false, unreadable: true });
  ask('How far apart do the radishes go?');
  await flush();
  await flush();
  assert.equal(notice().hidden, false, 'shown as soon as the question was not saved');
  assert.match(noticeText(), /could not read the chat history/);
  assert.match(document.getElementById('chat-announcer').textContent, /This chat is not being saved\./,
    'said once to a screen reader');

  await answer('20 cm.');
  assert.equal(notice().hidden, false, 'stays while saves are skipped');

  ask('And how deep?');
  await flush();
  await flush();
  assert.equal(notice().hidden, true, 'gone with the first save that goes through');
  await answer('2 cm.');
});

test('a save that rejects shows the banner instead of an unhandled rejection', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { chat, ask, answer, saveAnswers, notice, noticeText } = env;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  saveAnswers.push(new Error('ENOSPC: no space left on device'), new Error('ENOSPC: no space left on device'));
  ask('Plan the beds.');
  await answer('Done.');
  assert.equal(notice().hidden, false);
  assert.match(noticeText(), /could not write this chat into the history/);

  // A new chat saves the one it leaves first; that save failing does not stop it.
  saveAnswers.push(new Error('ENOSPC: no space left on device'));
  await chat.startNewChat();
  await flush();
  assert.deepEqual(unhandled, [], 'no save rejected into the void');
  assert.equal(notice().hidden, false);
});

test('the banner follows the language, and its link opens the troubleshooting page there', async (t) => {
  const env = await mount();
  t.after(env.cleanup);
  const { ask, answer, saveAnswers, notice, noticeText, manualOpened, setLocale } = env;

  saveAnswers.push({ ok: false, unreadable: true }, { ok: false, unreadable: true });
  ask('Plan the beds.');
  await answer('Done.');
  assert.equal(notice().hidden, false);

  await setLocale('de');
  assert.match(notice().textContent, /Dieser Chat wird nicht gespeichert\./);
  assert.match(noticeText(), /konnte den Chatverlauf nicht lesen/);
  document.getElementById('chat-save-notice-link').click();
  await flush();
  assert.deepEqual(manualOpened, [{ slug: 'troubleshooting/keychain-and-storage', fragment: 'wenn-ein-chat-nicht-gespeichert-wird' }]);
});
