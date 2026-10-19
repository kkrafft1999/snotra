const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createChatHistoryService } = require('../src/main/services/chat-history-service');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { removeTempDir } = require('./helpers/temp-dir');

// The history's rules without IPC (#1006): the service is driven directly.

async function setup(t, { maxChatSessions = 2, chatSessionSettings } = {}) {
  let clock = 1_000_000;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-chathist-svc-'));
  t.after(() => removeTempDir(tmpDir));
  const storage = createStorageService({
    userDataPath: tmpDir,
    secretStore: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  /** @type {string[]} */
  const deletedAttachments = [];
  const chatHistory = createChatHistoryService({
    chatHistoryStore: createChatHistoryStorePort(storage),
    chatAttachments: {
      persistMessages: async (_chatId, messages) => messages,
      readAttachment: async () => ({ ok: true, dataUrl: 'data:' }),
      deleteChat: async (id) => { deletedAttachments.push(id); },
      pruneChats: async () => {},
    },
    getActiveWorkspaceRoot: () => '/work/a',
    isKnownWorkspaceRoot: async (root) => root === path.resolve('/work/b'),
    now: () => (clock += 1000),
    ...(chatSessionSettings ? { chatSessionSettings } : {}),
  });
  return { chatHistory, deletedAttachments, clock: () => clock };
}

const turn = (text) => [{ role: 'user', content: text }, { role: 'assistant', content: `re: ${text}` }];

test('a save stamps the time in main, and a save without new messages keeps it', async (t) => {
  const { chatHistory } = await setup(t);
  assert.deepEqual(await chatHistory.saveSession({ id: 'c1', title: 'One', messages: turn('hi'), updatedAt: 5 }), { ok: true });
  const first = await chatHistory.getSession('c1');
  assert.equal(first.updatedAt, 1_001_000, 'the renderer\'s time does not count');

  await chatHistory.saveSession({ id: 'c1', title: 'One, renamed', messages: turn('hi') });
  assert.equal((await chatHistory.getSession('c1')).updatedAt, 1_001_000);

  await chatHistory.saveSession({ id: 'c1', messages: [...turn('hi'), ...turn('again')] });
  const third = await chatHistory.getSession('c1');
  assert.equal(third.updatedAt, 1_002_000, 'new messages bring a new stamp');
  assert.equal(third.title, 'One, renamed', 'a save without a title keeps the stored one');
});

test('model, mode and level are main\'s word, not the renderer\'s', async (t) => {
  const { chatHistory } = await setup(t, {
    chatSessionSettings: {
      activate: async () => ({}),
      valuesFor: () => ({ modelPresetId: 'p-main', toolPermissionMode: 'smart' }),
      forget: () => {},
    },
  });
  await chatHistory.saveSession({ id: 'c1', messages: turn('hi'), modelPresetId: 'p-renderer', toolPermissionMode: 'auto' });
  const chat = await chatHistory.getSession('c1');
  assert.equal(chat.modelPresetId, 'p-main');
  assert.equal(chat.toolPermissionMode, 'smart');
});

test('a chat may keep a folder opened before; an unknown one falls back to the active folder', async (t) => {
  const { chatHistory } = await setup(t, { maxChatSessions: 5 });
  await chatHistory.saveSession({ id: 'known', messages: turn('a'), workspaceRoot: '/work/b' });
  await chatHistory.saveSession({ id: 'unknown', messages: turn('b'), workspaceRoot: '/elsewhere' });
  const ids = (await chatHistory.listForActiveFolder()).sessions.map((row) => row.id);
  assert.deepEqual(ids, ['unknown'], 'only the active folder\'s chats are listed');
  assert.equal(await chatHistory.getSession('known'), null, 'another folder\'s chat is not handed out');
});

test('the oldest chats beyond the limit go, with their images', async (t) => {
  const { chatHistory, deletedAttachments } = await setup(t, { maxChatSessions: 2 });
  for (const id of ['c1', 'c2', 'c3']) await chatHistory.saveSession({ id, messages: turn(id) });
  const ids = (await chatHistory.listForActiveFolder()).sessions.map((row) => row.id).sort();
  assert.deepEqual(ids, ['c2', 'c3']);
  assert.deepEqual(deletedAttachments, ['c1']);
});

test('the active chat pointer, a delete and an attachment read', async (t) => {
  const forgotten = [];
  const { chatHistory, deletedAttachments } = await setup(t, {
    chatSessionSettings: { activate: async () => ({ mode: 'smart' }), valuesFor: () => ({}), forget: (id) => forgotten.push(id) },
  });
  await chatHistory.saveSession({ id: 'c1', messages: turn('hi') });
  await chatHistory.setActive('c1');
  assert.equal((await chatHistory.listForActiveFolder()).activeChatId, 'c1');
  await chatHistory.setActive(null);
  assert.equal((await chatHistory.listForActiveFolder()).activeChatId, null);

  assert.deepEqual(await chatHistory.activate('c1', 'something'), { ok: true, mode: 'smart' });
  assert.deepEqual(await chatHistory.readAttachment('', 'x.png'), { ok: false });
  assert.equal((await chatHistory.readAttachment(' c1 ', 'x.png')).ok, true);

  assert.deepEqual(await chatHistory.deleteSession('c1'), { ok: true });
  assert.deepEqual(forgotten, ['c1']);
  assert.ok(deletedAttachments.includes('c1'));
  assert.deepEqual(await chatHistory.deleteSession('   '), { ok: false });
});
