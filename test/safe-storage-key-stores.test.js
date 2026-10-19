// The stores hold their ciphertext until the key behind safeStorage is on disk
// (#1060). On a fresh Windows profile Chromium writes that key to `Local State`
// only seconds after the start; ciphertext written before it was lost for good
// when the app died in between. Here the key is held by the test, so the
// behaviour shows on every platform.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createStorageService } = require('../src/main/services/storage-service');
const { chatSessionFileName } = require('../src/main/services/chat-history-store');
const { createToolPolicyStore, POLICY_FILENAME, POLICY_KEY_FILENAME } = require('../src/main/services/tool-policy-store');
const { registerSettingsForTest: registerSettingsHandlers } = require('./helpers/settings-handlers');
const { registerChatHistoryForTest: registerChatHistoryHandlers } = require('./helpers/chat-history-handlers');
const { KEY_ALWAYS_DURABLE } = require('../src/main/services/safe-storage-key-durability');
const {
  createChatHistoryStorePort,
  createLlmConfigStorePort,
  createUiPrefsStorePort,
  createWorkspaceFolderStorePort,
} = require('../src/main/adapters/persistence-store-adapters');
const { createSettingsPresentationService } = require('../src/main/services/settings-presentation-service');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { createHeldSafeStorageKey, settle } = require('./helpers/held-safe-storage-key');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { removeTempDir } = require('./helpers/temp-dir');
const { ACCEPT_EVERY_RECEIPT } = require('./helpers/confirmations');

function makeSafeStorage(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (buf) => {
      const text = buf.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not this key');
      return text.slice(4);
    },
  };
}

const GATEWAY = {
  id: 'gateway',
  name: 'Gateway',
  defaultModel: 'g1',
  fields: { apiKey: true, extraHeaders: true },
  presentation: {},
};
const COMPAT = {
  id: 'openai-compatible',
  name: 'OpenAI-compatible',
  defaultModel: '',
  optionalApiKey: true,
  connectionPerPreset: true,
  defaultBaseUrl: 'http://localhost:1234/v1',
  defaultApiStyle: 'chat',
  fields: { apiKey: true, baseUrl: true, extraHeaders: true },
  presentation: {},
};
const PROVIDERS = { [GATEWAY.id]: GATEWAY, [COMPAT.id]: COMPAT };
const providerCatalog = createMockProviderCatalog((id) => (Object.hasOwn(PROVIDERS, id) ? PROVIDERS[id] : null), {
  listMeta: () => Object.values(PROVIDERS),
});

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-1060-'));
  t.after(() => removeTempDir(dir));
  return dir;
}

function makeStorage(dir, { safeStorageKey, encryption = true } = {}) {
  return createStorageService({
    app: { getPath: () => dir },
    safeStorage: makeSafeStorage(encryption),
    safeStorageKey,
    fs,
    path,
    providerCatalog,
    maxChatSessions: 10,
    maxFolderHistory: 5,
    defaultProviderId: GATEWAY.id,
    // What is checked here is the key, not the confirmation (#1104).
    confirmationReceipts: ACCEPT_EVERY_RECEIPT,
  });
}

function makePolicyStore(dir, safeStorageKey) {
  return createToolPolicyStore({
    // What is checked here is the key, not the confirmation (#980).
    confirmationReceipts: { redeem: () => true },
    app: { getPath: () => dir },
    safeStorage: makeSafeStorage(true),
    safeStorageKey,
    fs,
    path,
    crypto,
    log: { warn() {} },
    now: () => 1000,
  });
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

/** Whether the promise settles within a moment of real time. */
async function isSettled(promise) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  await settle();
  return done;
}

// --- The chat history -------------------------------------------------------

test('the history is written only once the key is on disk, and then encrypted', async (t) => {
  const dir = await tempDir(t);
  const key = createHeldSafeStorageKey();
  const storage = makeStorage(dir, { safeStorageKey: key });
  const file = path.join(dir, 'chat-history', 'index.json');

  const writing = storage.setActiveChatId('__none__', 'chat-1');
  await key.asked();
  assert.equal(await isSettled(writing), false, 'the save waits');
  assert.equal(await exists(file), false, 'nothing on disk before the key');
  assert.equal(key.waits, 1);

  key.release();
  await writing;
  const written = await readJson(file);
  assert.equal(written.encrypted, true);
  assert.equal(await makeStorage(dir, { safeStorageKey: key }).getActiveChatId('__none__'), 'chat-1');
});

