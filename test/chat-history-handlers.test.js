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

async function setup(t, { maxChatSessions = 3, chatSessionSettings } = {}) {
  // Der Zeitstempel kommt seit Issue #245 aus dem Main. Im Test laeuft dafuer
  // eine eigene Uhr: echte Millisekunden lagen bei aufeinanderfolgenden
  // Upserts gleichauf, und eine Reihenfolge waere nicht mehr pruefbar.
  let clock = 1_000_000;
  const now = () => (clock += 1000);
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
  // Issue #131: welche Ordner der Nutzer schon geoeffnet hat, entscheidet, ob
  // eine Session den von ihr genannten Workspace behalten darf.
  let knownRoots = new Set();
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore,
    REQ,
    getActiveWorkspaceRoot: () => activeRoot,
    isKnownWorkspaceRoot: async (folderPath) => knownRoots.has(path.resolve(folderPath)),
    now,
    ...(chatSessionSettings ? { chatSessionSettings } : {}),
  });
  const setActiveRoot = (root) => {
    activeRoot = root ?? null;
  };
  const setKnownRoots = (...roots) => {
    knownRoots = new Set(roots.map((r) => path.resolve(r)));
  };
  return { ipcMain, storage, tmpDir, setActiveRoot, setKnownRoots, now: () => clock };
}

// `updatedAt` reicht der Renderer seit Issue #245 nicht mehr mit — der Main
// stempelt selbst. Wo ein Test den Wert noch nennt, prueft er, dass er
// wirkungslos bleibt.
function sessionRow(id, { updatedAt, title = `Chat ${id}`, messages } = {}) {
  return {
    id,
    title,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    messages: messages || [{ role: 'user', content: `hello from ${id}` }],
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

test('Chat-Verlauf ignoriert einen nie geoeffneten Workspace aus dem Renderer (#68)', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot } = await setup(t);
  const ws = tmpDir;
  setActiveRoot(ws);

  // Manipulierte Payload: Session behauptet, zu '/' zu gehoeren. Seit #131 darf
  // eine Session ihren Root zwar nennen — aber nur einen bereits geoeffneten
  // Ordner, und '/' ist hier keiner.
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

/* Issue #131: Konversationen sind an den Ordner gebunden, in dem sie gefuehrt
 * wurden. Der Renderer sichert den laufenden Chat erst, wenn der neue Ordner im
 * Main bereits aktiv ist — die Session muss ihren eigenen Root trotzdem
 * behalten, sonst wandert sie beim Wechsel mit. */
test('Ordnerwechsel laesst die Konversation beim alten Ordner (Issue #131)', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot, setKnownRoots } = await setup(t);
  const wsA = path.join(tmpDir, 'projekt-a');
  const wsB = path.join(tmpDir, 'projekt-b');
  setKnownRoots(wsA, wsB);

  setActiveRoot(wsA);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, { ...sessionRow('a'), workspaceRoot: wsA });
  await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'a');

  // Ab hier ist im Main schon Ordner B aktiv, der Renderer sichert erst jetzt.
  setActiveRoot(wsB);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, { ...sessionRow('a'), workspaceRoot: wsA });
  await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'a');

  const inB = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(inB.sessions.map((s) => s.id), [], 'Chat aus A darf nicht in B auftauchen');
  assert.equal(inB.activeChatId, null, 'und auch nicht als aktiver Chat von B');

  setActiveRoot(wsA);
  const inA = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(inA.sessions.map((s) => s.id), ['a']);
  assert.equal(inA.activeChatId, 'a');
});

test('ein unbekannter Workspace faellt auf den aktiven Ordner zurueck (Issue #68)', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot, setKnownRoots } = await setup(t);
  const ws = path.join(tmpDir, 'projekt-a');
  setActiveRoot(ws);
  setKnownRoots(ws);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, {
    ...sessionRow('a'),
    workspaceRoot: path.join(tmpDir, 'nie-geoeffnet'),
  });

  const inWs = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(inWs.sessions.map((s) => s.id), ['a']);
});

test('ein ausdruecklich ordnerloser Chat behaelt seinen eigenen Bucket', async (t) => {
  const { ipcMain, tmpDir, setActiveRoot, setKnownRoots } = await setup(t);
  const ws = path.join(tmpDir, 'projekt-a');
  setKnownRoots(ws);

  // Chat ohne Ordner gefuehrt, danach Ordner geoeffnet und erst dann gesichert.
  setActiveRoot(ws);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, { ...sessionRow('a'), workspaceRoot: null });
  await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'a');

  const inWs = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(inWs.sessions.map((s) => s.id), []);
  assert.equal(inWs.activeChatId, null);

  setActiveRoot(null);
  const noWs = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(noWs.sessions.map((s) => s.id), ['a']);
  assert.equal(noWs.activeChatId, 'a');
});

/**
 * Modell und Freigabemodus des Chats (Issue #211): Der Renderer stoesst den
 * Wechsel an, die Werte selbst liegen im Main.
 */
