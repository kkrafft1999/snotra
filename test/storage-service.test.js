const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createMockProviderCatalog } = require('./helpers/provider-ports');

const mockProviders = {
  getProvider(id) {
    if (id === 'openai') {
      return {
        id: 'openai',
        name: 'OpenAI',
        defaultModel: 'gpt-4o',
        fields: { apiKey: true },
        presentation: {
          presetFields: [{
            key: 'reasoningEffort',
            options: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }],
          }],
        },
      };
    }
    if (id === 'anthropic') {
      return {
        id: 'anthropic',
        name: 'Anthropic',
        defaultModel: 'claude-test',
        fields: { apiKey: true },
        presentation: {},
      };
    }
    // Der generische Anbieter aus Issue #193.
    if (id === 'openai-compatible') {
      return {
        id: 'openai-compatible',
        name: 'OpenAI-kompatibel',
        defaultModel: '',
        optionalApiKey: true,
        connectionPerPreset: true,
        defaultBaseUrl: 'http://localhost:1234/v1',
        defaultApiStyle: 'chat',
        defaultSendTools: true,
        defaultSupportsImages: false,
        fields: {
          apiKey: true,
          baseUrl: true,
          insecureTls: true,
          displayName: true,
          apiStyle: true,
          extraHeaders: true,
          supportsImages: true,
          sendTools: true,
        },
        presentation: {},
      };
    }
    return null;
  },
};

function makeStorage(tmpDir) {
  return createStorageService({
    app: { getPath: () => tmpDir },
    safeStorage: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog((id) => mockProviders.getProvider(id)),
    maxChatSessions: 3,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
}

function makeEncryptedSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString(plaintext) {
      return Buffer.from(`enc:${plaintext}`, 'utf8');
    },
    decryptString(buf) {
      const s = buf.toString('utf8');
      if (!s.startsWith('enc:')) throw new Error('bad cipher');
      return s.slice(4);
    },
  };
}

function makeStorageWithEncryption(tmpDir) {
  return createStorageService({
    app: { getPath: () => tmpDir },
    safeStorage: makeEncryptedSafeStorage(),
    fs,
    path,
    providerCatalog: createMockProviderCatalog((id) => mockProviders.getProvider(id)),
    maxChatSessions: 3,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
}

test('normalizePresetEntry validates provider and model', () => {
  const storage = makeStorage('/tmp/unused');
  assert.equal(storage.normalizePresetEntry(null), null);
  assert.equal(storage.normalizePresetEntry({ id: '', providerId: 'openai' }), null);
  assert.equal(storage.normalizePresetEntry({ id: 'p1', providerId: 'unknown' }), null);

  const preset = storage.normalizePresetEntry({
    id: 'p1',
    providerId: 'openai',
    model: 'gpt-4o-mini',
    reasoningEffort: 'high',
  });
  assert.deepEqual(preset, {
    id: 'p1',
    providerId: 'openai',
    model: 'gpt-4o-mini',
    reasoningEffort: 'high',
    menuVisible: true,
  });
});

test('resolveChatModelTarget prefers active preset', () => {
  const storage = makeStorage('/tmp/unused');
  const target = storage.resolveChatModelTarget({
    activePresetId: 'p1',
    activeProvider: 'openai',
    presets: [
      { id: 'p1', providerId: 'anthropic', model: 'claude-custom', menuVisible: true },
    ],
    providers: {},
  });
  assert.deepEqual(target, {
    providerId: 'anthropic',
    // Die Eintrags-Kennung reist mit, damit sich bei `connectionPerPreset` die
    // Verbindung aufloesen laesst (Issue #202).
    presetId: 'p1',
    model: 'claude-custom',
    reasoningEffort: null,
  });
});

test('resolveChatModelTarget emits providerOptions from declared preset fields', () => {
  const storage = makeStorage('/tmp/unused');
  const openai = storage.normalizePresetEntry({
    id: 'p1',
    providerId: 'openai',
    model: 'gpt-4o-mini',
    reasoningEffort: 'high',
  });
  const target = storage.resolveChatModelTarget({
    activePresetId: 'p1',
    presets: [openai],
    providers: { openai: { apiKeyEnc: 'x' } },
  });
  assert.equal(target.providerId, 'openai');
  assert.deepEqual(target.providerOptions, { reasoningEffort: 'high' });
  assert.equal(target.reasoningEffort, 'high');
});

test('normalizeSessionForStore infers title from first user message when title omitted', () => {
  const storage = makeStorage('/tmp/unused');
  const session = storage.normalizeSessionForStore({
    id: 's1',
    updatedAt: 42,
    workspaceRoot: '/tmp/ws',
    messages: [{ role: 'user', content: 'Mein Chat-Titel' }],
  });
  assert.equal(session.title, 'Mein Chat-Titel');
});

test('normalizeSessionForStore strips invalid roles and caps title', () => {
  const storage = makeStorage('/tmp/unused');
  const session = storage.normalizeSessionForStore({
    id: 's1',
    title: 'x'.repeat(300),
    updatedAt: 42,
    workspaceRoot: '/tmp/ws',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', reasoningText: 'think' },
      { role: 'system', content: 'ignored' },
    ],
  });
  assert.equal(session.title.length, 200);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[1].reasoningText, 'think');
});