test('a history without encrypted storage is written at once', async (t) => {
  const dir = await tempDir(t);
  const key = createHeldSafeStorageKey();
  const storage = makeStorage(dir, { safeStorageKey: key, encryption: false });

  await storage.setActiveChatId('__none__', 'chat-1');
  assert.equal(key.waits, 0, 'nothing to wait for');
  assert.equal((await readJson(path.join(dir, 'chat-history', 'index.json'))).activeByWorkspace.__none__, 'chat-1');
});

test('reading a plain history does not wait for the key; it is encrypted once the key is there', async (t) => {
  const dir = await tempDir(t);
  await fs.writeFile(path.join(dir, 'chat-history.json'), JSON.stringify({
    version: 2,
    activeByWorkspace: { __none__: 'chat-1' },
    sessions: [{ id: 'chat-1', title: 'Plain', updatedAt: 1, messages: [{ role: 'user', content: 'hi' }] }],
  }), 'utf8');
  const key = createHeldSafeStorageKey();
  const storage = makeStorage(dir, { safeStorageKey: key });
  const index = path.join(dir, 'chat-history', 'index.json');
  const chat = path.join(dir, 'chat-history', chatSessionFileName('chat-1'));

  // Taken into the folder as plain as it was, without waiting for the key.
  assert.equal(await storage.getActiveChatId('__none__'), 'chat-1');
  assert.equal((await storage.getChatSession('chat-1')).messages[0].content, 'hi');
  assert.equal((await readJson(index)).encrypted, undefined, 'still plain');
  assert.equal((await readJson(chat)).encrypted, undefined, 'still plain');

  key.release();
  await storage.whenWritesSettled();
  assert.equal((await readJson(index)).encrypted, true, 'encrypted once the key is there');
  assert.equal((await readJson(chat)).encrypted, true);
});

test('a new chat on a fresh profile clears no pointer, so it writes nothing and does not wait', async (t) => {
  const dir = await tempDir(t);
  const key = createHeldSafeStorageKey();
  const storage = makeStorage(dir, { safeStorageKey: key });
  const ipcMain = createMockIpcMain();
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore: createChatHistoryStorePort(storage),
    REQ,
    getActiveWorkspaceRoot: () => null,
    isKnownWorkspaceRoot: async () => false,
  });

  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, null), { ok: true });
  assert.equal(key.waits, 0, 'the mode of the new chat is not held up behind the key (#564)');
  assert.equal(await exists(path.join(dir, 'chat-history')), false);

  // A pointer that does change is history, encrypted, and waits like any save.
  const pointing = ipcMain.invoke(REQ.CHAT_HISTORY_SET_ACTIVE, 'chat-1');
  await key.asked();
  assert.equal(await isSettled(pointing), false);
  key.release();
  assert.deepEqual(await pointing, { ok: true });
  assert.equal((await readJson(path.join(dir, 'chat-history', 'index.json'))).encrypted, true);
});

test('files without ciphertext are not held', async (t) => {
  const dir = await tempDir(t);
  const key = createHeldSafeStorageKey();
  const storage = makeStorage(dir, { safeStorageKey: key });

  await storage.updateUIPrefs(async (prefs) => Object.assign(prefs, { appLocale: 'en' }));
  assert.equal((await storage.readUIPrefs()).appLocale, 'en');
  assert.equal(key.waits, 0);
});

// --- The web search key and MCP secrets -----------------------------------

test('the web search key is stored only once the key is on disk; removing it is not held', async (t) => {
  const dir = await tempDir(t);
  const key = createHeldSafeStorageKey();
  const storage = makeStorage(dir, { safeStorageKey: key });
  const file = path.join(dir, 'web-search-config.json');

  const saving = storage.setWebSearchApiKey('tvly-secret');
  await key.asked();
  assert.equal(await isSettled(saving), false);
  assert.equal(await exists(file), false);

  key.release();
  assert.equal((await saving).ok, true);
  assert.equal(await storage.getWebSearchApiKey(), 'tvly-secret');

  const held = createHeldSafeStorageKey();
  const clearing = makeStorage(dir, { safeStorageKey: held }).setWebSearchApiKey('');
  assert.equal((await clearing).ok, true);
  assert.equal(held.waits, 0);
});

