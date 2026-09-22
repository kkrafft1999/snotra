// Bilder einer gesendeten Nachricht am echten DOM (Issue #94).
//
// Geprueft wird die Verdrahtung, die sich weder im Contract noch in der Ablage
// zeigt: dass ein aus dem Verlauf geladener Anhang nachgeholt wird, dass eine
// verschwundene Datei als Platzhalter statt als kaputtes Bild endet, und dass
// der Klick auf ein Thumbnail das Bild gross zeigt.
//
// Zu den Grenzen des Stacks (kein Layout, kein Sanitizing) siehe
// test/helpers/dom.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const STORED_FILE = `${'c'.repeat(64)}.png`;

let harness = null;
/** Pro Test austauschbar: die Antwort des Main-Prozesses auf das Nachladen. */
let readAttachmentImpl = async () => ({ ok: true, mediaType: 'image/png', dataBase64: PNG_1PX });

async function getHarness() {
  if (harness) return harness;
  const dom = setupRendererDom();
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  const { appStore } = await importRenderer('state', 'store.js');

  const reads = [];
  const api = {
    readChatAttachment: async (chatId, file) => {
      reads.push({ chatId, file });
      return readAttachmentImpl(chatId, file);
    },
    onChatDelta: () => {},
    onChatProgress: () => {},
    onChatToolLine: () => {},
    getChatHistory: async () => ({ sessions: [] }),
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
    generateChatTitle: async () => ({ title: '' }),
    writeClipboardText: async () => ({ ok: true }),
    abortChat: async () => ({ ok: true }),
    chat: async () => ({ ok: true }),
  };

  const chat = initChatStream({
    api,
    appStore,
    onInputChanged() {},
    stopChatVoiceListening() {},
    activeProviderConfigured: () => true,
    activeProviderSupportsImages: () => true,
    syncLiveDot() {},
    syncChatTitle() {},
    onWorkspaceFileWritten() {},
    approvalCards: { mount() {}, beginRun() {}, reset() {} },
  });

  harness = {
    reads,
    appStore,
    /** Zeigt eine Nutzerfrage mit den uebergebenen Anhaengen an. */
    show(attachments, { content = 'Was steht da?' } = {}) {
      appStore.currentChatId = 'chat-a';
      appStore.chatMessages = [{ role: 'user', content, attachments }];
      chat.renderChatMessages();
    },
    reset() {
      reads.length = 0;
      readAttachmentImpl = async () => ({ ok: true, mediaType: 'image/png', dataBase64: PNG_1PX });
      appStore.chatMessages = [];
      appStore.chatSessionId = 0;
      chat.renderChatMessages();
      document.getElementById('image-lightbox').classList.add('hidden');
    },
    cleanup() { dom.cleanup(); },
  };
  return harness;
}

test.after(() => harness?.cleanup());
test.beforeEach(async () => { (await getHarness()).reset(); });

const tiles = () => [...document.querySelectorAll('#chat-messages .chat-msg-attachment')];
const lightbox = () => document.getElementById('image-lightbox');

test('frisch eingefügtes Bild wird sofort gezeigt, ohne Nachladen', async (t) => {
  const { show, reads } = await getHarness();
  show([{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX, name: 'Fehler.png' }]);
  await flush();

  const [tile] = tiles();
  assert.equal(tile.tagName, 'BUTTON');
  assert.equal(tile.querySelector('img').src, `data:image/png;base64,${PNG_1PX}`);
  assert.equal(tile.querySelector('img').alt, 'Fehler.png');
  assert.deepEqual(reads, []);
});

