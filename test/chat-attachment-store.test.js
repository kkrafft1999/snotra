// Bild-Anhaenge im gespeicherten Verlauf (Issue #94).
//
// Zwei Zusagen stehen hier auf dem Pruefstand: die Verlaufsdatei bleibt frei
// von Base64, und die Bilder verschwinden mit dem Chat, zu dem sie gehoeren.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createStorageService } = require('../src/main/services/storage-service');
const { createChatAttachmentStore } = require('../src/main/services/chat-attachment-store');
const { createChatHistoryStorePort } = require('../src/main/adapters/persistence-store-adapters');
const { createMockProviderCatalog } = require('./helpers/provider-ports');
const { registerChatHistoryHandlers } = require('../src/main/ipc/chat-history-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

// 1×1 PNG, gross genug fuer einen echten Roundtrip und klein genug fuer den Test.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_1PX_RED =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z/C/HgAGgwJ/lK3Q6wAAAABJRU5ErkJggg==';

function imageAttachment(dataBase64 = PNG_1PX, name = 'Screenshot.png') {
  return { kind: 'image', mediaType: 'image/png', dataBase64, name };
}

async function setup(t, { maxChatSessions = 3 } = {}) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-attach-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const app = { getPath: () => tmpDir };
  const storage = createStorageService({
    app,
    safeStorage: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => ({ defaultModel: 'gpt-4o', fields: { apiKey: true } })),
    maxChatSessions,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const chatAttachments = createChatAttachmentStore({ app, fs, path, log: { warn() {} } });
  const ipcMain = createMockIpcMain();
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore: createChatHistoryStorePort(storage),
    REQ,
    chatAttachments,
    getActiveWorkspaceRoot: () => null,
  });
  const attachmentsDir = (chatId) => path.join(tmpDir, 'chat-attachments', chatId);
  const readRawHistory = async () => fs.readFile(path.join(tmpDir, 'chat-history.json'), 'utf8');
  return { ipcMain, chatAttachments, tmpDir, attachmentsDir, readRawHistory };
}

function sessionWithImage(id, { content = 'Was steht da?', attachments = [imageAttachment()] } = {}) {
  return { id, updatedAt: 1000, messages: [{ role: 'user', content, attachments }] };
}

test('Bild überlebt Speichern und Laden — als Datei-Referenz, nicht als Base64', async (t) => {
  const { ipcMain, attachmentsDir, readRawHistory } = await setup(t);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-a'));

  const raw = await readRawHistory();
  assert.equal(raw.includes(PNG_1PX), false, 'Base64 steht in der Verlaufsdatei');
  assert.equal(raw.includes('dataBase64'), false);

  const files = await fs.readdir(attachmentsDir('chat-a'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^[0-9a-f]{64}\.png$/);

  const { sessions } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  const [attachment] = sessions[0].messages[0].attachments;
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.mediaType, 'image/png');
  assert.equal(attachment.file, files[0]);
  assert.equal(attachment.name, 'Screenshot.png');

  const image = await ipcMain.invoke(REQ.CHAT_ATTACHMENT_READ, 'chat-a', attachment.file);
  assert.deepEqual(image, { ok: true, mediaType: 'image/png', dataBase64: PNG_1PX });
});

test('dieselbe Nachricht mehrfach sichern legt keine zweite Datei an', async (t) => {
  const { ipcMain, attachmentsDir } = await setup(t);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-a'));
  const [file] = await fs.readdir(attachmentsDir('chat-a'));

  // Runde zwei: der Renderer schickt dieselbe Nachricht erneut mit — einmal
  // noch mit Bilddaten, einmal nur noch mit der Referenz.
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-a'));
  await ipcMain.invoke(
    REQ.CHAT_HISTORY_UPSERT,
    sessionWithImage('chat-a', { attachments: [{ kind: 'image', mediaType: 'image/png', file }] })
  );

  assert.deepEqual(await fs.readdir(attachmentsDir('chat-a')), [file]);
  const { sessions } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(sessions[0].messages[0].attachments[0].file, file);
});

test('Nachricht ohne Text, nur mit Bild, bleibt erhalten und benennt den Chat', async (t) => {
  const { ipcMain } = await setup(t);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-a', { content: '' }));

  const { sessions } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(sessions.length, 1);
  // Stored without a fallback title; the header and history work it out (#359).
  assert.equal(sessions[0].title, '');
  assert.equal(sessions[0].messages[0].content, '');
  assert.equal(sessions[0].messages[0].attachments.length, 1);
});

test('fehlende Datei beim Laden ist kein Fehler, sondern ein leeres Ergebnis', async (t) => {
  const { ipcMain, attachmentsDir } = await setup(t);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-a'));
  const [file] = await fs.readdir(attachmentsDir('chat-a'));
  await fs.rm(path.join(attachmentsDir('chat-a'), file));

  // Die Session selbst laedt weiterhin, samt Referenz — der Renderer zeigt
  // dafuer einen Platzhalter.
  const { sessions } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(sessions[0].messages[0].attachments[0].file, file);
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_ATTACHMENT_READ, 'chat-a', file), { ok: false });
});

