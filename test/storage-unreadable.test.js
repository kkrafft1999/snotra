const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { LLM_CONFIG_VERSION } = require('../src/shared/contracts/settings');
const { createMockProviderCatalog } = require('./helpers/provider-ports');

/**
 * Files the store finds but cannot use (#557, #561, #562). A file that is there
 * but not understood — broken JSON, a version newer than this build — is never
 * written over without a copy, and the folder history is changed under its lock.
 */

const PROVIDERS = {
  openai: { id: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o', fields: { apiKey: true }, presentation: {} },
  anthropic: { id: 'anthropic', name: 'Anthropic', defaultModel: 'claude-test', fields: { apiKey: true }, presentation: {} },
};

const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`enc:${plaintext}`, 'utf8'),
  decryptString(buffer) {
    const text = buffer.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('not ours');
    return text.slice(4);
  },
};

function makeStorage(dir, { fsImpl = fs, platform = 'linux' } = {}) {
  return createStorageService({
    app: { getPath: () => dir },
    safeStorage,
    fs: fsImpl,
    path,
    providerCatalog: createMockProviderCatalog((id) => PROVIDERS[id] || null),
    maxChatSessions: 3,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
    platform,
    log: { warn() {}, info() {} },
  });
}

/** `fs` whose rename to a path containing `marker` fails `times` times (all, by default). */
function fsFailingRenameTo(marker, { times = Infinity } = {}) {
  const calls = { failed: 0 };
  const wrapped = {
    ...fs,
    async rename(from, to) {
      if (to.includes(marker) && calls.failed < times) {
        calls.failed += 1;
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      return fs.rename(from, to);
    },
  };
  return { fs: wrapped, calls };
}

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-unreadable-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function copiesOf(dir, name, marker = 'unreadable') {
  return (await fs.readdir(dir)).filter((n) => n.startsWith(`${name}.${marker}-`)).sort();
}

async function assertKeptAside(dir, name, original) {
  const copies = await copiesOf(dir, name);
  assert.equal(copies.length, 1, `one copy of ${name}`);
  assert.equal(await fs.readFile(path.join(dir, copies[0]), 'utf8'), original, `${name} kept byte for byte`);
}

const STORED_LLM_CONFIG = {
  version: LLM_CONFIG_VERSION,
  activeProvider: 'openai',
  activePresetId: 'p1',
  presets: [{ id: 'p1', providerId: 'openai', model: 'gpt-5' }],
  providers: { openai: { apiKeyEnc: Buffer.from('enc:sk-stored').toString('base64') } },
};

for (const [label, content] of [
  ['truncated', JSON.stringify(STORED_LLM_CONFIG).slice(0, -3)],
  ['newer', JSON.stringify({ ...STORED_LLM_CONFIG, version: LLM_CONFIG_VERSION + 1 })],
]) {
  test(`a ${label} llm-config.json is shown as defaults, not written over by a read (#557)`, async (t) => {
    const dir = await tmpDir(t);
    const storage = makeStorage(dir);
    const target = path.join(dir, 'llm-config.json');
    await fs.writeFile(target, content, 'utf8');

    const config = await storage.readLLMConfig();
    // The read before every chat run.
    await storage.getEffectiveProviderConfig('openai');

    assert.deepEqual(config.providers, {});
    assert.equal(await fs.readFile(target, 'utf8'), content);
    assert.deepEqual(await copiesOf(dir, 'llm-config.json'), []);
  });

  test(`a ${label} llm-config.json is moved aside before a save (#557)`, async (t) => {
    const dir = await tmpDir(t);
    const storage = makeStorage(dir);
    await fs.writeFile(path.join(dir, 'llm-config.json'), content, 'utf8');

    const saved = await storage.updateLLMConfig((config) => ({ ...config, activeProvider: 'anthropic' }));

    assert.equal(saved.activeProvider, 'anthropic');
    await assertKeptAside(dir, 'llm-config.json', content);
    assert.equal((await storage.readLLMConfig()).activeProvider, 'anthropic');
  });
}

test('a current llm-config.json is read as it is, without a copy (#557)', async (t) => {
  const dir = await tmpDir(t);
  const storage = makeStorage(dir);
  await storage.writeLLMConfig(STORED_LLM_CONFIG);

  const config = await storage.updateLLMConfig((current) => current);

  assert.equal(config.presets[0].model, 'gpt-5');
  assert.equal((await storage.getEffectiveProviderConfig('openai')).apiKey, 'sk-stored');
  assert.deepEqual(await copiesOf(dir, 'llm-config.json'), []);
});

test('an older llm-config.json is still migrated in place, without a copy (#557)', async (t) => {
  const dir = await tmpDir(t);
  const storage = makeStorage(dir);
  await storage.writeLLMConfig({ version: 2, activeProvider: 'openai', providers: { openai: { model: 'gpt-4o' } } });

  const config = await storage.readLLMConfig();

  assert.equal(config.version, LLM_CONFIG_VERSION);
  assert.deepEqual(await copiesOf(dir, 'llm-config.json'), []);
});

test('a missing llm-config.json starts from the defaults, without a copy (#557)', async (t) => {
  const dir = await tmpDir(t);
  const storage = makeStorage(dir);

  await storage.updateLLMConfig((config) => config);

  assert.deepEqual(await fs.readdir(dir), ['llm-config.json']);
});

for (const [label, content] of [
  ['truncated', '{"version":1,"servers":[{"id":"heimat","command":"docker","args":[],"env":{"TOKEN":{"enc":"c2VjcmV0"}}}]'],
  ['newer', JSON.stringify({ version: 2, servers: [], profiles: [] })],
]) {
  test(`a ${label} mcp-servers.json is moved aside before a server is saved (#557)`, async (t) => {
    const dir = await tmpDir(t);
    const storage = makeStorage(dir);
    await fs.writeFile(path.join(dir, 'mcp-servers.json'), content, 'utf8');

    assert.deepEqual(await storage.readMcpServers(), []);
    const result = await storage.saveMcpServer({ id: 'other', command: 'node', args: [], env: {} });

    assert.equal(result.ok, true);
    await assertKeptAside(dir, 'mcp-servers.json', content);
    assert.deepEqual((await storage.readMcpServers()).map((server) => server.id), ['other']);
  });
}

test('a truncated ui-preferences.json is moved aside before the next save (#557)', async (t) => {
  const dir = await tmpDir(t);
  const storage = makeStorage(dir);
  const content = '{"appLocale":"de","baseSystemPrompt":"Answer briefly."';
  await fs.writeFile(path.join(dir, 'ui-preferences.json'), content, 'utf8');

  await storage.updateUIPrefs((prefs) => ({ ...prefs, sidebarWidth: 300 }));

  await assertKeptAside(dir, 'ui-preferences.json', content);
  assert.equal((await storage.readUIPrefs()).sidebarWidth, 300);
});

test('a truncated folder-history.json is moved aside when a folder is opened (#557)', async (t) => {
  const dir = await tmpDir(t);
  const storage = makeStorage(dir);
  const content = '{"paths":["/a","/b"';
  await fs.writeFile(path.join(dir, 'folder-history.json'), content, 'utf8');

  await storage.persistLastFolder(dir);

  await assertKeptAside(dir, 'folder-history.json', content);
  assert.deepEqual(await storage.getValidatedFolderHistory(), [dir]);
});

test('a truncated web-search-config.json is moved aside before a key is stored (#557)', async (t) => {
  const dir = await tmpDir(t);
  const storage = makeStorage(dir);
  const content = '{"apiKeyEnc":"c2Vj';
  await fs.writeFile(path.join(dir, 'web-search-config.json'), content, 'utf8');

  const result = await storage.setWebSearchApiKey('tvly-new');

  assert.deepEqual(result, { ok: true, hasApiKey: true });
  await assertKeptAside(dir, 'web-search-config.json', content);
  assert.equal(await storage.getWebSearchApiKey(), 'tvly-new');
});

test('a broken file that cannot be moved aside is not written over (#557)', async (t) => {
  const dir = await tmpDir(t);
  const target = path.join(dir, 'mcp-servers.json');
  const content = '{"version":1,"servers":[';
  await fs.writeFile(target, content, 'utf8');
  const storage = makeStorage(dir, { fsImpl: fsFailingRenameTo('.unreadable-').fs });

  await assert.rejects(
    () => storage.saveMcpServer({ id: 'other', command: 'node', args: [], env: {} }),
    { code: 'EPERM' },
  );

  assert.equal(await fs.readFile(target, 'utf8'), content);
});

test('a chat history whose quarantine fails is not overwritten by the next save (#561)', async (t) => {
  const dir = await tmpDir(t);
  const target = path.join(dir, 'chat-history.json');
  const original = JSON.stringify({ encrypted: true, payload: Buffer.from('foreign-key').toString('base64') });
  await fs.writeFile(target, original, 'utf8');
  const storage = makeStorage(dir, { fsImpl: fsFailingRenameTo('.undecryptable-').fs, platform: 'win32' });

  await assert.rejects(() => storage.withChatHistoryLock(async () => {
    const store = await storage.readChatHistoryStore({ skipMigration: true });
    store.sessions.push({ id: 'n1', title: 'new', messages: [{ role: 'user', content: 'hi' }], updatedAt: Date.now() });
    await storage.writeChatHistoryStore(store);
  }), { code: 'CHAT_HISTORY_UNREADABLE' });

  assert.equal(await fs.readFile(target, 'utf8'), original);
});

test('the chat history quarantine retries on Windows (#561)', async (t) => {
  const dir = await tmpDir(t);
  const original = '{ not json';
  await fs.writeFile(path.join(dir, 'chat-history.json'), original, 'utf8');
  const { fs: flaky, calls } = fsFailingRenameTo('.undecryptable-', { times: 2 });
  const storage = makeStorage(dir, { fsImpl: flaky, platform: 'win32' });

  await storage.readChatHistoryStore();

  assert.equal(calls.failed, 2);
  const copies = await copiesOf(dir, 'chat-history.json', 'undecryptable');
  assert.equal(copies.length, 1);
  assert.equal(await fs.readFile(path.join(dir, copies[0]), 'utf8'), original);
});

test('folders opened while the history is validated are all kept (#562)', async (t) => {
  const dir = await tmpDir(t);
  const storage = makeStorage(dir);
  const a = path.join(dir, 'A');
  const b = path.join(dir, 'B');
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.writeFile(path.join(dir, 'folder-history.json'), JSON.stringify({ paths: [path.join(dir, 'gone')] }), 'utf8');

  await Promise.all([storage.persistLastFolder(a), storage.persistLastFolder(b), storage.getValidatedFolderHistory()]);

  const { paths } = JSON.parse(await fs.readFile(path.join(dir, 'folder-history.json'), 'utf8'));
  assert.deepEqual(paths.map((p) => path.basename(p)).sort(), ['A', 'B']);
});

/**
 * `fs` that behaves like Windows when two renames land on the same target at
 * once (#672): the second one fails with EPERM while the first still holds it.
 */
function fsRejectingConcurrentRenames() {
  const inFlight = new Set();
  const wrapped = {
    ...fs,
    async rename(from, to) {
      if (inFlight.has(to)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      inFlight.add(to);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await fs.rename(from, to);
      } finally {
        inFlight.delete(to);
      }
    },
  };
  return wrapped;
}

test('two folders opened at once never rename onto last-folder.json at the same time (#672)', async (t) => {
  const dir = await tmpDir(t);
  const storage = makeStorage(dir, { fsImpl: fsRejectingConcurrentRenames() });
  const a = path.join(dir, 'A');
  const b = path.join(dir, 'B');
  await fs.mkdir(a);
  await fs.mkdir(b);

  await Promise.all([storage.persistLastFolder(a), storage.persistLastFolder(b)]);

  const { path: last } = JSON.parse(await fs.readFile(path.join(dir, 'last-folder.json'), 'utf8'));
  assert.ok([a, b].includes(last));
  const { paths } = JSON.parse(await fs.readFile(path.join(dir, 'folder-history.json'), 'utf8'));
  assert.deepEqual(paths.map((p) => path.basename(p)).sort(), ['A', 'B']);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.includes('.tmp-')), []);
});
