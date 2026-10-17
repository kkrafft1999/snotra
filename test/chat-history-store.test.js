// The chat history as one file per chat and an index held in memory (#985):
// the move from the single `chat-history.json`, what the folder looks like,
// concurrent changes and the write-behind index, and the rules for files that
// cannot be read (#473, #557, #561, #566, #658), now per file.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createStorageService } = require('../src/main/services/storage-service');
const { chatSessionFileName } = require('../src/main/services/chat-history-store');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { registerChatHistoryHandlers } = require('../src/main/ipc/chat-history-handlers');
const { CHAT_HISTORY_UNREADABLE } = require('../src/main/ports/chat-history-store-port');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { createMockProviderCatalog } = require('./helpers/provider-ports');

const quiet = { warn() {}, info() {}, error() {}, log() {} };

function makeSafeStorage({ available = true, key = 'enc' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(`${key}:${plain}`, 'utf8'),
    decryptString: (buf) => {
      const text = buf.toString('utf8');
      if (!text.startsWith(`${key}:`)) throw new Error('not this key');
      return text.slice(key.length + 1);
    },
  };
}

function encrypt(data, key = 'enc') {
  return { encrypted: true, payload: Buffer.from(`${key}:${JSON.stringify(data)}`, 'utf8').toString('base64') };
}

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-985-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeStorage(dir, { safeStorage = makeSafeStorage(), fsImpl = fs, maxChatSessions = 200, events = [] } = {}) {
  return createStorageService({
    app: { getPath: () => dir },
    safeStorage,
    fs: fsImpl,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
    log: quiet,
    onStoreFileEvent: (event) => events.push(event),
  });
}

function makeHandlers(storage, { activeRoot = null } = {}) {
  const ipcMain = createMockIpcMain();
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore: createChatHistoryStorePort(storage),
    REQ,
    getActiveWorkspaceRoot: () => activeRoot,
    now: (() => {
      let t = 10_000;
      return () => (t += 1);
    })(),
  });
  return ipcMain;
}

function chat(id, { updatedAt = 1000, messages = 2, workspaceRoot = null, title } = {}) {
  const rows = [];
  for (let i = 0; i < messages; i += 1) {
    rows.push(i % 2 === 0 ? { role: 'user', content: `question ${id} ${i}` } : { role: 'assistant', content: `answer ${id} ${i}`, toolTrace: [] });
  }
  return { id, workspaceRoot, ...(title === undefined ? {} : { title }), updatedAt, messages: rows, tokenUsage: { prompt: 1, completion: 2, total: 3 } };
}

function legacyStore(sessions, activeByWorkspace = {}) {
  return { version: 2, activeByWorkspace, sessions };
}

const storeDir = (dir) => path.join(dir, 'chat-history');
const indexFile = (dir) => path.join(storeDir(dir), 'index.json');
const sessionFile = (dir, id) => path.join(storeDir(dir), chatSessionFileName(id));
const legacyFile = (dir) => path.join(dir, 'chat-history.json');

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

/** A file of the folder as plain data, decrypted with the test key. */
async function readStoreFile(file, key = 'enc') {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  if (data.encrypted !== true) return { encrypted: false, data };
  const plain = Buffer.from(data.payload, 'base64').toString('utf8');
  assert.ok(plain.startsWith(`${key}:`));
  return { encrypted: true, data: JSON.parse(plain.slice(key.length + 1)) };
}

async function writeLegacy(dir, store, { encrypted = true } = {}) {
  const raw = JSON.stringify(encrypted ? encrypt(store) : store);
  await fs.writeFile(legacyFile(dir), raw, 'utf8');
  return raw;
}

async function namesIn(dir) {
  return (await fs.readdir(dir)).sort();
}

// ── Migration ──────────────────────────────────────────────────────────────

