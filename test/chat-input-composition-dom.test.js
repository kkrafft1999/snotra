// Enter/Tab belong to an active IME composition, not to the chat (#372).
//
// The bug: confirming an IME candidate (Japanese, Chinese, Korean input) with
// Enter fired the app's own Enter handling too, sending the half-typed
// message or applying whatever the `@`/`/` menu had highlighted. Checked
// here: with `isComposing: true` on the keydown, none of that fires; a plain
// Enter afterwards still does.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

async function mountChatStream() {
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const sends = [];
  const api = {
    onChatDelta: () => () => {},
    onChatProgress: () => () => {},
    onChatToolLine: () => () => {},
    getChatHistory: async () => ({ sessions: [], activeChatId: null }),
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
    generateChatTitle: async () => ({ title: '' }),
    writeClipboardText: async () => ({ ok: true }),
    abortChat: () => {},
    chat: (messages, options) =>
      new Promise((resolve) => {
        sends.push({ messages, options, resolve });
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
    onRunsChanged() {},
  });

  appStore.chatRuns.clear();
  appStore.rootPath = '/ws';
  appStore.currentChatId = 'chat-a';
  appStore.currentChatWorkspace = '/ws';
  appStore.currentChatTitle = '';
  appStore.chatMessages = [];
  chat.renderChatMessages();

  const input = document.getElementById('chat-input');

  function pressEnter({ isComposing = false } = {}) {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing, bubbles: true, cancelable: true })
    );
  }

  // An open run keeps the thinking ticker going, which keeps the file from finishing.
  async function cleanup() {
    for (const send of sends) send.resolve({ cancelled: true, content: '', toolTrace: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.cleanup();
  }

  return { dom: { cleanup }, chat, appStore, api, sends, input, pressEnter };
}

test('Enter during an IME composition does not send the chat message', async (t) => {
  const env = await mountChatStream();
  t.after(env.dom.cleanup);
  const { input, pressEnter, sends } = env;

  input.value = 'こんにちは';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  pressEnter({ isComposing: true });

  assert.equal(sends.length, 0, 'no chat request was started while composing');
  assert.equal(input.value, 'こんにちは', 'the composed text stays in the field');
});

test('plain Enter still sends the chat message', async (t) => {
  const env = await mountChatStream();
  t.after(env.dom.cleanup);
  const { input, pressEnter, sends } = env;

  input.value = 'Hello';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  pressEnter();

  assert.equal(sends.length, 1, 'the message was sent');
});

async function mountMentionAutocomplete() {
  const dom = setupRendererDom();
  const { initMentionAutocomplete } = await importRenderer('components', 'MentionAutocomplete.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const api = {
    listWorkspacePaths: async () => ({
      entries: [{ path: 'src/index.js', kind: 'file' }],
    }),
  };

  appStore.rootPath = '/ws';
  const mention = initMentionAutocomplete({ api, appStore, onInputChanged() {} });

  const input = document.getElementById('chat-input');
  const menu = document.getElementById('chat-mention-menu');

  async function openMenu() {
    input.value = '@src';
    input.selectionStart = input.value.length;
    input.selectionEnd = input.value.length;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // update() loads the paths asynchronously.
    for (let i = 0; i < 5 && !mention.isOpen(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return { dom, mention, input, menu, openMenu };
}

test('Enter during an IME composition leaves the @ menu open', async (t) => {
  const env = await mountMentionAutocomplete();
  t.after(env.dom.cleanup);
  const { mention, input, openMenu } = env;

  await openMenu();
  assert.ok(mention.isOpen(), 'the mention menu opened for "@src"');
  const before = input.value;

  input.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })
  );

  assert.ok(mention.isOpen(), 'the menu is still open, no entry was applied');
  assert.equal(input.value, before, 'the input text is unchanged');
});