test('an MCP server with a secret is stored only once the key is on disk; one without is not held', async (t) => {
  const dir = await tempDir(t);
  const key = createHeldSafeStorageKey();
  const storage = makeStorage(dir, { safeStorageKey: key });
  const file = path.join(dir, 'mcp-servers.json');

  const plain = { id: 'docs', label: 'Docs', command: 'npx', args: [], env: { LANG: { secret: false, value: 'de_DE' } } };
  assert.equal((await storage.saveMcpServer(plain)).ok, true);
  assert.equal(key.waits, 0, 'no secret, no wait');

  const saving = storage.saveMcpServer({
    id: 'github', label: 'GitHub', command: 'npx', args: [], env: { GITHUB_TOKEN: { value: 'ghp_secret' } },
  });
  await key.asked();
  assert.equal(await isSettled(saving), false);
  assert.equal((await readJson(file)).servers.some((s) => s.id === 'github'), false, 'not on disk yet');

  key.release();
  assert.equal((await saving).ok, true);
  const github = (await readJson(file)).servers.find((s) => s.id === 'github');
  assert.equal(typeof github.env.GITHUB_TOKEN.enc, 'string');
  const [runtime] = (await storage.getMcpServersForRuntime()).filter((s) => s.id === 'github');
  assert.equal(runtime.env.GITHUB_TOKEN, 'ghp_secret');
});

// --- The tool policy -----------------------------------------------------------

test('a fresh policy is read at once and without files; its first change waits for the key', async (t) => {
  const dir = await tempDir(t);
  const key = createHeldSafeStorageKey();
  const store = makePolicyStore(dir, key);

  const fresh = await store.read();
  assert.equal(fresh.mode, 'smart');
  assert.equal(fresh.integrity, 'ok');
  assert.equal(await exists(path.join(dir, POLICY_FILENAME)), false, 'no policy yet');
  assert.equal(await exists(path.join(dir, POLICY_KEY_FILENAME)), false, 'no key yet');
  assert.equal(key.waits, 0, 'the read did not wait');

  const changing = store.setMode('auto');
  await key.asked();
  assert.equal(await isSettled(changing), false, 'the change waits');
  assert.equal(await exists(path.join(dir, POLICY_KEY_FILENAME)), false);
  assert.equal(await exists(path.join(dir, POLICY_FILENAME)), false);

  key.release();
  assert.equal((await changing).ok, true);
  const after = await makePolicyStore(dir, KEY_ALWAYS_DURABLE).read();
  assert.equal(after.mode, 'auto', 'signed with the key that is on disk');
  assert.equal(after.integrity, 'ok');
});

test('a fresh policy gets its file on the first read once the key is on disk', async (t) => {
  const dir = await tempDir(t);
  const key = createHeldSafeStorageKey();
  const store = makePolicyStore(dir, key);
  await store.read();
  key.release();

  assert.equal((await store.read()).integrity, 'ok');
  assert.equal(await exists(path.join(dir, POLICY_FILENAME)), true);
  assert.equal(await exists(path.join(dir, POLICY_KEY_FILENAME)), true);
});

test('a stored policy is checked with its key while the key behind safeStorage is held', async (t) => {
  const dir = await tempDir(t);
  assert.equal((await makePolicyStore(dir, KEY_ALWAYS_DURABLE).setMode('auto')).ok, true);

  const key = createHeldSafeStorageKey();
  const state = await makePolicyStore(dir, key).read();
  assert.equal(state.integrity, 'ok');
  assert.equal(state.mode, 'auto');
  assert.equal(key.waits, 0);
});