test('the single file becomes one encrypted file per chat and an index, and is then removed', async (t) => {
  const dir = await tempDir(t);
  const ws = path.resolve(dir, 'project');
  await writeLegacy(dir, legacyStore(
    [chat('a', { updatedAt: 3000, workspaceRoot: ws, title: 'Alpha' }), chat('b', { updatedAt: 2000, messages: 4 }), chat('c', { updatedAt: 1000, workspaceRoot: ws })],
    { [ws]: 'a', __none__: 'b' },
  ));
  const storage = makeStorage(dir);

  const list = await storage.listChatSessions();
  assert.deepEqual(list.map((s) => s.id), ['a', 'b', 'c']);
  assert.equal(list.some((s) => 'messages' in s), false, 'the index carries no messages');
  assert.equal(list.find((s) => s.id === 'b').messageCount, 4);
  assert.equal(await storage.getActiveChatId(ws), 'a');
  assert.equal(await storage.getActiveChatId('__none__'), 'b');

  assert.equal(await exists(legacyFile(dir)), false, 'the single file is gone once the folder holds it');
  const index = await readStoreFile(indexFile(dir));
  assert.equal(index.encrypted, true);
  assert.equal(index.data.version, 3);
  assert.equal(index.data.sessions.some((s) => 'messages' in s), false);
  for (const id of ['a', 'b', 'c']) {
    const file = await readStoreFile(sessionFile(dir, id));
    assert.equal(file.encrypted, true, `${id} is encrypted`);
    assert.equal(file.data.session.id, id);
  }
  const full = await storage.getChatSession('b');
  assert.equal(full.messages.length, 4);
  assert.equal(full.messages[3].content, 'answer b 3');
});

test('a migration whose writes fail leaves the single file as it was and saves nothing', async (t) => {
  const dir = await tempDir(t);
  const raw = await writeLegacy(dir, legacyStore([chat('a'), chat('b'), chat('c')], { __none__: 'a' }));
  const failing = {
    ...fs,
    open: async (file, ...rest) => {
      if (path.basename(String(file)).startsWith(`${chatSessionFileName('b')}.tmp-`)) {
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      }
      return fs.open(file, ...rest);
    },
  };
  const storage = makeStorage(dir, { fsImpl: failing });

  // Every access tries again, and fails again while the disk does.
  assert.deepEqual(await storage.listChatSessions(), [], 'a store that did not load shows nothing');
  await assert.rejects(storage.setActiveChatId('__none__', 'b'), { code: CHAT_HISTORY_UNREADABLE });
  await assert.rejects(storage.saveChatSession(chat('d')), { code: CHAT_HISTORY_UNREADABLE });
  assert.equal(await fs.readFile(legacyFile(dir), 'utf8'), raw, 'the single file is byte for byte as it was');
  assert.equal(await exists(indexFile(dir)), false);

  // The next start begins again and gets through.
  const again = makeStorage(dir);
  assert.deepEqual((await again.listChatSessions()).map((s) => s.id).sort(), ['a', 'b', 'c']);
  assert.equal(await again.getActiveChatId('__none__'), 'a');
  assert.equal(await exists(legacyFile(dir)), false);
});

test('a migration whose copies do not read back keeps the single file', async (t) => {
  const dir = await tempDir(t);
  const raw = await writeLegacy(dir, legacyStore([chat('a', { messages: 6 })]));
  const truncating = {
    ...fs,
    readFile: async (file, ...rest) => {
      if (path.basename(String(file)) === chatSessionFileName('a')) {
        return JSON.stringify(encrypt({ version: 3, session: { ...chat('a', { messages: 2 }) } }));
      }
      return fs.readFile(file, ...rest);
    },
  };
  const storage = makeStorage(dir, { fsImpl: truncating });

  assert.deepEqual(await storage.listChatSessions(), []);
  assert.equal(await fs.readFile(legacyFile(dir), 'utf8'), raw);
  assert.equal(await exists(indexFile(dir)), false, 'without a verified copy no index is written');
});

