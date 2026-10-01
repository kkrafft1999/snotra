// Findings of the code review of block B08 (#493): a history moved aside keeps
// its images (#565), a history from a newer release is not rewritten (#566),
// and the smaller items of the bundle (#567).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatAttachmentStore } = require('../src/main/services/chat-attachment-store');
const { createChatSessionSettings } = require('../src/main/services/chat-session-settings');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { registerChatHistoryHandlers } = require('../src/main/ipc/chat-history-handlers');
const { sanitizeChatMessagesForStore } = require('../src/main/services/chat-history-normalization');
const { CHAT_ACTIVATION } = require('../src/shared/contracts/chat');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const silentLog = { warn() {}, info() {}, error() {} };

/**
 * A `safeStorage` whose decryption can be switched off — as when the keychain
 * refuses once, is locked, or the Linux keyring is not unlocked yet.
 */
function switchableSafeStorage() {
  const state = { decrypts: true };
  return {
    state,
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(`X${text}`),
    decryptString: (buf) => {
      if (!state.decrypts) throw new Error('keychain refused');
      return buf.toString().slice(1);
    },
  };
}

async function tempUserData(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-b08-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** One start of the app: storage, attachment store and handlers on `dir`. */
function start(dir, { safeStorage = { isEncryptionAvailable: () => false }, maxChatSessions = 50, fsImpl = fs, platform } = {}) {
  const app = { getPath: () => dir };
  const storage = createStorageService({
    app,
    safeStorage,
    fs: fsImpl,
    path,
    providerCatalog: createMockProviderCatalog(() => null),
    maxChatSessions,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
    log: silentLog,
  });
  const ipcMain = createMockIpcMain();
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore: createChatHistoryStorePort(storage),
    REQ,
    chatAttachments: createChatAttachmentStore({ app, fs: fsImpl, path, log: silentLog, platform }),
  });
  return { ipcMain, storage };
}

function chatWithImage(id) {
  return {
    id,
    messages: [{ role: 'user', content: 'look', attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX }] }],
  };
}

function textChat(id) {
  return { id, messages: [{ role: 'user', content: `hello from ${id}` }] };
}

async function attachmentFolders(dir) {
  return (await fs.readdir(path.join(dir, 'chat-attachments')).catch(() => [])).sort();
}

async function setAsideCopies(dir) {
  return (await fs.readdir(dir)).filter((name) => name.startsWith('chat-history.json.'));
}

// ── #565 ─────────────────────────────────────────────────────────────────────

test('#565: a history that cannot be decrypted keeps its images while its copy is kept', async (t) => {
  const dir = await tempUserData(t);
  const safeStorage = switchableSafeStorage();

  await start(dir, { safeStorage }).ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chatWithImage('chat-a'));
  assert.deepEqual(await attachmentFolders(dir), ['chat-a']);

  safeStorage.state.decrypts = false;
  const second = start(dir, { safeStorage });
  assert.deepEqual(await second.ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, textChat('chat-b')), { ok: true });

  const copies = await setAsideCopies(dir);
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^chat-history\.json\.undecryptable-/);
  assert.deepEqual(await attachmentFolders(dir), ['chat-a'], 'the image of the set-aside chat is still there');

  // Once the copy is gone, the next save sweeps as before.
  safeStorage.state.decrypts = true;
  await fs.rm(path.join(dir, copies[0]));
  await second.ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, textChat('chat-c'));
  assert.deepEqual(await attachmentFolders(dir), []);
});

test('#565: sessions dropped by MAX_CHAT_SESSIONS lose their images, a set-aside copy or not', async (t) => {
  const dir = await tempUserData(t);
  await fs.writeFile(path.join(dir, 'chat-history.json.undecryptable-2026-01-01T00-00-00-000Z'), '{}');
  const { ipcMain } = start(dir, { maxChatSessions: 2 });

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chatWithImage('chat-1'));
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chatWithImage('chat-2'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chatWithImage('chat-3'));

  const { sessions } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  const kept = sessions.map((s) => s.id).sort();
  assert.equal(kept.length, 2);
  assert.deepEqual(await attachmentFolders(dir), kept);
});

test('#565: without a set-aside copy, orphaned folders are still swept', async (t) => {
  const dir = await tempUserData(t);
  await fs.mkdir(path.join(dir, 'chat-attachments', 'gone'), { recursive: true });
  const { ipcMain } = start(dir);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chatWithImage('chat-a'));

  assert.deepEqual(await attachmentFolders(dir), ['chat-a']);
});

// ── #566 ─────────────────────────────────────────────────────────────────────

const NEWER_HISTORY = {
  version: 3,
  activeByWorkspace: {},
  sessions: [
    {
      id: 'old-1',
      workspaceRoot: null,
      title: 'Kept',
      updatedAt: 5,
      pinned: true,
      messages: [
        { role: 'user', content: 'see file', attachments: [{ kind: 'pdf', mediaType: 'application/pdf', file: 'abc.pdf' }] },
        { role: 'assistant', content: 'ok', citations: [{ url: 'https://example.org' }] },
      ],
    },
  ],
};