test('a policy whose key is gone fails its check at once instead of waiting for a new key', async (t) => {
  const dir = await tempDir(t);
  assert.equal((await makePolicyStore(dir, KEY_ALWAYS_DURABLE).setMode('auto')).ok, true);
  await fs.rm(path.join(dir, POLICY_KEY_FILENAME));

  const key = createHeldSafeStorageKey();
  const store = makePolicyStore(dir, key);
  const state = await store.read();
  assert.equal(state.integrity, 'invalid', 'the same fail-safe a new key would have caused');
  assert.equal(state.mode, 'smart');
  assert.equal(key.waits, 0);
  assert.equal(await exists(path.join(dir, POLICY_KEY_FILENAME)), false, 'no key made while it would have to wait');

  const changing = store.setMode('ask-all');
  await key.asked();
  assert.equal(await isSettled(changing), false);
  key.release();
  assert.equal((await changing).ok, true);
  const after = await makePolicyStore(dir, KEY_ALWAYS_DURABLE).read();
  assert.equal(after.integrity, 'ok');
  assert.equal(after.mode, 'ask-all');
});

// --- Provider keys and headers ------------------------------------------------

async function setupSettings(t, safeStorageKey) {
  const dir = await tempDir(t);
  const storage = makeStorage(dir, { safeStorageKey });
  const ipcMain = createMockIpcMain();
  const llmConfigStore = createLlmConfigStorePort(storage);
  registerSettingsHandlers({
    ipcMain,
    safeStorage: makeSafeStorage(true),
    safeStorageKey,
    llmConfigStore,
    uiPrefsStore: createUiPrefsStorePort(storage),
    workspaceFolderStore: createWorkspaceFolderStorePort(storage),
    providerCatalog,
    providerModels: { listModels: async () => ({ models: [] }) },
    REQ,
    getActiveWorkspaceRoot: () => null,
    presentation: createSettingsPresentationService({ providerCatalog, defaultProviderId: GATEWAY.id }),
  });
  const commit = (payload) => ipcMain.invoke(REQ.SETTINGS_COMMIT_SETTINGS, { providerPatches: {}, uiPrefs: {}, ...payload });
  return { commit, llmConfigStore, storage };
}

test('a provider key is stored only once the key is on disk; a save without a secret is not held', async (t) => {
  const key = createHeldSafeStorageKey();
  const { commit, llmConfigStore, storage } = await setupSettings(t, key);
  const presets = [{ id: 'p1', providerId: GATEWAY.id, model: 'g1' }];

  const saving = commit({ presets, activePresetId: 'p1', providerPatches: { gateway: { apiKey: 'sk-secret', extraHeaders: 'X-GW: hdr' } } });
  await key.asked();
  assert.equal(await isSettled(saving), false, 'the save waits');
  assert.equal((await llmConfigStore.readLLMConfig()).providers?.gateway?.apiKeyEnc, undefined, 'no ciphertext yet');

  key.release();
  assert.equal((await saving).ok, true);
  const effective = await storage.getEffectiveProviderConfig(GATEWAY.id, { presetId: 'p1' });
  assert.equal(effective.apiKey, 'sk-secret');

  const held = createHeldSafeStorageKey();
  const other = await setupSettings(t, held);
  assert.equal((await other.commit({ presets: [{ id: 'p1', providerId: COMPAT.id, model: 'm1' }], activePresetId: 'p1' })).ok, true);
  assert.equal(held.waits, 0, 'no secret, no wait');
});

test('a key of an entry\'s own connection is stored only once the key is on disk', async (t) => {
  const key = createHeldSafeStorageKey();
  const { commit, llmConfigStore } = await setupSettings(t, key);

  const saving = commit({
    presets: [{ id: 'p1', providerId: COMPAT.id, model: 'm1', connection: { baseUrl: 'http://gw.example/v1', apiKey: 'k-secret' } }],
    activePresetId: 'p1',
  });
  await key.asked();
  assert.equal(await isSettled(saving), false);
  assert.equal((await llmConfigStore.readLLMConfig()).presets?.some((p) => p.connection?.apiKeyEnc), false);

  key.release();
  assert.equal((await saving).ok, true);
  const [stored] = (await llmConfigStore.readLLMConfig()).presets;
  assert.equal(typeof stored.connection.apiKeyEnc, 'string');
});