function fakeChatSessionSettings(values = {}) {
  const calls = { activate: [], forget: [] };
  return {
    calls,
    activate: async (chatId, options) => {
      calls.activate.push({ chatId, ...options });
      return { chatId };
    },
    valuesFor: (chatId) => ({ ...(values[chatId] || {}) }),
    forget: (chatId) => calls.forget.push(chatId),
  };
}

test('Modell und Freigabemodus des Chats kommen aus dem Main, nicht aus der Nutzlast', async (t) => {
  const chatSessionSettings = fakeChatSessionSettings({
    a: { modelPresetId: 'preset-echt', toolPermissionMode: 'ask-all' },
  });
  const { ipcMain, storage } = await setup(t, { chatSessionSettings });

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, {
    ...sessionRow('a'),
    // Ein Renderer, der sich selbst Rechte geben will: wird verworfen.
    modelPresetId: 'preset-untergeschoben',
    toolPermissionMode: 'auto',
  });

  const store = await storage.readChatHistoryStore();
  const stored = store.sessions.find((x) => x.id === 'a');
  assert.equal(stored.modelPresetId, 'preset-echt');
  assert.equal(stored.toolPermissionMode, 'ask-all');
});

test('ohne gemerkte Werte bleibt stehen, was schon gespeichert war', async (t) => {
  const chatSessionSettings = fakeChatSessionSettings({
    a: { modelPresetId: 'preset-echt', toolPermissionMode: 'auto' },
  });
  const { ipcMain, storage } = await setup(t, { chatSessionSettings });

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));
  // Zweiter Lauf ohne Merkwerte — etwa nach einem Neustart.
  chatSessionSettings.valuesFor = () => ({});
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, { ...sessionRow('a'), updatedAt: 2000 });

  const store = await storage.readChatHistoryStore();
  const stored = store.sessions.find((x) => x.id === 'a');
  assert.equal(stored.modelPresetId, 'preset-echt');
  assert.equal(stored.toolPermissionMode, 'auto');
});

test('der Wechsel meldet dem Main, ob er ausdruecklich war', async (t) => {
  const chatSessionSettings = fakeChatSessionSettings();
  const { ipcMain } = await setup(t, { chatSessionSettings });

  await ipcMain.invoke(REQ.CHAT_HISTORY_ACTIVATE, 'a', 'explicit');
  await ipcMain.invoke(REQ.CHAT_HISTORY_ACTIVATE, 'b', 'auto');
  // Unbekannte Angabe gilt als ausdruecklich — sie kann nur aus der App kommen,
  // und ein automatischer Wechsel nennt sich ausdruecklich `auto`.
  await ipcMain.invoke(REQ.CHAT_HISTORY_ACTIVATE, 'c');

  assert.deepEqual(chatSessionSettings.calls.activate, [
    { chatId: 'a', activation: 'explicit' },
    { chatId: 'b', activation: 'auto' },
    { chatId: 'c', activation: 'explicit' },
  ]);
});

test('ein geloeschter Chat wird auch im Main vergessen', async (t) => {
  const chatSessionSettings = fakeChatSessionSettings();
  const { ipcMain } = await setup(t, { chatSessionSettings });

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));
  await ipcMain.invoke(REQ.CHAT_HISTORY_DELETE, 'a');

  assert.deepEqual(chatSessionSettings.calls.forget, ['a']);
});

// ---------------------------------------------------------------------------
// Wann ein Chat zuletzt gefuehrt wurde (Issue #245).
//
// Der Zeitstempel ist die einzige Zeitangabe einer Session — er traegt die
// Uhrzeit im Verlauf, dessen Sortierung, die Auswahl des wiederherzustellenden
// Chats und die Reihenfolge beim Abschneiden. Frueher stempelte der Renderer
// bei jedem Schreiben, und der schreibt auch, wenn gar nichts gesprochen
// wurde. Seitdem setzt ihn der Main, und nur bei einem Zug.
// ---------------------------------------------------------------------------

async function storedSession(storage, id) {
  const store = await storage.readChatHistoryStore();
  return store.sessions.find((s) => s.id === id);
}

test('#245: Oeffnen und Verlassen ohne Eingabe laesst den Zeitpunkt stehen', async (t) => {
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t);
  setActiveRoot(tmpDir);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));
  const gefuehrt = (await storedSession(storage, 'a')).updatedAt;

  // Genau das, was der Renderer beim Verlassen eines nur angesehenen Chats
  // schickt: derselbe Nachrichtenstand noch einmal.
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));

  assert.equal((await storedSession(storage, 'a')).updatedAt, gefuehrt);
});