test('a migration whose index write fails keeps the single file, so a later start cannot bring deleted chats back', async (t) => {
  const dir = await tempDir(t);
  const raw = await writeLegacy(dir, legacyStore([chat('a'), chat('b')]));
  const noIndex = {
    ...fs,
    open: async (file, ...rest) => {
      if (path.basename(String(file)).startsWith('index.json.tmp-')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.open(file, ...rest);
    },
  };
  const storage = makeStorage(dir, { fsImpl: noIndex });

  assert.deepEqual(await storage.listChatSessions(), []);
  await assert.rejects(storage.deleteChatSession('a'), { code: CHAT_HISTORY_UNREADABLE });
  assert.equal(await fs.readFile(legacyFile(dir), 'utf8'), raw);
});

test('a single file left over after its migration is removed, not taken in again', async (t) => {
  const dir = await tempDir(t);
  const raw = await writeLegacy(dir, legacyStore([chat('a', { updatedAt: 2000 }), chat('b', { updatedAt: 1000 })]));
  const first = makeStorage(dir);
  await first.listChatSessions();
  await first.deleteChatSession('b');
  await first.whenWritesSettled();
  // The removal did not get through (a Windows lock, say): the same bytes are back.
  await fs.writeFile(legacyFile(dir), raw, 'utf8');

  const second = makeStorage(dir);
  assert.deepEqual((await second.listChatSessions()).map((s) => s.id), ['a'], 'the deleted chat stays deleted');
  assert.equal(await exists(legacyFile(dir)), false);
});

test('a single file written by an older release after the update is merged in', async (t) => {
  const dir = await tempDir(t);
  await writeLegacy(dir, legacyStore([chat('a', { updatedAt: 1000 }), chat('b', { updatedAt: 1000 })]));
  const first = makeStorage(dir);
  await first.listChatSessions();
  await first.saveChatSession(first.normalizeSessionForStore(chat('c', { updatedAt: 1500 })));
  await first.whenWritesSettled();

  // An older release ran in between: it knew only its own file, went on with `a` and started `d`.
  await writeLegacy(dir, legacyStore(
    [chat('a', { updatedAt: 5000, messages: 4 }), chat('b', { updatedAt: 500, messages: 6 }), chat('d', { updatedAt: 4000 })],
    { __none__: 'd' },
  ));
  const second = makeStorage(dir);
  const list = await second.listChatSessions();
  assert.deepEqual(list.map((s) => s.id), ['a', 'd', 'c', 'b']);
  assert.equal((await second.getChatSession('a')).messages.length, 4, 'the newer copy of a chat wins');
  assert.equal((await second.getChatSession('b')).messages.length, 2, 'an older copy does not replace the newer one');
  assert.equal(await second.getActiveChatId('__none__'), 'd');
  assert.equal(await exists(legacyFile(dir)), false);
});

test('a plain single file without encrypted storage stays plain, and is encrypted once a keychain is there', async (t) => {
  const dir = await tempDir(t);
  await writeLegacy(dir, legacyStore([chat('a')]), { encrypted: false });
  const plain = makeStorage(dir, { safeStorage: makeSafeStorage({ available: false }) });
  assert.equal((await plain.listChatSessions()).length, 1);
  assert.equal((await readStoreFile(sessionFile(dir, 'a'))).encrypted, false);
  assert.equal((await readStoreFile(indexFile(dir))).encrypted, false);
  assert.equal((await readStoreFile(indexFile(dir))).data.sessions[0].plain, true);

  const keyed = makeStorage(dir);
  assert.equal((await keyed.getChatSession('a')).messages.length, 2);
  await keyed.whenWritesSettled();
  assert.equal((await readStoreFile(sessionFile(dir, 'a'))).encrypted, true);
  const index = await readStoreFile(indexFile(dir));
  assert.equal(index.encrypted, true);
  assert.equal('plain' in index.data.sessions[0], false);
});

// ── The rules for files that cannot be read, per file ──────────────────────

test('#473: a single file that cannot be read is left alone, and nothing is written', async (t) => {
  const dir = await tempDir(t);
  await fs.mkdir(legacyFile(dir));
  const storage = makeStorage(dir);
  assert.deepEqual(await storage.listChatSessions(), []);
  await assert.rejects(storage.saveChatSession(storage.normalizeSessionForStore(chat('a'))), { code: CHAT_HISTORY_UNREADABLE });
  assert.equal((await fs.stat(legacyFile(dir))).isDirectory(), true);
  assert.equal(await exists(storeDir(dir)), false);
});

test('#473: an index that cannot be read is left alone, and nothing is written', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a')));
  await storage.whenWritesSettled();
  await fs.rm(indexFile(dir));
  await fs.mkdir(indexFile(dir));

  const next = makeStorage(dir);
  assert.deepEqual(await next.listChatSessions(), []);
  await assert.rejects(next.saveChatSession(next.normalizeSessionForStore(chat('b'))), { code: CHAT_HISTORY_UNREADABLE });
  assert.equal(await exists(sessionFile(dir, 'b')), false);
  assert.equal(await exists(sessionFile(dir, 'a')), true);
});