test('normalizeSessionForStore persists tokenUsage totals', () => {
  const storage = makeStorage('/tmp/unused');
  const session = storage.normalizeSessionForStore({
    id: 's1',
    title: 'Chat',
    updatedAt: 42,
    workspaceRoot: '/tmp/ws',
    messages: [{ role: 'user', content: 'hi' }],
    tokenUsage: { prompt: 100, completion: 50, total: 150 },
  });
  assert.deepEqual(session.tokenUsage, { prompt: 100, completion: 50, total: 150 });
});

test('normalizeSessionForStore defaults missing tokenUsage to zero', () => {
  const storage = makeStorage('/tmp/unused');
  const session = storage.normalizeSessionForStore({
    id: 's1',
    title: 'Chat',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.deepEqual(session.tokenUsage, { prompt: 0, completion: 0, total: 0 });
});

test('writeJsonAtomic keeps previous file on interrupted write simulation', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const storage = makeStorage(tmpDir);
  await storage.writeUIPrefs({ contentPaneVisible: true, appLocale: 'de' });

  const target = path.join(tmpDir, 'ui-preferences.json');
  const original = await fs.readFile(target, 'utf8');

  const realWriteFile = fs.writeFile.bind(fs);
  let failNext = true;
  fs.writeFile = async (filePath, data, encoding) => {
    await realWriteFile(filePath, data, encoding);
    if (failNext && String(filePath).includes('.tmp-')) {
      failNext = false;
      throw new Error('simulated crash');
    }
  };

  await assert.rejects(() => storage.writeUIPrefs({ contentPaneVisible: false, appLocale: 'en' }));
  fs.writeFile = realWriteFile;

  const after = await fs.readFile(target, 'utf8');
  assert.equal(after, original);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('withChatHistoryLock serializes concurrent upserts', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const storage = makeStorage(tmpDir);

  await Promise.all([
    storage.withChatHistoryLock(async () => {
      const store = await storage.readChatHistoryStore({ skipMigration: true });
      store.sessions.push({
        id: 'a',
        workspaceRoot: null,
        title: 'A',
        updatedAt: 1,
        messages: [],
      });
      await storage.writeChatHistoryStore(store);
    }),
    storage.withChatHistoryLock(async () => {
      const store = await storage.readChatHistoryStore({ skipMigration: true });
      store.sessions.push({
        id: 'b',
        workspaceRoot: null,
        title: 'B',
        updatedAt: 2,
        messages: [],
      });
      await storage.writeChatHistoryStore(store);
    }),
  ]);

  const final = await storage.readChatHistoryStore();
  assert.equal(final.sessions.length, 2);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('writeChatHistoryStore encrypts when safeStorage available', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const storage = makeStorageWithEncryption(tmpDir);
  const store = {
    version: 2,
    activeByWorkspace: {},
    sessions: [{
      id: 's1',
      workspaceRoot: null,
      title: 'Test',
      updatedAt: 1,
      messages: [{ role: 'user', content: 'hello' }],
    }],
  };

  await storage.writeChatHistoryStore(store);

  const raw = await fs.readFile(path.join(tmpDir, 'chat-history.json'), 'utf8');
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.encrypted, true);
  assert.equal(typeof onDisk.payload, 'string');
  assert.equal(onDisk.version, undefined);

  const roundtrip = await storage.readChatHistoryStore();
  assert.equal(roundtrip.sessions.length, 1);
  assert.equal(roundtrip.sessions[0].id, 's1');
  assert.equal(roundtrip.sessions[0].messages[0].content, 'hello');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('readChatHistoryStore migrates plaintext to encrypted on read', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const plaintext = {
    version: 2,
    activeByWorkspace: {},
    sessions: [{
      id: 'legacy',
      workspaceRoot: null,
      title: 'Legacy',
      updatedAt: 2,
      messages: [],
    }],
  };
  await fs.writeFile(
    path.join(tmpDir, 'chat-history.json'),
    JSON.stringify(plaintext),
    'utf8',
  );

  const storage = makeStorageWithEncryption(tmpDir);
  const store = await storage.readChatHistoryStore();
  assert.equal(store.sessions[0].id, 'legacy');

  const raw = await fs.readFile(path.join(tmpDir, 'chat-history.json'), 'utf8');
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.encrypted, true);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('parallel readChatHistoryStore migrates plaintext once under encryption', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const plaintext = {
    version: 2,
    activeByWorkspace: { __none__: 's1' },
    sessions: [{
      id: 's1',
      workspaceRoot: null,
      title: 'Session',
      updatedAt: 1,
      messages: [{ role: 'user', content: 'hello' }],
    }],
  };
  await fs.writeFile(
    path.join(tmpDir, 'chat-history.json'),
    JSON.stringify(plaintext),
    'utf8',
  );

  const storage = makeStorageWithEncryption(tmpDir);
  let writeCount = 0;
  const realWriteFile = fs.writeFile.bind(fs);
  fs.writeFile = async (filePath, data, encoding) => {
    if (String(filePath).includes('chat-history.json.tmp-')) {
      writeCount += 1;
    }
    return realWriteFile(filePath, data, encoding);
  };

  const results = await Promise.all([
    storage.readChatHistoryStore(),
    storage.readChatHistoryStore(),
    storage.readChatHistoryStore(),
  ]);

  fs.writeFile = realWriteFile;

  assert.equal(writeCount, 1);
  for (const store of results) {
    assert.equal(store.sessions.length, 1);
    assert.equal(store.sessions[0].id, 's1');
    assert.equal(store.sessions[0].messages[0].content, 'hello');
    assert.equal(store.activeByWorkspace.__none__, 's1');
  }

  const raw = await fs.readFile(path.join(tmpDir, 'chat-history.json'), 'utf8');
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.encrypted, true);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('readUIPrefs kennt Breite und Zustand der Verlaufsspalte', async () => {
  // Epic #223, Phase B: Der Verlauf ist eine eigene Spalte und merkt sich
  // beides. Voreingestellt ist er zu — deshalb `=== true` im Contract.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const storage = makeStorage(tmpDir);

  await storage.writeUIPrefs({ contentPaneVisible: true, appLocale: 'de' });
  let prefs = await storage.readUIPrefs();
  assert.equal(prefs.chatHistoryVisible, false, 'ohne Angabe bleibt die Spalte zu');
  assert.equal(prefs.chatHistoryWidth, undefined);

  await storage.writeUIPrefs({
    contentPaneVisible: true,
    appLocale: 'de',
    chatHistoryVisible: true,
    chatHistoryWidth: 40,
  });
  prefs = await storage.readUIPrefs();
  assert.equal(prefs.chatHistoryVisible, true);
  assert.equal(prefs.chatHistoryWidth, 180);

  await storage.writeUIPrefs({
    contentPaneVisible: true,
    appLocale: 'de',
    chatHistoryWidth: 9000,
  });
  prefs = await storage.readUIPrefs();
  assert.equal(prefs.chatHistoryWidth, 800);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('readUIPrefs validates and clamps sidebarWidth and chatPanelWidth', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const storage = makeStorage(tmpDir);

  await storage.writeUIPrefs({
    contentPaneVisible: true,
    appLocale: 'de',
    sidebarWidth: 50,
    chatPanelWidth: 100,
  });
  let prefs = await storage.readUIPrefs();
  assert.equal(prefs.sidebarWidth, 150);
  assert.equal(prefs.chatPanelWidth, 260);

  await storage.writeUIPrefs({
    contentPaneVisible: true,
    appLocale: 'de',
    sidebarWidth: 999,
    chatPanelWidth: 5000,
  });
  prefs = await storage.readUIPrefs();
  assert.equal(prefs.sidebarWidth, 600);
  assert.equal(prefs.chatPanelWidth, 2000);

  await storage.writeUIPrefs({
    contentPaneVisible: true,
    appLocale: 'de',
    sidebarWidth: 'wide',
    chatPanelWidth: null,
  });
  prefs = await storage.readUIPrefs();
  assert.equal(prefs.sidebarWidth, undefined);
  assert.equal(prefs.chatPanelWidth, undefined);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('readUIPrefs verwirft den alten Schreibschalter allowWorkspaceWrite (Issue #66)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const storage = makeStorage(tmpDir);
  // Altdaten aus v1.3.1: der Schalter steht noch in der Datei.
  await fs.writeFile(storage.getUIPrefsPath(), JSON.stringify({ allowWorkspaceWrite: true, appLocale: 'en' }), 'utf8');

  let prefs = await storage.readUIPrefs();
  assert.equal('allowWorkspaceWrite' in prefs, false);
  assert.equal(prefs.appLocale, 'en');

  await storage.updateUIPrefs(async (out) => {
    out.allowWorkspaceWrite = true;
    return out;
  });
  prefs = await storage.readUIPrefs();
  assert.equal('allowWorkspaceWrite' in prefs, false);
  const onDisk = JSON.parse(await fs.readFile(storage.getUIPrefsPath(), 'utf8'));
  assert.equal('allowWorkspaceWrite' in onDisk, false, 'Migration entfernt den Schalter beim naechsten Schreiben');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('readChatHistoryStore falls back to plaintext when encryption unavailable', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  const storage = makeStorage(tmpDir);
  const store = {
    version: 2,
    activeByWorkspace: { __none__: 's1' },
    sessions: [{
      id: 's1',
      workspaceRoot: null,
      title: 'Plain',
      updatedAt: 3,
      messages: [],
    }],
  };

  await storage.writeChatHistoryStore(store);

  const raw = await fs.readFile(path.join(tmpDir, 'chat-history.json'), 'utf8');
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.encrypted, undefined);
  assert.equal(onDisk.sessions[0].id, 's1');

  const roundtrip = await storage.readChatHistoryStore();
  assert.equal(roundtrip.activeByWorkspace.__none__, 's1');

  await fs.rm(tmpDir, { recursive: true, force: true });
});

// --- Unlesbarer Chat-Verlauf: Quarantaene statt Ueberschreiben (#54) ---

async function makeTmpDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function quarantineFiles(dir) {
  return (await fs.readdir(dir)).filter((n) => n.startsWith('chat-history.json.undecryptable-')).sort();
}

test('an undecryptable encrypted chat history is quarantined, not overwritten', async (t) => {
  const tmpDir = await makeTmpDir(t, 'snotra-storage-');
  const storage = makeStorageWithEncryption(tmpDir);
  const original = JSON.stringify({ encrypted: true, payload: Buffer.from('garbage-from-other-key').toString('base64') });
  await fs.writeFile(path.join(tmpDir, 'chat-history.json'), original, 'utf8');

  const store = await storage.readChatHistoryStore();
  assert.deepEqual(store.sessions ?? [], [], 'leerer Store');

  const quarantined = await quarantineFiles(tmpDir);
  assert.equal(quarantined.length, 1, 'genau eine Quarantaene-Datei');
  assert.equal(await fs.readFile(path.join(tmpDir, quarantined[0]), 'utf8'), original, 'Originalbytes erhalten');
  assert.equal(await fs.stat(path.join(tmpDir, 'chat-history.json')).catch(() => null), null, 'Original verschoben');

  await storage.writeChatHistoryStore(store);
  const fresh = JSON.parse(await fs.readFile(path.join(tmpDir, 'chat-history.json'), 'utf8'));
  assert.equal(fresh.encrypted, true, 'neue Datei ist verschluesselt');
  assert.equal(await fs.readFile(path.join(tmpDir, quarantined[0]), 'utf8'), original, 'Quarantaene unveraendert');
});

test('parallel reads of an unreadable history create exactly one quarantine file', async (t) => {
  const tmpDir = await makeTmpDir(t, 'snotra-storage-');
  const storage = makeStorageWithEncryption(tmpDir);
  await fs.writeFile(path.join(tmpDir, 'chat-history.json'), JSON.stringify({ encrypted: true, payload: 'AAAA' }), 'utf8');

  const stores = await Promise.all([1, 2, 3].map(() => storage.readChatHistoryStore()));
  assert.equal(stores.length, 3);
  assert.equal((await quarantineFiles(tmpDir)).length, 1);
});

test('corrupt plaintext history is quarantined as well', async (t) => {
  const tmpDir = await makeTmpDir(t, 'snotra-storage-');
  const storage = makeStorage(tmpDir);
  await fs.writeFile(path.join(tmpDir, 'chat-history.json'), '{ this is not json', 'utf8');

  await storage.readChatHistoryStore();
  assert.equal((await quarantineFiles(tmpDir)).length, 1);
  assert.equal(await fs.stat(path.join(tmpDir, 'chat-history.json')).catch(() => null), null);
});

test('reading an unreadable history inside the history lock resolves and quarantines (no deadlock)', async (t) => {
  const tmpDir = await makeTmpDir(t, 'snotra-storage-');
  const storage = makeStorageWithEncryption(tmpDir);
  await fs.writeFile(path.join(tmpDir, 'chat-history.json'), JSON.stringify({ encrypted: true, payload: 'AAAA' }), 'utf8');

  const store = await storage.withChatHistoryLock(() => storage.readChatHistoryStore({ skipMigration: true }));
  assert.deepEqual(store.sessions ?? [], []);
  assert.equal((await quarantineFiles(tmpDir)).length, 1);
});

test('a missing history file produces an empty store and no quarantine', async (t) => {
  const tmpDir = await makeTmpDir(t, 'snotra-storage-');
  const storage = makeStorageWithEncryption(tmpDir);

  const store = await storage.readChatHistoryStore();
  assert.deepEqual(store.sessions ?? [], []);
  assert.deepEqual(await quarantineFiles(tmpDir), []);
});

test('folder history: removeFolderFromHistory drops exactly one entry and keeps order', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const storage = makeStorage(tmpDir);

  const dirs = {};
  for (const n of ['a', 'b', 'c']) {
    dirs[n] = path.join(tmpDir, `ws-${n}`);
    await fs.mkdir(dirs[n]);
    await storage.persistLastFolder(dirs[n]);
  }
  assert.deepEqual(await storage.getValidatedFolderHistory(), [dirs.c, dirs.b, dirs.a]);

  assert.equal(await storage.removeFolderFromHistory(dirs.b), true);
  assert.deepEqual(await storage.getValidatedFolderHistory(), [dirs.c, dirs.a]);

  // Unbekannter Pfad, leerer und nicht-string Input sind No-ops.
  assert.equal(await storage.removeFolderFromHistory(path.join(tmpDir, 'nope')), false);
  assert.equal(await storage.removeFolderFromHistory(''), false);
  assert.equal(await storage.removeFolderFromHistory(null), false);
  assert.deepEqual(await storage.getValidatedFolderHistory(), [dirs.c, dirs.a]);

  // Nicht-normalisierte Schreibweise (trailing slash, ".") trifft trotzdem.
  assert.equal(await storage.removeFolderFromHistory(`${dirs.c}/./`), true);
  assert.deepEqual(await storage.getValidatedFolderHistory(), [dirs.a]);
});

test('folder history: removing an entry leaves the folder and last-folder.json untouched', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-storage-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const storage = makeStorage(tmpDir);

  const ws = path.join(tmpDir, 'ws');
  await fs.mkdir(ws);
  await storage.persistLastFolder(ws);

  assert.equal(await storage.removeFolderFromHistory(ws), true);
  assert.deepEqual(await storage.getValidatedFolderHistory(), []);
  assert.equal(await storage.getValidatedLastFolder(), ws);
  assert.ok((await fs.stat(ws)).isDirectory());
});


// --- Verbindung je Eintrag (Issue #202) -----------------------------------

const COMPAT = 'openai-compatible';

function v3ConfigMitCompat() {
  return {
    version: 3,
    activeProvider: COMPAT,
    activePresetId: 'p1',
    presets: [
      { id: 'p1', providerId: COMPAT, model: 'qwen2.5', menuVisible: true },
      { id: 'p2', providerId: COMPAT, model: 'llama3', menuVisible: true },
      { id: 'p3', providerId: 'openai', model: 'gpt-4o', menuVisible: true },
    ],
    providers: {
      [COMPAT]: {
        baseUrl: 'http://localhost:1234/v1',
        displayName: 'LM Studio',
        apiStyle: 'full',
        sendTools: false,
        apiKeyEnc: Buffer.from('enc:sk-alt', 'utf8').toString('base64'),
        extraHeadersEnc: Buffer.from('enc:X-Tenant: acme', 'utf8').toString('base64'),
        model: 'qwen2.5',
      },
      openai: { apiKeyEnc: Buffer.from('enc:sk-oai', 'utf8').toString('base64') },
    },
  };
}

async function tmpStore(t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-202-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  return { tmp, storage: makeStorageWithEncryption(tmp) };
}

test('Migration v3 -> v4 kopiert die Verbindung in jeden Eintrag des Anbieters', async (t) => {
  const { tmp, storage } = await tmpStore(t);
  await storage.writeLLMConfig(v3ConfigMitCompat());

  const config = await storage.readLLMConfig();
  assert.equal(config.version, 4);
  // Die Verbindung steht jetzt an beiden Eintraegen - vollstaendig, inklusive
  // der verschluesselten Geheimnisse.
  for (const id of ['p1', 'p2']) {
    const conn = config.presets.find((pr) => pr.id === id).connection;
    assert.equal(conn.baseUrl, 'http://localhost:1234/v1');
    assert.equal(conn.displayName, 'LM Studio');
    assert.equal(conn.apiStyle, 'full');
    assert.equal(conn.sendTools, false);
    assert.equal(conn.apiKeyEnc, Buffer.from('enc:sk-alt', 'utf8').toString('base64'));
    assert.equal(conn.extraHeadersEnc, Buffer.from('enc:X-Tenant: acme', 'utf8').toString('base64'));
  }
  // Der Anbieter-Eintrag hat ausgedient, die uebrigen Anbieter bleiben stehen.
  assert.equal(COMPAT in config.providers, false);
  assert.ok(config.providers.openai.apiKeyEnc);
  // Eintraege anderer Anbieter bekommen keine Verbindung angehaengt.
  assert.equal('connection' in config.presets.find((pr) => pr.id === 'p3'), false);

  const aufDerPlatte = JSON.parse(await fs.readFile(path.join(tmp, 'llm-config.json'), 'utf8'));
  assert.equal(aufDerPlatte.version, 4, 'die Migration wird auch geschrieben');
});

test('die Migration ist idempotent', async (t) => {
  const { tmp, storage } = await tmpStore(t);
  await storage.writeLLMConfig(v3ConfigMitCompat());

  const erst = await storage.readLLMConfig();
  const nachDemErstenLauf = await fs.readFile(path.join(tmp, 'llm-config.json'), 'utf8');
  const zweit = await storage.readLLMConfig();
  const nachDemZweitenLauf = await fs.readFile(path.join(tmp, 'llm-config.json'), 'utf8');

  assert.deepEqual(zweit, erst);
  assert.equal(nachDemZweitenLauf, nachDemErstenLauf);
  assert.equal(zweit.presets.filter((pr) => pr.providerId === COMPAT).length, 2);
});

test('eine Konfiguration ohne diesen Anbieter bleibt inhaltlich unveraendert', async (t) => {
  const { storage } = await tmpStore(t);
  const vorher = {
    version: 3,
    activeProvider: 'openai',
    activePresetId: 'p1',
    presets: [{ id: 'p1', providerId: 'openai', model: 'gpt-4o', menuVisible: true }],
    providers: { openai: { apiKeyEnc: Buffer.from('enc:sk-oai', 'utf8').toString('base64') } },
  };
  await storage.writeLLMConfig(vorher);

  const config = await storage.readLLMConfig();
  assert.equal(config.version, 4);
  assert.deepEqual(config.providers, vorher.providers);
  assert.deepEqual(config.presets, vorher.presets);
});

test('ein Eintrag mit eigener Verbindung wird bei der Migration nicht ueberschrieben', async (t) => {
  const { storage } = await tmpStore(t);
  const config = v3ConfigMitCompat();
  config.presets[0].connection = { baseUrl: 'https://schon-da.example/v1', apiStyle: 'chat' };
  await storage.writeLLMConfig(config);

  const gelesen = await storage.readLLMConfig();
  assert.equal(gelesen.presets[0].connection.baseUrl, 'https://schon-da.example/v1');
  assert.equal(gelesen.presets[1].connection.baseUrl, 'http://localhost:1234/v1');
});

test('getEffectiveProviderConfig loest die Verbindung ueber den Eintrag auf', async (t) => {
  const { storage } = await tmpStore(t);
  await storage.writeLLMConfig({
    version: 4,
    activeProvider: COMPAT,
    activePresetId: 'a',
    providers: {},
    presets: [
      {
        id: 'a',
        providerId: COMPAT,
        model: 'qwen2.5',
        menuVisible: true,
        connection: {
          baseUrl: 'http://localhost:1234/v1',
          displayName: 'LM Studio',
          apiStyle: 'chat',
          sendTools: true,
          supportsImages: false,
          insecureTls: false,
        },
      },
      {
        id: 'b',
        providerId: COMPAT,
        model: 'gpt-4o-mini',
        menuVisible: true,
        connection: {
          baseUrl: 'https://gateway.firma.example/v1',
          displayName: 'Firmen-Gateway',
          apiStyle: 'full',
          sendTools: true,
          supportsImages: true,
          insecureTls: true,
          apiKeyEnc: Buffer.from('enc:sk-gw', 'utf8').toString('base64'),
          extraHeadersEnc: Buffer.from('enc:X-Tenant: acme', 'utf8').toString('base64'),
        },
      },
    ],
  });

  const lokal = await storage.getEffectiveProviderConfig(COMPAT, { presetId: 'a' });
  assert.equal(lokal.baseUrl, 'http://localhost:1234/v1');
  assert.equal(lokal.displayName, 'LM Studio');
  assert.equal('apiKey' in lokal, false, 'ohne Key bleibt das Feld weg');
  assert.equal(lokal.supportsImages, false);

  const gateway = await storage.getEffectiveProviderConfig(COMPAT, { presetId: 'b' });
  assert.equal(gateway.baseUrl, 'https://gateway.firma.example/v1');
  assert.equal(gateway.apiKey, 'sk-gw');
  assert.equal(gateway.extraHeaders, 'X-Tenant: acme');
  assert.equal(gateway.apiStyle, 'full');
  assert.equal(gateway.insecureTls, true);
  assert.equal(gateway.supportsImages, true);

  // Zwei Eintraege, zwei Ziele - genau das war vorher unmoeglich.
  assert.notEqual(lokal.baseUrl, gateway.baseUrl);
});

test('ohne passenden Eintrag bleibt nur der Standard des Anbieters', async (t) => {
  const { storage } = await tmpStore(t);
  await storage.writeLLMConfig({
    version: 4, activeProvider: COMPAT, activePresetId: null, providers: {}, presets: [],
  });
  const config = await storage.getEffectiveProviderConfig(COMPAT, { presetId: 'gibt-es-nicht' });
  assert.equal(config.baseUrl, 'http://localhost:1234/v1');
  assert.equal('apiKey' in config, false);
});

test('resolveChatModelTarget nennt den Eintrag, aus dem es stammt', async (t) => {
  const { storage } = await tmpStore(t);
  const target = storage.resolveChatModelTarget({
    activePresetId: 'b',
    presets: [
      { id: 'a', providerId: COMPAT, model: 'qwen2.5' },
      { id: 'b', providerId: COMPAT, model: 'gpt-4o-mini' },
    ],
    providers: {},
  });
  assert.equal(target.presetId, 'b');
  assert.equal(target.model, 'gpt-4o-mini');
});
