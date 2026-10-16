const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createAppNotices, postStoreFileEvent } = require('../src/main/services/app-notices');
const { NOTICE_KINDS } = require('../src/shared/contracts/notices');
const { createMockProviderCatalog } = require('./helpers/provider-ports');

/**
 * A store that sets an unreadable file aside, or cannot save it, tells the
 * user (#1001) — through the storage service's report, into a notice. One
 * test per store: each has its own way to the set-aside.
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

function makeStorage(dir, { fsImpl = fs } = {}) {
  const events = [];
  const notices = createAppNotices({ log: { warn() {} } });
  const storage = createStorageService({
    app: { getPath: () => dir },
    safeStorage,
    fs: fsImpl,
    path,
    providerCatalog: createMockProviderCatalog((id) => PROVIDERS[id] || null),
    maxChatSessions: 3,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
    platform: 'linux',
    log: { warn() {}, info() {} },
    onStoreFileEvent: (event) => {
      events.push(event);
      postStoreFileEvent(notices, event);
    },
  });
  return { storage, events, notices };
}

/** `fs` whose rename to a path containing `marker` fails while `failing.on` is true. */
function fsFailingRenameTo(marker) {
  const failing = { on: true };
  const wrapped = {
    ...fs,
    async rename(from, to) {
      if (failing.on && to.includes(marker)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' });
      }
      return fs.rename(from, to);
    },
  };
  return { fs: wrapped, failing };
}

async function tmpDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-notices-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const STORES = [
  {
    file: 'llm-config.json',
    store: 'models',
    content: '{"version":6,"activeProvider":"openai"',
    save: (storage) => storage.updateLLMConfig((config) => ({ ...config, activeProvider: 'anthropic' })),
  },
  {
    file: 'web-search-config.json',
    store: 'webSearch',
    content: '{"apiKeyEnc":"c2Vj',
    save: (storage) => storage.setWebSearchApiKey('tvly-new'),
  },
  {
    file: 'mcp-servers.json',
    store: 'mcpServers',
    content: '{"version":1,"servers":[',
    save: (storage) => storage.saveMcpServer({ id: 'other', command: 'node', args: [], env: {} }),
  },
  {
    file: 'ui-preferences.json',
    store: 'uiPreferences',
    content: '{"appLocale":"de"',
    save: (storage) => storage.updateUIPrefs((prefs) => ({ ...prefs, sidebarWidth: 300 })),
  },
  {
    file: 'folder-history.json',
    store: 'folderHistory',
    content: '{"paths":["/a"',
    save: (storage, dir) => storage.persistLastFolder(dir),
  },
];

for (const { file, store, content, save } of STORES) {
  test(`a ${file} moved aside is reported with its copy (#1001)`, async (t) => {
    const dir = await tmpDir(t);
    const { storage, events, notices } = makeStorage(dir);
    await fs.writeFile(path.join(dir, file), content, 'utf8');

    await save(storage, dir);

    const copies = (await fs.readdir(dir)).filter((name) => name.startsWith(`${file}.unreadable-`));
    assert.equal(copies.length, 1);
    assert.deepEqual(events, [{
      type: 'set-aside', store, file, path: path.join(dir, file), keptAs: path.join(dir, copies[0]),
    }]);
    assert.deepEqual(notices.list(), [{
      id: `store:${file}`,
      kind: NOTICE_KINDS.STORE_SET_ASIDE,
      store,
      file,
      location: path.join(dir, copies[0]),
      canReveal: true,
    }]);
  });

  test(`a ${file} that cannot be moved aside says it is not saved, until it is (#1001)`, async (t) => {
    const dir = await tmpDir(t);
    const { fs: failingFs, failing } = fsFailingRenameTo('.unreadable-');
    const { storage, notices } = makeStorage(dir, { fsImpl: failingFs });
    await fs.writeFile(path.join(dir, file), content, 'utf8');

    // The web search key answers `ok: false` instead of throwing.
    await Promise.resolve(save(storage, dir)).catch(() => {});

    assert.equal(await fs.readFile(path.join(dir, file), 'utf8'), content, 'left as it was');
    assert.deepEqual(notices.list().map((n) => [n.kind, n.store, n.location]), [
      [NOTICE_KINDS.STORE_NOT_SAVED, store, path.join(dir, file)],
    ]);

    failing.on = false;
    await save(storage, dir);

    // Saved again: the warning is withdrawn, the set-aside is news.
    assert.deepEqual(notices.list().map((n) => [n.kind, n.store]), [[NOTICE_KINDS.STORE_SET_ASIDE, store]]);
  });
}

test('a file that is there but cannot be read says it is not saved (#1001)', async (t) => {
  const dir = await tmpDir(t);
  const target = path.join(dir, 'ui-preferences.json');
  await fs.writeFile(target, '{}', 'utf8');
  const locked = {
    ...fs,
    async readFile(file, ...rest) {
      if (file === target) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return fs.readFile(file, ...rest);
    },
  };
  const { storage, events } = makeStorage(dir, { fsImpl: locked });

  await assert.rejects(() => storage.updateUIPrefs((prefs) => prefs), { code: 'EACCES' });

  assert.deepEqual(events.map((e) => [e.type, e.store]), [['not-saved', 'uiPreferences']]);
});

test('a readable file reports nothing (#1001)', async (t) => {
  const dir = await tmpDir(t);
  const { storage, events } = makeStorage(dir);

  await storage.updateUIPrefs((prefs) => ({ ...prefs, sidebarWidth: 280 }));
  await storage.updateUIPrefs((prefs) => ({ ...prefs, sidebarWidth: 300 }));
  await storage.persistLastFolder(dir);

  assert.deepEqual(events, []);
});

test('a chat history moved aside is reported with its copy (#1001)', async (t) => {
  const dir = await tmpDir(t);
  const { storage, events } = makeStorage(dir);
  await fs.writeFile(path.join(dir, 'chat-history.json'), '{ not json', 'utf8');

  await storage.readChatHistoryStore();

  const copies = (await fs.readdir(dir)).filter((name) => name.startsWith('chat-history.json.undecryptable-'));
  assert.equal(copies.length, 1);
  assert.deepEqual(events, [{
    type: 'set-aside',
    store: 'chatHistory',
    file: 'chat-history.json',
    path: path.join(dir, 'chat-history.json'),
    keptAs: path.join(dir, copies[0]),
  }]);
});

test('a chat history written by a newer release is reported as kept aside (#1001)', async (t) => {
  const dir = await tmpDir(t);
  const { storage, events } = makeStorage(dir);
  await fs.writeFile(path.join(dir, 'chat-history.json'), JSON.stringify({ version: 99, sessions: [] }), 'utf8');

  await storage.readChatHistoryStore();

  assert.equal(events.length, 1);
  assert.match(events[0].keptAs, /chat-history\.json\.unreadable-/);
});

test('a chat history that cannot be moved aside leaves the notice to the chat (#1001, #977)', async (t) => {
  const dir = await tmpDir(t);
  await fs.writeFile(path.join(dir, 'chat-history.json'), '{ not json', 'utf8');
  const { storage, events } = makeStorage(dir, { fsImpl: fsFailingRenameTo('.undecryptable-').fs });

  await storage.readChatHistoryStore();

  assert.deepEqual(events, []);
});