test('#658: an encrypted history is left as it is while encrypted storage is missing', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a')));
  await storage.whenWritesSettled();
  const before = await namesIn(storeDir(dir));

  const locked = makeStorage(dir, { safeStorage: makeSafeStorage({ available: false }) });
  assert.deepEqual(await locked.listChatSessions(), []);
  await assert.rejects(locked.setActiveChatId('__none__', 'a'), { code: CHAT_HISTORY_UNREADABLE });
  assert.deepEqual(await namesIn(storeDir(dir)), before);
  assert.deepEqual(await namesIn(dir), ['chat-history']);
});

test('a history under another key is set aside as one folder, reported once, and keeps its images', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  for (const id of ['a', 'b', 'c']) await storage.saveChatSession(storage.normalizeSessionForStore(chat(id)));
  await storage.whenWritesSettled();

  const events = [];
  const other = makeStorage(dir, { safeStorage: makeSafeStorage({ key: 'other' }), events });
  assert.deepEqual(await other.listChatSessions(), []);
  const aside = (await namesIn(dir)).filter((name) => name.startsWith('chat-history.undecryptable-'));
  assert.equal(aside.length, 1);
  assert.equal((await namesIn(path.join(dir, aside[0]))).filter((n) => n.endsWith('.json')).length, 4, 'every byte kept');
  assert.deepEqual(events.map((e) => [e.type, e.store, e.file]), [['set-aside', 'chatHistory', 'chat-history']]);
  assert.equal(await other.hasSetAsideChatHistory(), true);

  await other.saveChatSession(other.normalizeSessionForStore(chat('d')));
  assert.deepEqual((await other.listChatSessions()).map((s) => s.id), ['d']);
});

test('a broken index is set aside and rebuilt from the chats, without a notice', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a', { updatedAt: 1000 })));
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('b', { updatedAt: 2000, messages: 4 })));
  await storage.whenWritesSettled();
  await fs.writeFile(indexFile(dir), '{ "version": 3, "sess', 'utf8');

  const events = [];
  const next = makeStorage(dir, { events });
  const list = await next.listChatSessions();
  assert.deepEqual(list.map((s) => s.id), ['b', 'a']);
  assert.equal(list[0].messageCount, 4);
  assert.deepEqual(events, [], 'no chat is lost, so there is nothing to tell');
  assert.equal((await namesIn(storeDir(dir))).filter((n) => n.startsWith('index.json.undecryptable-')).length, 1);
  assert.equal(await next.hasSetAsideChatHistory(), false, 'an index moved aside holds no chat whose images must stay');
});

test('a chat whose file is broken is set aside when it is opened; the others stay', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a')));
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('b')));
  await storage.whenWritesSettled();
  // Half a file — what a disk error could leave behind.
  const broken = (await fs.readFile(sessionFile(dir, 'a'), 'utf8')).slice(0, 40);
  await fs.writeFile(sessionFile(dir, 'a'), broken, 'utf8');

  const events = [];
  const next = makeStorage(dir, { events });
  assert.deepEqual((await next.listChatSessions()).map((s) => s.id).sort(), ['a', 'b']);
  assert.equal(await next.getChatSession('a'), null);
  assert.deepEqual((await next.listChatSessions()).map((s) => s.id), ['b']);
  const aside = (await namesIn(storeDir(dir))).filter((n) => n.startsWith(`${chatSessionFileName('a')}.undecryptable-`));
  assert.equal(aside.length, 1);
  assert.equal(await fs.readFile(path.join(storeDir(dir), aside[0]), 'utf8'), broken, 'byte for byte');
  assert.deepEqual(events.map((e) => [e.type, e.store]), [['set-aside', 'chatSession']]);
  assert.equal(await next.hasSetAsideChatHistory(), true, 'its images stay while the copy is there (#565)');
  assert.equal((await next.getChatSession('b')).messages.length, 2);
});