test('aus dem Verlauf geladener Anhang wird nachgeholt und danach gemerkt', async (t) => {
  const { show, reads, appStore } = await getHarness();
  const attachment = { kind: 'image', mediaType: 'image/png', file: STORED_FILE, name: 'Fehler.png' };
  show([attachment]);

  // Vor der Antwort steht ein beschrifteter Platzhalter, kein leeres Bild.
  assert.equal(tiles()[0].tagName, 'DIV');
  assert.match(tiles()[0].textContent, /Loading image/);

  await flush();
  assert.deepEqual(reads, [{ chatId: 'chat-a', file: STORED_FILE }]);
  assert.equal(tiles()[0].querySelector('img').src, `data:image/png;base64,${PNG_1PX}`);

  // Die Daten haengen jetzt am Anhang: erneutes Rendern kommt ohne IPC aus,
  // und eine Anschlussfrage nimmt das Bild wieder mit zum Modell.
  assert.equal(attachment.dataBase64, PNG_1PX);
  appStore.chatMessages = [{ role: 'user', content: 'Und jetzt?', attachments: [attachment] }];
  show([attachment]);
  await flush();
  assert.equal(reads.length, 1);
});

test('fehlende Datei endet als Platzhalter, nicht als kaputtes Bild', async () => {
  const { show } = await getHarness();
  readAttachmentImpl = async () => ({ ok: false });
  show([{ kind: 'image', mediaType: 'image/png', file: STORED_FILE, name: 'Fehler.png' }]);
  await flush();

  const [tile] = tiles();
  assert.equal(tile.querySelector('img'), null);
  assert.match(tile.textContent, /no longer there/);
  // Der Zustand steht auch fuer Screenreader da, nicht nur als Grauton.
  assert.match(tile.getAttribute('aria-label'), /Fehler\.png: Image no longer there/);
});

test('ein Fehler beim Nachladen wird wie eine fehlende Datei behandelt', async () => {
  const { show } = await getHarness();
  readAttachmentImpl = async () => { throw new Error('IPC weg'); };
  show([{ kind: 'image', mediaType: 'image/png', file: STORED_FILE }]);
  await flush();

  assert.match(tiles()[0].textContent, /no longer there/);
});

test('ein Chatwechsel während des Nachladens schreibt nicht in den neuen Chat', async () => {
  const { show, appStore } = await getHarness();
  let release = null;
  readAttachmentImpl = () => new Promise((resolve) => { release = resolve; });
  show([{ kind: 'image', mediaType: 'image/png', file: STORED_FILE }]);

  appStore.chatSessionId += 1;
  appStore.chatMessages = [];
  document.getElementById('chat-messages').innerHTML = '';
  release({ ok: true, mediaType: 'image/png', dataBase64: PNG_1PX });
  await flush();

  assert.deepEqual(tiles(), []);
});

test('Klick auf das Thumbnail öffnet das Bild größer und gibt den Fokus zurück', async () => {
  const { show } = await getHarness();
  show([{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX, name: 'Fehler.png' }]);
  await flush();

  const [tile] = tiles();
  assert.match(tile.getAttribute('aria-label'), /enlarged/);
  tile.click();

  assert.equal(lightbox().classList.contains('hidden'), false);
  assert.equal(lightbox().getAttribute('aria-hidden'), 'false');
  const big = document.getElementById('image-lightbox-img');
  assert.equal(big.src, `data:image/png;base64,${PNG_1PX}`);
  assert.equal(document.getElementById('image-lightbox-caption').textContent, 'Fehler.png');
  assert.equal(document.activeElement, document.getElementById('image-lightbox-close'));

  document.getElementById('image-lightbox-close').click();
  assert.equal(lightbox().classList.contains('hidden'), true);
  assert.equal(big.getAttribute('src'), null, 'Bilddaten bleiben im geschlossenen Dialog liegen');
  assert.equal(document.activeElement, tile);
});

test('Escape und ein Klick auf den Hintergrund schließen das große Bild', async () => {
  const { show } = await getHarness();
  show([{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX }]);
  await flush();

  tiles()[0].click();
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(lightbox().classList.contains('hidden'), true);

  tiles()[0].click();
  document.getElementById('image-lightbox-backdrop').click();
  assert.equal(lightbox().classList.contains('hidden'), true);
});

test('ein Platzhalter ist nicht anklickbar', async () => {
  const { show } = await getHarness();
  readAttachmentImpl = async () => ({ ok: false });
  show([{ kind: 'image', mediaType: 'image/png', file: STORED_FILE }]);
  await flush();

  tiles()[0].click();
  assert.equal(lightbox().classList.contains('hidden'), true);
});
