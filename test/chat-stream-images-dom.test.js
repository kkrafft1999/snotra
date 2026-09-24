// Der Weg vom Markdown des Modells bis zum geladenen Bild (Issue #244).
//
// Der vorige Test (chat-workspace-images-dom) prueft das Aufloesen selbst.
// Hier geht es um die Verdrahtung darum herum: dass ChatStream es an den drei
// Stellen aufruft, an denen HTML gesetzt wird — waehrend des Streams (nur
// Platzhalter), beim Abschluss der Nachricht und beim erneuten Zeichnen eines
// gespeicherten Verlaufs.
//
// Dafuer braucht `markdownToSafeHtml` ein echtes `marked`, sonst entstuende aus
// `![x](p.png)` nur escapeter Text und es gaebe gar kein <img> zu pruefen.
// DOMPurify ist hier bewusst eine **Attrappe**, die durchreicht: Das echte
// Sanitizing arbeitet unter happy-dom nachweislich falsch (siehe
// test/helpers/dom.js) und wird in `e2e/smoke.test.mjs` in echtem Chromium
// geprueft. Dieser Test sagt nichts ueber Sanitizing aus — nur darueber, was
// mit einem bereits bereinigten Baum passiert.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_1PX}`;

let dom = null;
let chat = null;
let clearWorkspaceImageCache = () => {};
let deltaCallback = null;
let chatImpl = async () => ({ ok: true });
let appStore = null;
const asked = [];
let readImpl = async () => ({ ok: true, mime: 'image/png', base64: PNG_1PX, mtimeMs: 1, size: 70 });