test('#561: a chat whose file cannot be moved aside is not written over', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a')));
  await storage.whenWritesSettled();
  await fs.writeFile(sessionFile(dir, 'a'), 'not json', 'utf8');
  const stuck = {
    ...fs,
    rename: async (from, to) => {
      if (path.basename(String(from)) === chatSessionFileName('a')) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fs.rename(from, to);
    },
  };
  const next = makeStorage(dir, { fsImpl: stuck });
  assert.equal(await next.getChatSession('a'), null);
  await assert.rejects(next.saveChatSession(next.normalizeSessionForStore(chat('a', { updatedAt: 9000 }))), { code: CHAT_HISTORY_UNREADABLE });
  assert.equal(await fs.readFile(sessionFile(dir, 'a'), 'utf8'), 'not json');
});

test('#566: a history from a newer release is set aside as a folder, byte for byte', async (t) => {
  const dir = await tempDir(t);
  await fs.mkdir(storeDir(dir));
  const raw = JSON.stringify(encrypt({ version: 4, sessions: [], future: true }));
  await fs.writeFile(indexFile(dir), raw, 'utf8');
  const events = [];
  const storage = makeStorage(dir, { events });
  assert.deepEqual(await storage.listChatSessions(), []);
  const aside = (await namesIn(dir)).filter((name) => name.startsWith('chat-history.unreadable-'));
  assert.equal(aside.length, 1);
  assert.equal(await fs.readFile(path.join(dir, aside[0], 'index.json'), 'utf8'), raw);
  assert.deepEqual(events.map((e) => e.store), ['chatHistory']);
});

test('#566: a chat file from a newer release is set aside as unreadable, not rewritten', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a')));
  await storage.whenWritesSettled();
  const raw = JSON.stringify(encrypt({ version: 9, session: chat('a') }));
  await fs.writeFile(sessionFile(dir, 'a'), raw, 'utf8');
  const next = makeStorage(dir);
  assert.equal(await next.getChatSession('a'), null);
  const aside = (await namesIn(storeDir(dir))).filter((n) => n.startsWith(`${chatSessionFileName('a')}.unreadable-`));
  assert.equal(aside.length, 1);
  assert.equal(await fs.readFile(path.join(storeDir(dir), aside[0]), 'utf8'), raw);
});

test('the index follows the folder: a chat without an entry is taken in, an entry without a file is dropped', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a', { updatedAt: 1000 })));
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('b', { updatedAt: 2000 })));
  await storage.whenWritesSettled();
  const indexBefore = await fs.readFile(indexFile(dir), 'utf8');
  // A save whose index write never landed, and a delete whose index write never did.
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('c', { updatedAt: 3000, messages: 6 })));
  await storage.whenWritesSettled();
  await fs.writeFile(indexFile(dir), indexBefore, 'utf8');
  await fs.rm(sessionFile(dir, 'a'));

  const next = makeStorage(dir);
  const list = await next.listChatSessions();
  assert.deepEqual(list.map((s) => s.id), ['c', 'b']);
  assert.equal(list[0].messageCount, 6);
  await next.whenWritesSettled();
  assert.deepEqual((await readStoreFile(indexFile(dir))).data.sessions.map((s) => s.id), ['c', 'b'], 'and the index is written so');
});

// ── Changes ────────────────────────────────────────────────────────────────

