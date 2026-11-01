const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createChatHistoryService } = require('../src/main/services/chat-history-service');
const { chatSessionFileName } = require('../src/main/services/chat-history-store');
const { registerChatHistoryHandlers } = require('../src/main/ipc/chat-history-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { removeDir, removeTempDir } = require('./helpers/temp-dir');

// The chat history as episodic memory (#1320): a limit per folder, an overall
// ceiling that is reported and never applied, *Keep*, and chats whose folder
// is gone moved into the open one.

async function setup(t, { perFolder = 2, overall = 100 } = {}) {
  let clock = 1_000_000;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-chathist-folder-'));
  t.after(() => removeTempDir(tmpDir));
  const userData = path.join(tmpDir, 'user-data');
  const folderA = path.join(tmpDir, 'a');
  const folderB = path.join(tmpDir, 'b');
  for (const dir of [userData, folderA, folderB]) await fs.mkdir(dir);
  const storage = createStorageService({
    userDataPath: userData,
    secretStore: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions: overall,
    maxChatSessionsPerFolder: perFolder,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  /** @type {string|null} */
  let activeRoot = folderA;
  /** @type {string[]} */
  const deletedAttachments = [];
  const chatHistory = createChatHistoryService({
    chatHistoryStore: createChatHistoryStorePort(storage),
    chatAttachments: {
      persistMessages: async (_chatId, messages) => messages,
      readAttachment: async () => ({ ok: false }),
      deleteChat: async (id) => { deletedAttachments.push(id); },
      pruneChats: async () => {},
    },
    getActiveWorkspaceRoot: () => activeRoot,
    isKnownWorkspaceRoot: async () => true,
    now: () => (clock += 1000),
  });
  return {
    chatHistory,
    deletedAttachments,
    folderA,
    folderB,
    tmpDir,
    userData,
    open: (/** @type {string|null} */ root) => { activeRoot = root; },
  };
}

const turn = (text) => [{ role: 'user', content: text }, { role: 'assistant', content: `re: ${text}` }];
const save = (chatHistory, id, workspaceRoot) => chatHistory.saveSession({ id, messages: turn(id), workspaceRoot });
const ids = (rows) => rows.map((row) => row.id).sort();

test('the limit holds per folder: a busy folder does not push out another one\'s chats', async (t) => {
  const { chatHistory, deletedAttachments, folderA, folderB, open } = await setup(t, { perFolder: 2 });
  await save(chatHistory, 'a1', folderA);
  await save(chatHistory, 'a2', folderA);
  for (const id of ['b1', 'b2', 'b3', 'b4']) await save(chatHistory, id, folderB);

  assert.deepEqual(ids((await chatHistory.listForActiveFolder()).sessions), ['a1', 'a2'], 'folder A keeps both');
  open(folderB);
  assert.deepEqual(ids((await chatHistory.listForActiveFolder()).sessions), ['b3', 'b4'], 'folder B keeps its newest two');
  assert.deepEqual(deletedAttachments, ['b1', 'b2'], 'the dropped chats\' images go with them');

  open(folderA);
  await save(chatHistory, 'a3', folderA);
  const listed = await chatHistory.listForActiveFolder();
  assert.deepEqual(ids(listed.sessions), ['a2', 'a3']);
  assert.deepEqual(listed.limits.folder, { count: 2, max: 2 });
});

test('the overall ceiling is reported, never applied by dropping chats', async (t) => {
  const { chatHistory, deletedAttachments, folderA, folderB } = await setup(t, { perFolder: 10, overall: 3 });
  await save(chatHistory, 'a1', folderA);
  await save(chatHistory, 'a2', folderA);
  let listed = await chatHistory.listForActiveFolder();
  assert.deepEqual(listed.limits.overall, { count: 2, max: 3, reached: false });

  await save(chatHistory, 'b1', folderB);
  await save(chatHistory, 'b2', folderB);
  await save(chatHistory, 'a3', folderA);
  listed = await chatHistory.listForActiveFolder();
  assert.deepEqual(ids(listed.sessions), ['a1', 'a2', 'a3'], 'nothing went');
  assert.deepEqual(listed.limits.overall, { count: 5, max: 3, reached: true });
  assert.deepEqual(deletedAttachments, []);
});

test('chats without a folder are a bucket of their own, with their own limit', async (t) => {
  const { chatHistory, folderA, open } = await setup(t, { perFolder: 2 });
  await save(chatHistory, 'a1', folderA);
  await save(chatHistory, 'a2', folderA);
  open(null);
  for (const id of ['n1', 'n2', 'n3']) await save(chatHistory, id, null);

  const listed = await chatHistory.listForActiveFolder();
  assert.equal(listed.workspaceRoot, null);
  assert.deepEqual(ids(listed.sessions), ['n2', 'n3'], 'only the no-folder chats, limited on their own');
  assert.deepEqual(listed.orphaned, [], 'with no folder open there is nothing to assign to');
  assert.deepEqual(listed.limits.folder, { count: 2, max: 2 });

  open(folderA);
  const inA = await chatHistory.listForActiveFolder();
  assert.deepEqual(ids(inA.sessions), ['a1', 'a2'], 'the folder\'s chats were not pushed out');
  assert.deepEqual(inA.orphaned, [], 'chats without a folder are no orphans');
});

test('a chat marked Keep is exempt from the limit and does not count', async (t) => {
  const { chatHistory, deletedAttachments, folderA } = await setup(t, { perFolder: 2 });
  await save(chatHistory, 'old', folderA);
  assert.deepEqual(await chatHistory.setKeep('old', true), { ok: true, keep: true });
  for (const id of ['c1', 'c2', 'c3']) await save(chatHistory, id, folderA);

  let listed = await chatHistory.listForActiveFolder();
  assert.deepEqual(ids(listed.sessions), ['c2', 'c3', 'old']);
  assert.equal(listed.sessions.find((row) => row.id === 'old').keep, true, 'the row carries the mark');
  assert.equal('keep' in listed.sessions.find((row) => row.id === 'c3'), false);
  assert.deepEqual(listed.limits.folder, { count: 2, max: 2 }, 'the kept chat does not count');
  assert.deepEqual(deletedAttachments, ['c1']);

  // A later save keeps the mark — it is main's word, not the renderer's.
  await chatHistory.saveSession({ id: 'old', messages: [...turn('old'), ...turn('again')], keep: false });
  await chatHistory.saveSession({ id: 'c3', messages: [...turn('c3'), ...turn('again')], keep: true });
  listed = await chatHistory.listForActiveFolder();
  assert.equal(listed.sessions.find((row) => row.id === 'old').keep, true);
  assert.equal(listed.sessions.find((row) => row.id === 'c3').keep, undefined, 'a save cannot set it');

  // Without the mark the chat counts again from the folder's next save on.
  assert.deepEqual(await chatHistory.setKeep('old', false), { ok: true, keep: false });
  await save(chatHistory, 'c4', folderA);
  assert.deepEqual(ids((await chatHistory.listForActiveFolder()).sessions), ['c3', 'c4']);
});

test('Keep refuses what it is not meant for', async (t) => {
  const { chatHistory, folderA, folderB } = await setup(t);
  await save(chatHistory, 'a1', folderA);
  await save(chatHistory, 'b1', folderB);
  assert.deepEqual(await chatHistory.setKeep('b1', true), { ok: false }, 'another folder\'s chat');
  assert.deepEqual(await chatHistory.setKeep('nope', true), { ok: false });
  assert.deepEqual(await chatHistory.setKeep('a1', 'yes'), { ok: false }, 'only a boolean');
  assert.deepEqual(await chatHistory.setKeep('   ', true), { ok: false });
  assert.deepEqual(await chatHistory.setKeep('a1', false), { ok: true, keep: false }, 'a mark that stays is no error');
});

test('chats whose folder is gone are listed, and move into the open folder', async (t) => {
  const { chatHistory, tmpDir, folderA, folderB, open } = await setup(t, { perFolder: 5 });
  const renamed = path.join(tmpDir, 'renamed');
  await save(chatHistory, 'r1', renamed);
  await save(chatHistory, 'r2', renamed);
  await save(chatHistory, 'b1', folderB);
  await fs.mkdir(renamed);
  open(renamed);
  await chatHistory.setActive('r2');
  open(folderA);

  // Its folder is still there: nothing is orphaned, and nothing moves.
  assert.deepEqual((await chatHistory.listForActiveFolder()).orphaned, []);
  assert.deepEqual(await chatHistory.assignToActiveFolder('r1'), { ok: false });

  await removeDir(renamed);
  const listed = await chatHistory.listForActiveFolder();
  assert.deepEqual(ids(listed.orphaned), ['r1', 'r2']);
  assert.equal(listed.orphaned[0].workspaceRoot, renamed, 'the row names the folder it was in');
  assert.deepEqual(ids(listed.sessions), [], 'not mixed into the folder\'s own chats');

  assert.deepEqual(await chatHistory.assignToActiveFolder('r2'), { ok: true, workspaceRoot: folderA });
  const after = await chatHistory.listForActiveFolder();
  assert.deepEqual(ids(after.sessions), ['r2']);
  assert.deepEqual(ids(after.orphaned), ['r1']);
  assert.equal((await chatHistory.getSession('r2')).messages.length, 2, 'the open folder hands the chat out now');
  assert.deepEqual(await chatHistory.assignToActiveFolder('b1'), { ok: false }, 'a chat of a folder that is there stays');
  assert.deepEqual(await chatHistory.assignToActiveFolder('r2'), { ok: false }, 'one of the open folder is no orphan');

  // The gone folder's pointer to the chat went with it.
  await fs.mkdir(renamed);
  open(renamed);
  const back = await chatHistory.listForActiveFolder();
  assert.equal(back.activeChatId, null);
  assert.deepEqual(ids(back.sessions), ['r1']);
});

test('with no folder open nothing is assigned', async (t) => {
  const { chatHistory, tmpDir, open } = await setup(t);
  const gone = path.join(tmpDir, 'gone');
  await save(chatHistory, 'g1', gone);
  open(null);
  assert.deepEqual(await chatHistory.assignToActiveFolder('g1'), { ok: false });
  assert.deepEqual(await chatHistory.assignToActiveFolder(''), { ok: false });
});

test('Keep and the new folder are in the chat\'s own file too: losing the index loses neither', async (t) => {
  const { chatHistory, tmpDir, folderA, userData } = await setup(t);
  await save(chatHistory, 'a1', folderA);
  await save(chatHistory, 'g1', path.join(tmpDir, 'gone'));
  await chatHistory.setKeep('a1', true);
  await chatHistory.assignToActiveFolder('g1');

  const fileOf = async (id) => JSON.parse(await fs.readFile(path.join(userData, 'chat-history', chatSessionFileName(id)), 'utf8')).session;
  assert.equal((await fileOf('a1')).keep, true);
  assert.equal((await fileOf('g1')).workspaceRoot, folderA);
  assert.equal((await fileOf('g1')).messages.length, 2, 'the messages stay as they were');

  await fs.rm(path.join(userData, 'chat-history', 'index.json'));
  const fresh = createStorageService({
    userDataPath: userData,
    secretStore: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions: 100,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const metas = await fresh.listChatSessions();
  assert.equal(metas.find((meta) => meta.id === 'a1').keep, true);
  assert.equal(metas.find((meta) => meta.id === 'g1').workspaceRoot, folderA);
});

test('a save from a turn that began before the move does not carry the chat back', async (t) => {
  const { chatHistory, tmpDir, folderA } = await setup(t);
  const gone = path.join(tmpDir, 'gone');
  await save(chatHistory, 'g1', gone);
  await chatHistory.assignToActiveFolder('g1');
  await chatHistory.saveSession({ id: 'g1', messages: [...turn('g1'), ...turn('later')], workspaceRoot: gone });
  const listed = await chatHistory.listForActiveFolder();
  assert.deepEqual(ids(listed.sessions), ['g1']);
  assert.equal(listed.sessions[0].workspaceRoot, folderA);
  assert.deepEqual(listed.orphaned, []);
});

test('Assign all moves every chat of a folder that is gone, and nothing else', async (t) => {
  const { chatHistory, tmpDir, folderA, folderB, open } = await setup(t, { perFolder: 10 });
  const gone = path.join(tmpDir, 'gone');
  const other = path.join(tmpDir, 'other-gone');
  for (const id of ['g1', 'g2', 'g3']) await save(chatHistory, id, gone);
  await save(chatHistory, 'x1', other);
  await save(chatHistory, 'b1', folderB);
  await fs.mkdir(gone);
  open(gone);
  await chatHistory.setActive('g2');
  open(folderA);
  await removeDir(gone);

  assert.deepEqual(await chatHistory.assignFolderToActiveFolder(folderB), { ok: false, count: 0 }, 'a folder that is there');
  assert.deepEqual(await chatHistory.assignFolderToActiveFolder(folderA), { ok: false, count: 0 }, 'the open folder itself');
  assert.deepEqual(await chatHistory.assignFolderToActiveFolder(''), { ok: false, count: 0 });
  assert.deepEqual(await chatHistory.assignFolderToActiveFolder(path.join(tmpDir, 'never')), { ok: false, count: 0 }, 'no chats there');

  assert.deepEqual(await chatHistory.assignFolderToActiveFolder(gone), { ok: true, count: 3, workspaceRoot: folderA });
  const listed = await chatHistory.listForActiveFolder();
  assert.deepEqual(ids(listed.sessions), ['g1', 'g2', 'g3']);
  assert.deepEqual(ids(listed.orphaned), ['x1'], 'another missing folder stays as it is');

  await fs.mkdir(gone);
  open(gone);
  assert.equal((await chatHistory.listForActiveFolder()).activeChatId, null, 'the old pointer went with the chat');
  open(null);
  assert.deepEqual(await chatHistory.assignFolderToActiveFolder(other), { ok: false, count: 0 }, 'no folder open');
});

test('the IPC channels delegate Keep and Assign to this folder', async (t) => {
  const { chatHistory, tmpDir, folderA } = await setup(t);
  /** @type {Map<string, Function>} */
  const handlers = new Map();
  registerChatHistoryHandlers({ ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) }, chatHistory, REQ });
  await save(chatHistory, 'a1', folderA);
  await save(chatHistory, 'g1', path.join(tmpDir, 'gone'));

  assert.deepEqual(await handlers.get(REQ.CHAT_HISTORY_SET_KEEP)({}, 'a1', true), { ok: true, keep: true });
  assert.deepEqual(await handlers.get(REQ.CHAT_HISTORY_ASSIGN_TO_FOLDER)({}, 'g1'), { ok: true, workspaceRoot: folderA });
  const listed = await handlers.get(REQ.CHAT_HISTORY_GET)({});
  assert.deepEqual(ids(listed.sessions), ['a1', 'g1']);
  await save(chatHistory, 'h1', path.join(tmpDir, 'gone-too'));
  await save(chatHistory, 'h2', path.join(tmpDir, 'gone-too'));
  assert.deepEqual(await handlers.get(REQ.CHAT_HISTORY_ASSIGN_ALL_TO_FOLDER)({}, path.join(tmpDir, 'gone-too')),
    { ok: true, count: 2, workspaceRoot: folderA });
});