test('#245: ein Modell- oder Moduswechsel verschiebt den Zeitpunkt nicht', async (t) => {
  const chatSessionSettings = fakeChatSessionSettings();
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t, { chatSessionSettings });
  setActiveRoot(tmpDir);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));
  const gefuehrt = (await storedSession(storage, 'a')).updatedAt;

  // Der Nutzer stellt in der Chat-Leiste um; der Main merkt sich den Wert und
  // gibt ihn beim naechsten Schreiben mit (Issue #211).
  chatSessionSettings.valuesFor = () => ({
    modelPresetId: 'preset-neu',
    toolPermissionMode: 'ask-all',
  });
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));

  const stored = await storedSession(storage, 'a');
  assert.equal(stored.modelPresetId, 'preset-neu', 'der Wert selbst wird gespeichert');
  assert.equal(stored.toolPermissionMode, 'ask-all');
  assert.equal(stored.updatedAt, gefuehrt, 'eine Einstellung ist keine Unterhaltung');
});

test('#245: eine gesendete Nachricht setzt den Zeitpunkt auf jetzt', async (t) => {
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t);
  setActiveRoot(tmpDir);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a'));
  const vorher = (await storedSession(storage, 'a')).updatedAt;

  await ipcMain.invoke(
    REQ.CHAT_HISTORY_UPSERT,
    sessionRow('a', {
      messages: [
        { role: 'user', content: 'hello from a' },
        { role: 'user', content: 'und noch eine Frage' },
      ],
    })
  );

  assert.ok((await storedSession(storage, 'a')).updatedAt > vorher);
});

test('#245: eine eingetroffene Antwort setzt den Zeitpunkt, auch bei gleicher Anzahl', async (t) => {
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t);
  setActiveRoot(tmpDir);

  const laufend = [
    { role: 'user', content: 'Was steht in der Datei?' },
    { role: 'assistant', content: 'Einen Moment' },
  ];
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a', { messages: laufend }));
  const vorher = (await storedSession(storage, 'a')).updatedAt;

  await ipcMain.invoke(
    REQ.CHAT_HISTORY_UPSERT,
    sessionRow('a', {
      messages: [laufend[0], { role: 'assistant', content: 'Die vollstaendige Antwort' }],
    })
  );

  assert.ok((await storedSession(storage, 'a')).updatedAt > vorher);
});

test('#245: ein nachgezogener Titel verschiebt den Zeitpunkt nicht', async (t) => {
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t);
  setActiveRoot(tmpDir);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a', { title: '' }));
  const antwort = (await storedSession(storage, 'a')).updatedAt;

  // Das Modell benennt die Konversation im Hintergrund, nachdem die Antwort
  // schon steht — der Chat darf dadurch nicht juenger werden als die Antwort.
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a', { title: 'Vom Modell benannt' }));

  const stored = await storedSession(storage, 'a');
  assert.equal(stored.title, 'Vom Modell benannt');
  assert.equal(stored.updatedAt, antwort);
});

test('#245: ein Zeitpunkt aus der Nutzlast gilt nicht', async (t) => {
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t);
  setActiveRoot(tmpDir);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('a', { updatedAt: 9_999_999_999 }));

  const stored = await storedSession(storage, 'a');
  assert.notEqual(stored.updatedAt, 9_999_999_999);
  assert.ok(Number.isFinite(stored.updatedAt));
});

test('#245: ein nur angesehener Chat bleibt im Verlauf, wo er war', async (t) => {
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t, { maxChatSessions: 10 });
  setActiveRoot(tmpDir);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('alt'));
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('neu'));

  // „alt“ geoeffnet, das Modell gewechselt, wieder weggewechselt.
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionRow('alt'));

  const got = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(got.sessions.map((s) => s.id), ['neu', 'alt']);
  assert.ok((await storedSession(storage, 'alt')).updatedAt < (await storedSession(storage, 'neu')).updatedAt);
});

test('#245: eine Verlaufsdatei aus einer aelteren Version wird nicht neu gestempelt', async (t) => {
  const { ipcMain, storage, tmpDir, setActiveRoot } = await setup(t);
  setActiveRoot(tmpDir);

  // So sah eine Zeile vor der Vereinheitlichung aus: Felder in anderer
  // Reihenfolge, dazu Reste, die die Sanitisierung heute wegnimmt.
  const store = await storage.readChatHistoryStore();
  store.sessions.push({
    updatedAt: 1234,
    id: 'legacy',
    messages: [
      { content: 'hello from legacy', role: 'user' },
      { streaming: false, role: 'assistant', content: 'Antwort', toolTrace: [{ text: 'ok' }] },
    ],
    title: 'Alter Chat',
    workspaceRoot: tmpDir,
  });
  await storage.writeChatHistoryStore(store);

  // Der Renderer laedt sie und schreibt sie beim Verlassen unveraendert zurueck.
  const geladen = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  const session = geladen.sessions.find((s) => s.id === 'legacy');
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, {
    id: 'legacy',
    title: session.title,
    workspaceRoot: session.workspaceRoot,
    messages: session.messages,
  });

  assert.equal((await storedSession(storage, 'legacy')).updatedAt, 1234);
});