test('concurrent changes all land, and a burst of them shares its index writes', async (t) => {
  const dir = await tempDir(t);
  let indexWrites = 0;
  const counting = {
    ...fs,
    open: async (file, ...rest) => {
      if (path.basename(String(file)).startsWith('index.json.tmp-')) indexWrites += 1;
      return fs.open(file, ...rest);
    },
  };
  const storage = makeStorage(dir, { fsImpl: counting });
  await storage.listChatSessions();
  const ids = Array.from({ length: 20 }, (_, i) => `chat-${i}`);
  await Promise.all(ids.map((id, i) => storage.saveChatSession(storage.normalizeSessionForStore(chat(id, { updatedAt: 1000 + i })))));
  const afterSaves = indexWrites;
  assert.ok(afterSaves <= ids.length, `20 saves took ${afterSaves} index writes`);
  await Promise.all(ids.map((id) => storage.setActiveChatId(`ws-${id}`, id)));
  assert.ok(indexWrites - afterSaves <= 2, `20 pointers took ${indexWrites - afterSaves} index writes`);
  const index = await readStoreFile(indexFile(dir));
  assert.equal(index.data.sessions.length, 20);
  assert.equal(Object.keys(index.data.activeByWorkspace).length, 20);
  for (const id of ids) assert.equal(await exists(sessionFile(dir, id)), true);
});

test('changes not awaited are on the disk once the quit has waited for the writes (#679)', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a', { updatedAt: 1000 })));
  void storage.saveChatSession(storage.normalizeSessionForStore(chat('b', { updatedAt: 2000 })));
  void storage.setActiveChatId('__none__', 'b');
  void storage.patchChatSession('a', { toolPermissionMode: 'ask-all' });
  void storage.deleteChatSession('a');
  void storage.saveChatSession(storage.normalizeSessionForStore(chat('c', { updatedAt: 3000 })));
  await storage.whenWritesSettled();

  const index = await readStoreFile(indexFile(dir));
  assert.deepEqual(index.data.sessions.map((s) => s.id), ['c', 'b']);
  assert.deepEqual(index.data.activeByWorkspace, { __none__: 'b' });
  assert.equal(await exists(sessionFile(dir, 'a')), false);
  const next = makeStorage(dir);
  assert.equal((await next.getChatSession('c')).messages.length, 2);
});

test('a save with nothing new writes no file; a setting goes to the index alone', async (t) => {
  const dir = await tempDir(t);
  let sessionWrites = 0;
  const counting = {
    ...fs,
    open: async (file, ...rest) => {
      if (path.basename(String(file)).startsWith(`${chatSessionFileName('a')}.tmp-`)) sessionWrites += 1;
      return fs.open(file, ...rest);
    },
  };
  const storage = makeStorage(dir, { fsImpl: counting });
  const session = storage.normalizeSessionForStore(chat('a'));
  await storage.saveChatSession(session);
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a')));
  assert.equal(sessionWrites, 1);

  assert.equal(await storage.patchChatSession('a', { modelPresetId: 'preset-2', toolPermissionMode: 'ask-all' }), true);
  assert.equal(sessionWrites, 1);
  assert.equal((await storage.getChatSessionMeta('a')).toolPermissionMode, 'ask-all');
  assert.equal((await storage.getChatSession('a')).modelPresetId, 'preset-2', 'the whole chat carries the index\'s settings');
  assert.equal(await storage.patchChatSession('missing', { toolPermissionMode: 'ask-all' }), false);
  await storage.whenWritesSettled();
  const next = makeStorage(dir);
  assert.equal((await next.getChatSessionMeta('a')).modelPresetId, 'preset-2');
});

test('the oldest chats beyond the limit go with their files and pointers', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir, { maxChatSessions: 2 });
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('old', { updatedAt: 1000 })));
  await storage.setActiveChatId('__none__', 'old');
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('mid', { updatedAt: 2000 })));
  const { droppedIds } = await storage.saveChatSession(storage.normalizeSessionForStore(chat('new', { updatedAt: 3000 })));
  assert.deepEqual(droppedIds, ['old']);
  assert.deepEqual((await storage.listChatSessions()).map((s) => s.id), ['new', 'mid']);
  assert.equal(await storage.getActiveChatId('__none__'), null);
  assert.equal(await exists(sessionFile(dir, 'old')), false);
});

