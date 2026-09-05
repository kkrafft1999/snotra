const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { registerChatHistoryHandlers } = require('../src/main/ipc/chat-history-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

const mockProviders = {
  getProvider(id) {
    return id === 'openai' ? { defaultModel: 'gpt-4o', fields: { apiKey: true } } : null;
  },
};

async function setup(t, { maxChatSessions = 3 } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-chathist-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const storage = createStorageService({
    app: { getPath: () => tmpDir },
    safeStorage: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog((id) => mockProviders.getProvider(id)),
    maxChatSessions,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const chatHistoryStore = createChatHistoryStorePort(storage);
  const ipcMain = createMockIpcMain();
  // Der aktive Workspace kommt seit Issue #68 aus dem Main-Prozess, nicht mehr
  // als Argument der Aufrufe — im Test steuert ihn setActiveRoot.
  let activeRoot = null;
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore,
    REQ,
    getActiveWorkspaceRoot: () => activeRoot,
  });
  const setActiveRoot = (root) => {
    activeRoot = root ?? null;
  };
  return { ipcMain, storage, tmpDir, setActiveRoot };
}

function sessionRow(id, { updatedAt = 1000, title = `Chat ${id}` } = {}) {
  return {
    id,
    title,
    updatedAt,
    messages: [{ role: 'user', content: `hello from ${id}` }],
  };
}

test('upsert + get round-trips a session and respects workspace filtering', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));
  await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'a');

  setActiveRoot(null);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('b'));

  setActiveRoot(ws);
  const inWs = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(inWs.sessions.map((s) => s.id), ['a']);
  assert.equal(inWs.activeChatId, 'a');

  setActiveRoot(null);
  const noWs = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(noWs.sessions.map((s) => s.id), ['b']);
  assert.equal(noWs.activeChatId, null);
});

test('upsert rejects invalid session rows', async (t) => {
  const { ipcMain } = await setup(t);
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, null), { ok: false });
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, { id: '   ' }), { ok: false });
});

test('delete removes the session and its active pointer', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));
  await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'a');

  const res = await ipcMain.invoke(REQ.CHAT_HISTORY_DELETE, 'a');
  assert.equal(res.ok, true);

  const after = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(after.sessions, []);
  assert.equal(after.activeChatId, null);

  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_DELETE, ''), { ok: false });
});

test('setActive clears the pointer for empty ids', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));
  await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'a');
  await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, null);
  const after = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(after.activeChatId, null);
});

test('pruning beyond MAX_CHAT_SESSIONS drops oldest sessions and their active pointers', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t, { maxChatSessions: 3 });
  const ws = tmpDir;
  setActiveRoot(ws);
  for (let i = 1; i <= 4; i++) {
    await ipcMain.invoke(
      REQ.CHAT_HISTORY_UPSERT,
      sessionRow(`s${i}`, { updatedAt: i * 1000 })
    );
    if (i === 1) await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 's1');
  }
  const after = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(after.sessions.map((s) => s.id), ['s4', 's3', 's2']);
  assert.equal(after.activeChatId, null, 'active pointer to pruned s1 must be cleared');
});

test('parallel upserts of distinct sessions lose no updates', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t, { maxChatSessions: 100 });
  const ws = tmpDir;
  setActiveRoot(ws);
  const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
  await Promise.all(
    ids.map((id, i) =>
      ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow(id, { updatedAt: i }))
    )
  );
  const after = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(new Set(after.sessions.map((s) => s.id)), new Set(ids));
});

test('parallel upsert/delete/setActive interleaving stays consistent', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t, { maxChatSessions: 100 });
  const ws = tmpDir;
  setActiveRoot(ws);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('keep'));

  await Promise.all([
    ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('temp')),
    ipcMain.invoke(REQ.CHAT_HISTORY_DELETE, 'temp'),
    ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'keep'),
    ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('keep', { title: 'Updated' })),
  ]);

  const after = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  const keep = after.sessions.find((s) => s.id === 'keep');
  assert.ok(keep, 'session "keep" must survive the interleaving');
  assert.equal(keep.title, 'Updated');
  assert.equal(after.activeChatId, 'keep');
});

test('repeated upserts of the same id serialize through the lock (last write wins)', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t, { maxChatSessions: 100 });
  const ws = tmpDir;
  setActiveRoot(ws);
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      ipcMain.invoke(
        REQ.CHAT_HISTORY_UPSERT,
        sessionRow('same', { updatedAt: 1000 + i, title: `v${i}` })
      )
    )
  );
  const after = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(after.sessions.length, 1, 'concurrent upserts of one id must not duplicate it');
  assert.equal(after.sessions[0].title, 'v9');
});