test('#566: a history from a newer release is moved aside byte for byte, not rewritten', async (t) => {
  const dir = await tempUserData(t);
  const raw = JSON.stringify(NEWER_HISTORY);
  await fs.writeFile(path.join(dir, 'chat-history.json'), raw);
  const { ipcMain } = start(dir);

  assert.deepEqual((await ipcMain.invoke(REQ.CHAT_HISTORY_GET)).sessions, []);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, textChat('new'));

  const copies = await setAsideCopies(dir);
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^chat-history\.json\.unreadable-/);
  assert.equal(await fs.readFile(path.join(dir, copies[0]), 'utf8'), raw);
  const live = JSON.parse(await fs.readFile(path.join(dir, 'chat-history.json'), 'utf8'));
  assert.equal(live.version, 2);
  assert.deepEqual(live.sessions.map((s) => s.id), ['new']);
});

test('#566: an encrypted history from a newer release is moved aside too, and its images stay', async (t) => {
  const dir = await tempUserData(t);
  const safeStorage = switchableSafeStorage();
  const payload = safeStorage.encryptString(JSON.stringify(NEWER_HISTORY)).toString('base64');
  await fs.writeFile(path.join(dir, 'chat-history.json'), JSON.stringify({ encrypted: true, payload }));
  await fs.mkdir(path.join(dir, 'chat-attachments', 'old-1'), { recursive: true });
  const { ipcMain } = start(dir, { safeStorage });

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, textChat('new'));

  const copies = await setAsideCopies(dir);
  assert.equal(copies.length, 1);
  assert.match(copies[0], /^chat-history\.json\.unreadable-/);
  assert.deepEqual(await attachmentFolders(dir), ['old-1']);
});

test('#566: a legacy history without a version still loads', async (t) => {
  const dir = await tempUserData(t);
  await fs.writeFile(
    path.join(dir, 'chat-history.json'),
    JSON.stringify({ activeChatId: 'legacy', sessions: [{ id: 'legacy', title: 'Old', updatedAt: 1, messages: [{ role: 'user', content: 'hi' }] }] })
  );
  const { ipcMain } = start(dir);

  const { sessions, activeChatId } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);

  assert.deepEqual(sessions.map((s) => s.id), ['legacy']);
  assert.equal(activeChatId, 'legacy');
  assert.deepEqual(await setAsideCopies(dir), []);
});

// ── #567 ─────────────────────────────────────────────────────────────────────

test('#567: an automatic restore does not bring "Auto" back, whatever the activation says', async () => {
  const store = { version: 2, activeByWorkspace: {}, sessions: [{ id: 'chat-auto', toolPermissionMode: 'auto' }] };
  const modes = [];
  const settings = createChatSessionSettings({
    chatHistoryStore: {
      withChatHistoryLock: (fn) => fn(),
      readChatHistoryStore: async () => store,
      writeChatHistoryStore: async () => {},
    },
    applyPreset: async () => {},
    getDefaultPresetId: async () => 'preset-a',
    applyMode: async (mode) => modes.push(mode),
    getWorkspaceMode: async () => null,
    log: silentLog,
  });

  const unknown = await settings.activate('chat-auto', { activation: 'Explicit' });
  assert.equal(unknown.toolPermissionMode, 'smart', 'an unknown activation is the automatic one');

  const explicit = await settings.activate('chat-auto', { activation: CHAT_ACTIVATION.EXPLICIT });
  assert.equal(explicit.toolPermissionMode, 'auto');
  assert.deepEqual(modes, ['smart', 'auto']);
});

test('#567: image parts never reach the stored content, whatever stands next to them', () => {
  const imagePart = { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } };
  const [assistant, single] = sanitizeChatMessagesForStore([
    { role: 'assistant', content: [imagePart, { type: 'tool_use', id: 't1' }] },
    { role: 'assistant', content: { type: 'image', source: { data: PNG_1PX } }, isError: true },
  ]);

  assert.equal(assistant.content.includes(PNG_1PX), false);
  assert.match(assistant.content, /tool_use/);
  assert.equal(single.content, '');
});

test('#567: delete uses one trimmed id for the list and the attachment folder', async (t) => {
  const dir = await tempUserData(t);
  const { ipcMain } = start(dir);
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chatWithImage('chat-a'));
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chatWithImage('chat-b'));

  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_DELETE, '  chat-a '), { ok: true });

  const { sessions } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.deepEqual(sessions.map((s) => s.id), ['chat-b']);
  assert.deepEqual(await attachmentFolders(dir), ['chat-b']);
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_HISTORY_DELETE, 'x'.repeat(129)), { ok: false });
});

test('#567: an image is moved into place with the Windows retry', async (t) => {
  const dir = await tempUserData(t);
  let failures = 0;
  const flakyFs = {
    ...fs,
    rename: async (from, to) => {
      if (from.includes('.tmp-') && failures < 1) {
        failures += 1;
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
      }
      return fs.rename(from, to);
    },
  };
  const { ipcMain } = start(dir, { fsImpl: flakyFs, platform: 'win32' });

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, chatWithImage('chat-a'));

  assert.equal(failures, 1);
  const { sessions } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(sessions[0].messages[0].attachments.length, 1);
  assert.equal((await fs.readdir(path.join(dir, 'chat-attachments', 'chat-a'))).length, 1);
});