test('a delete whose file cannot be removed fails, and the chat stays (#582)', async (t) => {
  const dir = await tempDir(t);
  const stuck = {
    ...fs,
    unlink: async (file) => {
      if (path.basename(String(file)) === chatSessionFileName('a')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return fs.unlink(file);
    },
  };
  const storage = makeStorage(dir, { fsImpl: stuck });
  await storage.saveChatSession(storage.normalizeSessionForStore(chat('a')));
  await assert.rejects(storage.deleteChatSession('a'), { code: 'EACCES' });
  assert.deepEqual((await storage.listChatSessions()).map((s) => s.id), ['a']);
  assert.equal((await storage.getChatSession('a')).messages.length, 2);
});

test('a pointer that stays as it was writes nothing', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  assert.equal(await storage.setActiveChatId('__none__', null), false);
  assert.equal(await exists(indexFile(dir)), false);
  assert.equal(await storage.setActiveChatId('__none__', 'a'), true);
  assert.equal(await storage.setActiveChatId('__none__', 'a'), false);
});

// ── What the renderer gets ─────────────────────────────────────────────────

test('the history list carries no messages; a chat brings them when it is opened', async (t) => {
  const dir = await tempDir(t);
  const ws = path.resolve(dir, 'project');
  const other = path.resolve(dir, 'other');
  await writeLegacy(dir, legacyStore([
    chat('a', { workspaceRoot: ws, title: 'Alpha', updatedAt: 2000, messages: 4 }),
    { id: 'img', workspaceRoot: ws, updatedAt: 1000, messages: [{ role: 'user', content: '', attachments: [{ kind: 'image', file: `${'a'.repeat(32)}.png`, mediaType: 'image/png' }] }] },
    chat('elsewhere', { workspaceRoot: other }),
  ], { [ws]: 'a' }));
  const storage = makeStorage(dir);
  const ipcMain = makeHandlers(storage, { activeRoot: ws });

  const history = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(history.activeChatId, 'a');
  assert.deepEqual(history.sessions.map((s) => s.id), ['a', 'img']);
  assert.equal(history.sessions.some((s) => 'messages' in s), false);
  assert.deepEqual(history.sessions[0], { id: 'a', workspaceRoot: ws, title: 'Alpha', updatedAt: 2000, messageCount: 4 });
  assert.deepEqual(history.sessions[1].title, { key: 'chat.title.image' }, 'a chat without a title is named in the reader\'s language');

  const opened = await ipcMain.invoke(REQ.CHAT_HISTORY_GET_SESSION, 'a');
  assert.equal(opened.session.messages.length, 4);
  assert.equal(opened.session.title, 'Alpha');
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_GET_SESSION, 'elsewhere'), { session: null }, 'only the open folder\'s chats (#68)');
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_GET_SESSION, 'missing'), { session: null });
});

test('a save after an upsert round trip keeps the chat\'s file and the list in step', async (t) => {
  const dir = await tempDir(t);
  const storage = makeStorage(dir);
  const ipcMain = makeHandlers(storage);
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chat('a', { messages: 2 })), { ok: true });
  const first = (await ipcMain.invoke(REQ.CHAT_HISTORY_GET)).sessions[0];
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chat('a', { messages: 2 })), { ok: true });
  assert.equal((await ipcMain.invoke(REQ.CHAT_HISTORY_GET)).sessions[0].updatedAt, first.updatedAt, 'nothing said, no new time (#245)');
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chat('a', { messages: 4 })), { ok: true });
  const after = (await ipcMain.invoke(REQ.CHAT_HISTORY_GET)).sessions[0];
  assert.equal(after.messageCount, 4);
  assert.ok(after.updatedAt > first.updatedAt);
  await storage.whenWritesSettled();
  assert.equal((await readStoreFile(sessionFile(dir, 'a'))).data.session.messages.length, 4);
});