test('upsert accepts semantic live messages and GET returns normalized loaded shape', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);

  const upsertRes = await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, {
    id: 'rich',
    updatedAt: 5000,
    messages: [
      { role: 'user', content: 'Was steht in der Datei?' },
      {
        role: 'assistant',
        content: 'Hier ist die Antwort.',
        streaming: true,
        phase: 'generating',
        toolTrace: [{ line: 'Datei wird gelesen …' }, 'Datei gelesen'],
        reasoningText: '  Zwischenschritt  ',
        isError: false,
      },
      { role: 'system', content: 'drop me' },
    ],
    tokenUsage: { prompt: 12.4, completion: '7', total: null },
  });
  assert.equal(upsertRes.ok, true);

  const got = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(got.sessions.length, 1);
  const session = got.sessions[0];
  assert.equal(session.title, 'Was steht in der Datei?');
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[0].streaming, undefined);
  assert.equal(session.messages[1].streaming, false);
  assert.deepEqual(session.messages[1].toolTrace, ['Datei wird gelesen …', 'Datei gelesen']);
  assert.equal(session.messages[1].reasoningText, 'Zwischenschritt');
  assert.deepEqual(session.tokenUsage, { prompt: 12, completion: 7, total: 19 });
});

test('GET normalizes legacy on-disk session rows', async (t) => {
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);

  await storage.withChatHistoryLock(async () => {
    const store = await storage.readChatHistoryStore({ skipMigration: true });
    store.sessions.push({
      id: 'legacy',
      workspaceRoot: ws,
      title: 'Alter Titel',
      updatedAt: 100,
      messages: [{ role: 'assistant', content: 'gespeichert', toolTrace: ['ok'], isError: true }],
    });
    await storage.writeChatHistoryStore(store);
  });

  const got = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  const legacy = got.sessions.find((s) => s.id === 'legacy');
  assert.ok(legacy);
  assert.equal(legacy.title, 'Alter Titel');
  assert.deepEqual(legacy.tokenUsage, { prompt: 0, completion: 0, total: 0 });
  assert.equal(legacy.messages[0].streaming, false);
  assert.equal(legacy.messages[0].isError, true);
  assert.deepEqual(legacy.messages[0].toolTrace, ['ok']);
});

test('upsert preserves an existing stored title when the semantic payload omits title', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);

  await ipcMain.invoke(
    REQ.CHAT_HISTORY_UPSERT,
    sessionRow('keep-title', { title: 'Mein gespeicherter Titel', updatedAt: 1000 })
  );

  const upsertRes = await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, {
    id: 'keep-title',
    updatedAt: 2000,
    messages: [{ role: 'user', content: 'Späterer Verlauf ohne Titel im Payload' }],
  });
  assert.equal(upsertRes.ok, true);

  const got = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  const session = got.sessions.find((s) => s.id === 'keep-title');
  assert.equal(session.title, 'Mein gespeicherter Titel');
});

test('upsert rejects a session whose sanitized messages become empty', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);

  const res = await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, {
    id: 'empty',
    updatedAt: 1000,
    messages: [
      { role: 'user', content: '   ' },
      { role: 'assistant', content: '   ' },
      { role: 'system', content: 'ignored' },
    ],
  });
  assert.deepEqual(res, { ok: false });

  const got = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(got.sessions.length, 0);
});

test('Chat-Verlauf ignoriert einen vom Renderer mitgeschickten Workspace (#68)', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);

  // Manipulierte Payload: Session behauptet, zu '/' zu gehoeren.
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, { ...sessionRow('a'), workspaceRoot: '/' });
  await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'a', '/');

  const inWs = await ipcMain.invoke(REQ.CHAT_HISTORY_GET, '/');
  assert.equal(inWs.workspaceRoot, ws, 'gefiltert wird nach dem aktiven Root des Main-Prozesses');
  assert.deepEqual(inWs.sessions.map((s) => s.id), ['a']);
  assert.equal(inWs.activeChatId, 'a');

  setActiveRoot(null);
  const elsewhere = await ipcMain.invoke(REQ.CHAT_HISTORY_GET, ws);
  assert.deepEqual(elsewhere.sessions, [], 'die Session haengt am aktiven Root, nicht am Payload');
});