test.before(async () => {
  dom = setupRendererDom();

  // Das echte `marked` aus dem vendor-Ordner, damit `![x](y)` wirklich ein
  // <img> ergibt. Es haengt sich als UMD an `globalThis`.
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };

  ({ clearWorkspaceImageCache } = await importRenderer('chat', 'workspaceImages.js'));
  const { initChatStream } = await importRenderer('components', 'ChatStream.js');
  ({ appStore } = await importRenderer('state', 'store.js'));

  const api = {
    readWorkspaceImage: async (imagePath) => {
      asked.push(imagePath);
      return readImpl(imagePath);
    },
    // Die Abmelder muessen Funktionen sein — der Lauf ruft sie im `finally`.
    onChatDelta: (cb) => { deltaCallback = cb; return () => {}; },
    onChatProgress: () => () => {},
    onChatToolLine: () => () => {},
    getChatHistory: async () => ({ sessions: [] }),
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
    generateChatTitle: async () => ({ title: '' }),
    writeClipboardText: async () => ({ ok: true }),
    abortChat: async () => ({ ok: true }),
    chat: (...args) => chatImpl(...args),
  };

  chat = initChatStream({
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
});

test.after(() => dom?.cleanup());

test.beforeEach(() => {
  asked.length = 0;
  // Ohne das saehe der naechste Test das Bild des vorigen aus dem Cache.
  clearWorkspaceImageCache();
  readImpl = async () => ({ ok: true, mime: 'image/png', base64: PNG_1PX, mtimeMs: 1, size: 70 });
});

/** Zeigt eine fertige Antwort des Modells an. */
function show(content, { streaming = false } = {}) {
  appStore.rootPath = '/ws';
  appStore.currentChatId = 'chat-a';
  appStore.chatMessages = [
    { role: 'user', content: 'Zeichne mir das.' },
    { role: 'assistant', content, ...(streaming ? { streaming: true } : {}) },
  ];
  chat.renderChatMessages();
}

function letzteBlase() {
  const bubbles = document.querySelectorAll('#chat-messages .chat-msg.assistant');
  return bubbles[bubbles.length - 1];
}

test('ein gespeicherter Verlauf holt sein Bild und zeigt es', async () => {
  show('Hier das Ergebnis:\n\n![Diagramm](diagramm.png)\n');
  await flush();

  assert.deepEqual(asked, ['diagramm.png']);
  const img = letzteBlase().querySelector('img');
  assert.ok(img, 'das Markdown hat ein <img> ergeben');
  assert.equal(img.getAttribute('src'), PNG_DATA_URL);
  assert.equal(img.getAttribute('alt'), 'Diagramm');
});

test('ein Verlauf im falschen Ordner zeigt den Platzhalter, nicht fremde Bilder', async () => {
  readImpl = async () => ({ ok: false, reason: 'not-found' });
  show('![Diagramm](diagramm.png)');
  await flush();

  const blase = letzteBlase();
  assert.equal(!!blase.querySelector('img'), false);
  const box = blase.querySelector('.chat-md-image--placeholder');
  assert.ok(box);
  // English is the default language of the interface (#277); the reason comes
  // from the catalogue now, not from the contract (#293).
  assert.equal(box.querySelector('.chat-md-image-reason').textContent, 'Image not found');
});

test('waehrend die Antwort laeuft, wird nichts geholt', async () => {
  show('![Diagramm](diagramm.png)', { streaming: true });
  await flush();

  assert.deepEqual(asked, []);
  const blase = letzteBlase();
  assert.equal(!!blase.querySelector('img'), false);
  assert.ok(blase.querySelector('.chat-md-image--pending'));
});

test('ein absoluter Pfad aus dem Workspace kommt genauso an', async () => {
  const abs = '/ws/bilder/plot.png';
  show(`![Plot](${abs})`);
  await flush();

  assert.deepEqual(asked, [abs]);
  assert.equal(letzteBlase().querySelector('img').getAttribute('src'), PNG_DATA_URL);
});

test('ein Windows-Pfad ueberlebt den Weg durch Markdown', async () => {
  // Markdown erzeugt eine URL: `marked` macht aus `C:\ws\plot.png` das
  // `src` `C:%5Cws%5Cplot.png`. Ohne Rueckwandlung suchte der Main-Prozess
  // eine Datei, die es unter diesem Namen nirgends gibt. Plattformunabhaengig
  // pruefbar, weil hier nur der Renderer beteiligt ist.
  show(String.raw`![Plot](C:\ws\bilder\plot.png)`);
  await flush();

  assert.deepEqual(asked, ['C:\\ws\\bilder\\plot.png']);
  assert.equal(letzteBlase().querySelector('img').getAttribute('src'), PNG_DATA_URL);
});

test('ein nachlaufender Stream-Frame ueberschreibt das fertige Bild nicht', async () => {
  // Der Fall, der die Bilder im Handlauf verschwinden liess: Das letzte
  // Textstueck plant einen Animation-Frame; die Antwort ist fertig, bevor der
  // Frame laeuft. Ohne Abbestellen schriebe er den Zwischenstand samt
  // Platzhaltern zurueck ueber das schon geladene Bild.
  const ANTWORT = '![Diagramm](diagramm.png)';
  chatImpl = async (_messages, options) => {
    // Genau die Reihenfolge des echten Laufs: Delta waehrend `api.chat` laeuft.
    // Events name their chat and run since #320.
    deltaCallback?.({ text: '![Diagr', chatId: options?.chatId, runId: options?.runId });
    return { ok: true, content: ANTWORT, toolTrace: [] };
  };
  appStore.rootPath = '/ws';
  appStore.chatMessages = [];
  appStore.chatSessionId = (appStore.chatSessionId || 0) + 1;

  const input = document.getElementById('chat-input');
  input.value = 'Zeichne mir das.';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  document.getElementById('btn-chat-send').click();

  // Lange genug, dass ein nicht abbestellter Frame gelaufen waere.
  await new Promise((resolve) => setTimeout(resolve, 80));
  await flush();

  const blase = letzteBlase();
  assert.equal(!!blase.querySelector('.chat-md-image--pending'), false,
    'der Zwischenstand darf nicht zurueckkommen');
  assert.equal(blase.querySelector('img')?.getAttribute('src'), PNG_DATA_URL);
});
