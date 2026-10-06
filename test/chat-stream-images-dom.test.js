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
let progressCallback = null;
let chatImpl = async () => ({ ok: true });
let appStore = null;
const asked = [];
let readImpl = async () => ({ ok: true, mime: 'image/png', base64: PNG_1PX, mtimeMs: 1, size: 70 });

// Animation frames run in order: once ours has run, one scheduled before it
// has run as well. No wall clock, so a slow runner cannot turn a test red.
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

async function until(check, what) {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await flush();
  }
  assert.fail(`timed out waiting for ${what}`);
}

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
    onChatProgress: (cb) => { progressCallback = cb; return () => {}; },
    onChatToolLine: () => () => {},
    getChatHistory: async () => ({ sessions: [] }),
    setActiveChatId: async () => {},
    upsertChatSession: async () => ({ ok: true }),
    generateChatTitle: async () => ({ title: '' }),
    writeClipboardText: async () => ({ ok: true }),
    abortChat: async () => ({ ok: true }),
    // Main ends every run with a marker behind its events (#721).
    chat: async (messages, options) => {
      const result = await chatImpl(messages, options);
      progressCallback?.({ type: 'run-end', chatId: options?.chatId, runId: options?.runId });
      return result;
    },
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

test('a refused image read ends as a placeholder, not as a broken image', async () => {
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

  // A frame that was not cancelled would have run by now.
  await until(() => !appStore.chatInFlight, 'the settled run');
  await nextFrame();
  await nextFrame();
  await flush();

  const blase = letzteBlase();
  assert.equal(!!blase.querySelector('.chat-md-image--pending'), false,
    'der Zwischenstand darf nicht zurueckkommen');
  assert.equal(blase.querySelector('img')?.getAttribute('src'), PNG_DATA_URL);
});

test('no chat render path puts anything but a data: URI into an <img src> (#402)', async () => {
  // Assigned to a node of the document, an <img> fetches its `src` at once —
  // attached or not. So every image that ever shows up in the chat, and every
  // `src` it is given, is recorded here, across all render paths.
  const seen = [];
  const record = (img) => seen.push(img.getAttribute('src'));
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.target.tagName === 'IMG') record(m.target);
      for (const node of m.addedNodes || []) {
        if (node.nodeType !== 1) continue;
        if (node.tagName === 'IMG') record(node);
        for (const img of node.querySelectorAll?.('img') || []) record(img);
      }
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });
  try {
    const OUTSIDE = '![Outside](/tmp/outside/x.png)';
    readImpl = async () => ({ ok: false, reason: 'outsideWorkspace' });

    // A streaming answer restored from history, then a finished one.
    show(OUTSIDE, { streaming: true });
    await flush();
    show(OUTSIDE);
    await flush();

    // A live run: a streaming frame first, then the final answer.
    chatImpl = async (_messages, options) => {
      deltaCallback?.({ text: OUTSIDE, chatId: options?.chatId, runId: options?.runId });
      // Let the streaming frame draw before the answer settles.
      await nextFrame();
      await nextFrame();
      return { ok: true, content: OUTSIDE, toolTrace: [] };
    };
    appStore.chatMessages = [];
    appStore.chatSessionId = (appStore.chatSessionId || 0) + 1;
    const input = document.getElementById('chat-input');
    input.value = 'Show it.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
    await until(
      () => !appStore.chatInFlight && letzteBlase()?.querySelector('.chat-md-image--placeholder'),
      'the settled answer with its placeholder'
    );
  } finally {
    observer.disconnect();
  }

  const leaked = seen.filter((src) => src !== null && !src.startsWith('data:'));
  assert.deepEqual(leaked, [], 'an image address reached the document');
  assert.ok(asked.includes('/tmp/outside/x.png'), 'the main process was asked instead');
  assert.ok(letzteBlase().querySelector('.chat-md-image--placeholder'));
});