test('das Lesen nimmt nur Dateinamen an, die die Ablage selbst vergeben hat', async (t) => {
  const { ipcMain, tmpDir } = await setup(t);
  await fs.writeFile(path.join(tmpDir, 'geheim.png'), 'streng geheim');

  for (const file of ['../geheim.png', '../../geheim.png', 'geheim.png', `${'a'.repeat(64)}.png.exe`, '']) {
    assert.deepEqual(
      await ipcMain.invoke(REQ.CHAT_ATTACHMENT_READ, 'chat-a', file),
      { ok: false },
      `Dateiname durchgelassen: ${file}`
    );
  }
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_ATTACHMENT_READ, '', `${'a'.repeat(64)}.png`), { ok: false });
});

test('Bilder eines gelöschten Chats werden mit entfernt', async (t) => {
  const { ipcMain, attachmentsDir } = await setup(t);

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-a'));
  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-b', { attachments: [imageAttachment(PNG_1PX_RED)] }));
  await ipcMain.invoke(REQ.CHAT_HISTORY_DELETE, 'chat-a');

  await assert.rejects(() => fs.readdir(attachmentsDir('chat-a')), { code: 'ENOENT' });
  assert.equal((await fs.readdir(attachmentsDir('chat-b'))).length, 1);
});

test('aus MAX_CHAT_SESSIONS gefallene Chats lassen ihre Bilder nicht liegen', async (t) => {
  const { ipcMain, attachmentsDir, tmpDir } = await setup(t, { maxChatSessions: 2 });

  for (const [index, id] of ['chat-a', 'chat-b', 'chat-c'].entries()) {
    await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, {
      ...sessionWithImage(id, { attachments: [imageAttachment(index === 0 ? PNG_1PX : PNG_1PX_RED)] }),
      updatedAt: 1000 + index,
    });
  }

  const remaining = await fs.readdir(path.join(tmpDir, 'chat-attachments'));
  assert.deepEqual(remaining.sort(), ['chat-b', 'chat-c']);
  assert.equal((await fs.readdir(attachmentsDir('chat-c'))).length, 1);
});

test('verwaiste Ordner verschwinden beim nächsten Sichern', async (t) => {
  const { ipcMain, tmpDir } = await setup(t);
  const orphan = path.join(tmpDir, 'chat-attachments', 'chat-von-gestern');
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, `${'a'.repeat(64)}.png`), 'alt');

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-a'));

  assert.deepEqual(await fs.readdir(path.join(tmpDir, 'chat-attachments')), ['chat-a']);
});

test('eine Chat-ID, die als Ordnername nicht taugt, führt nicht aus der Ablage heraus', async (t) => {
  const { chatAttachments, tmpDir } = await setup(t);

  const [message] = await chatAttachments.persistMessages('../../entwischt', [
    { role: 'user', content: '', attachments: [imageAttachment()] },
  ]);
  const file = message.attachments[0].file;
  assert.ok(file);

  const dirs = await fs.readdir(path.join(tmpDir, 'chat-attachments'));
  assert.deepEqual(dirs.length, 1);
  assert.match(dirs[0], /^[0-9a-f]{32}$/);
  // Und die Bilddaten sind ueber dieselbe ID wieder lesbar.
  const image = await chatAttachments.readAttachment('../../entwischt', file);
  assert.equal(image.ok, true);
  assert.equal(image.dataBase64, PNG_1PX);
});

test('ohne Anhang-Ablage bleibt der Verlauf frei von Bilddaten', async (t) => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-attach-off-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const storage = createStorageService({
    app: { getPath: () => tmpDir },
    safeStorage: { isEncryptionAvailable: () => false },
    fs,
    path,
    providerCatalog: createMockProviderCatalog(() => ({ defaultModel: 'gpt-4o', fields: { apiKey: true } })),
    maxChatSessions: 3,
    maxFolderHistory: 5,
    defaultProviderId: 'openai',
  });
  const ipcMain = createMockIpcMain();
  registerChatHistoryHandlers({
    ipcMain,
    chatHistoryStore: createChatHistoryStorePort(storage),
    REQ,
    getActiveWorkspaceRoot: () => null,
  });

  await ipcMain.invoke(REQ.CHAT_HISTORY_UPSERT, sessionWithImage('chat-a'));

  const raw = await fs.readFile(path.join(tmpDir, 'chat-history.json'), 'utf8');
  assert.equal(raw.includes(PNG_1PX), false);
  const { sessions } = await ipcMain.invoke(REQ.CHAT_HISTORY_GET);
  assert.equal(sessions[0].messages[0].attachments, undefined);
  assert.deepEqual(await ipcMain.invoke(REQ.CHAT_ATTACHMENT_READ, 'chat-a', `${'a'.repeat(64)}.png`), { ok: false });
});
