// Tastaturbedienung und ARIA der beiden Panel-Trenner (Variante B, Issue-frei
// aus dem Splitter-Redesign).
//
// Die Optik des Griffs pruefen diese Tests nicht — das kann happy-dom nicht
// (kein Layout, keine Pseudo-Elemente). Geprueft wird die Verdrahtung: dass
// die Trenner ueberhaupt fokussierbar sind, dass die Pfeiltasten in die
// richtige Richtung wirken und dass die Breite erst nach Ruhe geschrieben wird.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

// The last test below holds these against SidebarResizer.js, styles.css and
// the settings contract (#637).
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 600;
const CHAT_MIN = 260;
const HISTORY_MIN = 180;
const CONTENT_MIN = 200;
const DIVIDER_PX = 1;

/**
 * happy-dom kennt kein Layout: getBoundingClientRect() liefert ueberall 0.
 * Fuer den Chat-Trenner haengt die Obergrenze aber an der Breite der
 * Bezugsflaeche — seit Epic #223 (Phase A) ist das #app —, deshalb wird sie
 * hier gesetzt; sonst faellt jeder Wert auf das Minimum und der Test prueft
 * nichts.
 */
function stubAppWidth(appRoot, width) {
  appRoot.getBoundingClientRect = () => ({
    width, height: 800, top: 0, bottom: 800, left: 0, right: width, x: 0, y: 0,
  });
}

async function mount({
  api = {},
  sidebarWidth = 280,
  chatPanelWidth = 320,
  chatHistoryWidth = 260,
  historyOpen = false,
  chatHidden = false,
  // The markup starts without the content pane; app.js opens it at startup.
  previewShown = false,
  sidebarHidden = false,
  appWidth = 1200,
} = {}) {
  const dom = setupRendererDom();
  // happy-dom never fires a ResizeObserver. This one is fired by hand, see
  // resizeWindow() below.
  const resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(callback) { resizeCallbacks.push(callback); }

    observe() {}

    disconnect() {}
  };
  const appRoot = dom.document.getElementById('app');
  stubAppWidth(appRoot, appWidth);
  // Die Verlaufsspalte startet im Markup weggeschaltet (Epic #223, Phase B).
  appRoot.classList.toggle('app--no-history', !historyOpen);
  // Die Chat-Spalte ist ebenso wegschaltbar; app.js setzt die Klasse beim Start.
  appRoot.classList.toggle('app--no-chat', chatHidden);
  appRoot.classList.toggle('app--no-preview', !previewShown);
  appRoot.classList.toggle('app--no-sidebar', sidebarHidden);

  const historyVisibility = [];
  const { initSidebarResizer } = await importRenderer('components', 'SidebarResizer.js');
  const resizer = initSidebarResizer({
    api,
    initialSidebarWidth: sidebarWidth,
    initialChatPanelWidth: chatPanelWidth,
    initialChatHistoryWidth: chatHistoryWidth,
    setHistoryVisible: (open) => {
      historyVisibility.push(open);
      appRoot.classList.toggle('app--no-history', !open);
    },
  });

  // The resizer lays the columns out on its own when it is built (#637) —
  // before, app.js had to call ensureRoomForWorkspace() right after.

  return {
    dom,
    resizer,
    appRoot,
    historyVisibility,
    /** The window changes width: what the ResizeObserver on #app reports. */
    resizeWindow(width) {
      stubAppWidth(appRoot, width);
      for (const callback of resizeCallbacks) callback([]);
    },
    divider: dom.document.getElementById('divider'),
    sidebar: dom.document.getElementById('sidebar'),
    chatDivider: dom.document.getElementById('chat-divider'),
    chatPanel: dom.document.getElementById('chat-panel'),
    historyDivider: dom.document.getElementById('history-divider'),
    chatHistory: dom.document.getElementById('chat-history'),
  };
}

function press(element, key, { shiftKey = false } = {}) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

const width = (element) => parseInt(element.style.width, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A column switch reaches the resizer through a MutationObserver on #app.
const tick = () => sleep(0);

function drag(dom, handle, clientX) {
  handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  if (clientX !== undefined) {
    dom.document.dispatchEvent(new MouseEvent('mousemove', { clientX, bubbles: true }));
  }
  dom.document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}

/**
 * What #637 is about: sidebar, chat and history leave the content pane its
 * minimum. happy-dom has no layout, so the sum runs over the inline widths —
 * the widths the resizer sets, and the ones the CSS renders as long as they
 * fit. Without the content pane the chat fills the rest and only needs the
 * width it is given.
 */
function assertContentKeepsItsMinimum(mounted, label) {
  const { appRoot } = mounted;
  const total = appRoot.getBoundingClientRect().width;
  const shown = (column) => !appRoot.classList.contains(`app--no-${column}`);
  // The 1 px dividers take their share too, the way styles.css shows them:
  // #chat-divider only beside the content pane.
  const dividers = [shown('sidebar'), shown('preview') && shown('chat'), shown('history')]
    .filter(Boolean).length * DIVIDER_PX;
  const used = (shown('sidebar') ? width(mounted.sidebar) : 0)
    + (shown('chat') ? width(mounted.chatPanel) : 0)
    + (shown('history') ? width(mounted.chatHistory) : 0)
    + dividers;
  const reserve = shown('preview') ? CONTENT_MIN : 0;
  assert.ok(
    used <= total - reserve,
    `${label}: the columns take ${used} of ${total} px, the content pane needs ${reserve}`,
  );
  // Nothing squeezes the sidebar below its inline width any more, so the
  // divider announces what is on screen.
  assert.equal(mounted.divider.getAttribute('aria-valuenow'), String(width(mounted.sidebar)), label);
}

test('alle Trenner sind als bedienbarer Separator ausgezeichnet', async () => {
  const { divider, chatDivider, historyDivider } = await mount();

  for (const [name, element] of [
    ['divider', divider],
    ['chat-divider', chatDivider],
    ['history-divider', historyDivider],
  ]) {
    assert.equal(element.getAttribute('role'), 'separator', name);
    assert.equal(element.getAttribute('aria-orientation'), 'vertical', name);
    assert.equal(element.getAttribute('tabindex'), '0', name);
    assert.ok(element.getAttribute('aria-label'), `${name} braucht ein aria-label`);
    assert.ok(element.classList.contains('pane-divider'), `${name} braucht .pane-divider`);
  }
});

test('Pfeiltasten verschieben den Sidebar-Trenner in Pfeilrichtung', async () => {
  const { divider, sidebar } = await mount({ sidebarWidth: 280 });

  press(divider, 'ArrowRight');
  assert.equal(width(sidebar), 296);

  press(divider, 'ArrowLeft');
  assert.equal(width(sidebar), 280);

  press(divider, 'ArrowRight', { shiftKey: true });
  assert.equal(width(sidebar), 344);

  press(divider, 'ArrowLeft', { shiftKey: true });
  assert.equal(width(sidebar), 280);
});

test('Home und End fahren den Sidebar-Trenner in die Endlagen', async () => {
  const { divider, sidebar } = await mount({ sidebarWidth: 280 });

  press(divider, 'Home');
  assert.equal(width(sidebar), SIDEBAR_MIN);

  press(divider, 'End');
  assert.equal(width(sidebar), SIDEBAR_MAX);

  // Ueber die Endlage hinaus passiert nichts mehr.
  press(divider, 'ArrowRight');
  assert.equal(width(sidebar), SIDEBAR_MAX);
});

test('der Chat waechst, wenn sein Trenner nach links wandert', async () => {
  const { chatDivider, chatPanel } = await mount({ chatPanelWidth: 320 });

  press(chatDivider, 'ArrowLeft');
  assert.equal(width(chatPanel), 336);

  press(chatDivider, 'ArrowRight');
  assert.equal(width(chatPanel), 320);

  // Workspace 1200 px → Obergrenze ist die halbe Breite.
  press(chatDivider, 'Home');
  assert.equal(width(chatPanel), 600);

  press(chatDivider, 'End');
  assert.equal(width(chatPanel), CHAT_MIN);
});

test('Tastenschritte melden die neue Breite an den Screenreader', async () => {
  const { divider, chatDivider } = await mount({ sidebarWidth: 280, chatPanelWidth: 320 });

  assert.equal(divider.getAttribute('aria-valuenow'), '280');
  assert.equal(divider.getAttribute('aria-valuemin'), String(SIDEBAR_MIN));
  assert.equal(divider.getAttribute('aria-valuemax'), String(SIDEBAR_MAX));

  press(divider, 'ArrowRight');
  assert.equal(divider.getAttribute('aria-valuenow'), '296');

  assert.equal(chatDivider.getAttribute('aria-valuenow'), '320');
  press(chatDivider, 'ArrowLeft');
  assert.equal(chatDivider.getAttribute('aria-valuenow'), '336');
});

test('andere Tasten laufen unveraendert durch', async () => {
  const { divider, sidebar } = await mount({ sidebarWidth: 280 });

  const event = press(divider, 'Tab');
  assert.equal(width(sidebar), 280);
  assert.equal(event.defaultPrevented, false);
});

test('Pfeiltasten verhindern das Scrollen der Seite', async () => {
  const { divider } = await mount();
  assert.equal(press(divider, 'ArrowRight').defaultPrevented, true);
  assert.equal(press(divider, 'Home').defaultPrevented, true);
});

test('gehaltene Taste schreibt erst, wenn sie zur Ruhe kommt', async () => {
  const calls = [];
  const { divider, sidebar } = await mount({
    api: { setUIPrefs: async (patch) => { calls.push(patch); } },
    sidebarWidth: 280,
  });

  for (let i = 0; i < 5; i += 1) press(divider, 'ArrowRight');
  assert.equal(width(sidebar), 360);
  assert.deepEqual(calls, [], 'waehrend der Wiederholung wird nichts geschrieben');

  await sleep(400);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sidebarWidth, 360);
});

test('der Griff wird nach einem Tastenschritt kurz hervorgehoben', async () => {
  const { divider } = await mount();

  press(divider, 'ArrowRight');
  assert.ok(divider.classList.contains('dragging'));

  await sleep(400);
  assert.equal(divider.classList.contains('dragging'), false);
});

// ── Verlaufsspalte (Epic #223, Phase B) ────────────────────────────────────

test('der Verlauf waechst, wenn sein Trenner nach links wandert', async () => {
  const { historyDivider, chatHistory } = await mount({ historyOpen: true, chatHistoryWidth: 260 });

  press(historyDivider, 'ArrowLeft');
  assert.equal(width(chatHistory), 276);

  press(historyDivider, 'ArrowRight');
  assert.equal(width(chatHistory), 260);

  press(historyDivider, 'End');
  assert.equal(width(chatHistory), HISTORY_MIN);
});

test('die Obergrenze des Chats laesst der Verlaufsspalte ihren Platz', async () => {
  // Ohne Verlauf reicht der Chat bis zur halben Fensterbreite (1200 / 2).
  const zu = await mount({ historyOpen: false });
  press(zu.chatDivider, 'Home');
  assert.equal(width(zu.chatPanel), 600);

  // Mit 260 px Verlauf bleibt fuer den Chat entsprechend weniger:
  // 1200 - 280 (Seitenleiste) - 260 = 660, gedeckelt auf die Haelfte.
  const offen = await mount({ historyOpen: true, chatHistoryWidth: 260 });
  press(offen.chatDivider, 'Home');
  assert.equal(width(offen.chatPanel), 600);

  // Eine breite Verlaufsspalte drueckt die Grenze unter die Haelfte —
  // 1200 - 280 - 500 and the two 1 px dividers beside sidebar and history (#637).
  const breit = await mount({ historyOpen: true, chatHistoryWidth: 500 });
  press(breit.chatDivider, 'Home');
  assert.equal(width(breit.chatPanel), 418);
});

test('wird es zu eng, klappt der Verlauf weg statt alles zu quetschen', async () => {
  const { historyVisibility, appRoot } = await mount({
    historyOpen: true,
    appWidth: 700,
    sidebarWidth: 280,
    chatPanelWidth: 260,
    chatHistoryWidth: 180,
  });

  assert.deepEqual(historyVisibility, [false], 'die Spalte muss von selbst weichen');
  assert.ok(appRoot.classList.contains('app--no-history'));
});

test('im breiteren Fenster kommt die weggeklappte Spalte zurueck', async () => {
  // Erst breit aufsetzen, damit die Spalte ihre gemerkten 260 px wirklich hat.
  const mounted = await mount({
    historyOpen: true,
    appWidth: 1400,
    sidebarWidth: 280,
    chatPanelWidth: 260,
    chatHistoryWidth: 260,
  });
  assert.deepEqual(mounted.historyVisibility, [], 'bei 1400 px ist noch Platz');
  assert.equal(width(mounted.chatHistory), 260);

  stubAppWidth(mounted.appRoot, 700);
  mounted.resizer.ensureRoomForWorkspace();
  assert.deepEqual(mounted.historyVisibility, [false]);

  stubAppWidth(mounted.appRoot, 1400);
  mounted.resizer.ensureRoomForWorkspace();
  assert.deepEqual(mounted.historyVisibility, [false, true]);
  assert.equal(width(mounted.chatHistory), 260, 'und zwar in ihrer alten Breite');
});

test('wer den Verlauf selbst zuklappt, findet ihn nicht von allein wieder', async () => {
  const mounted = await mount({ historyOpen: true, appWidth: 1400 });

  // So meldet sich der Verlauf, wenn der Nutzer den Knopf gedrueckt hat.
  mounted.appRoot.classList.add('app--no-history');
  mounted.resizer.handleHistoryVisibility({ persisted: true });
  mounted.resizer.ensureRoomForWorkspace();

  assert.deepEqual(mounted.historyVisibility, [], 'nichts darf von selbst aufklappen');
});

test('die weggeschaltete Chat-Spalte belegt keinen Platz und behaelt ihre Breite', async () => {
  // Ohne Chat bleibt von der rechten Haelfte nur der Verlauf. Seine Obergrenze
  // waechst entsprechend — und die gemerkte Chat-Breite darf dabei nicht auf
  // ihr Minimum zusammenfallen, sonst kaeme der Chat schmaler zurueck, als er
  // weggegangen ist.
  const mounted = await mount({
    historyOpen: true,
    chatHidden: true,
    appWidth: 900,
    sidebarWidth: 280,
    chatPanelWidth: 420,
    chatHistoryWidth: 260,
  });

  assert.equal(width(mounted.chatPanel), 420, 'die gemerkte Breite bleibt stehen');
  assert.deepEqual(mounted.historyVisibility, [], 'ohne Chat ist genug Platz');

  // Im Markup ist die Anzeige zu, dem Arbeitsbereich bleibt also die
  // Seitenleiste: 900 - 280 = 620. Wuerde der weggeschaltete Chat mitzaehlen,
  // blieben davon 200 und die Spalte fiele auf ihr Minimum von 180.
  // Home schiebt den Trenner nach links, die Spalte rechts davon wird breit.
  // Less the two 1 px dividers of sidebar and history (#637).
  press(mounted.historyDivider, 'Home');
  assert.equal(width(mounted.chatHistory), 618);
});

test('ohne Chat und ohne Anzeige bleibt der Verlauf neben der Seitenleiste stehen', async () => {
  const mounted = await mount({
    historyOpen: true,
    chatHidden: true,
    appWidth: 700,
    sidebarWidth: 280,
    chatHistoryWidth: 260,
  });
  mounted.appRoot.classList.add('app--no-preview');
  mounted.resizer.ensureRoomForWorkspace();

  assert.deepEqual(mounted.historyVisibility, [], 'nichts muss weichen');
});

test('beim Erststart bekommt die Spalte den Startschirm und der Chat den Rest', async () => {
  // Issue #258: Ohne Ordner steht in der mittleren Spalte der Startschirm, und
  // der ist 560 + 2 x 32 = 624 px breit. Alles darueber waere Leerraum —
  // deshalb geht der Rest an den Chat.
  const mounted = await mount({
    appWidth: 1536,
    sidebarWidth: 260,
    chatPanelWidth: undefined,
  });
  mounted.appRoot.classList.remove('app--no-preview');

  // The dividers beside sidebar and chat take a pixel each, so the column
  // still holds the whole welcome screen (#637).
  assert.equal(mounted.resizer.fitChatToWelcome(), 1536 - 260 - 624 - 2 * DIVIDER_PX);
  assert.equal(width(mounted.chatPanel), 650);

  // Ist die Seitenleiste weggeschaltet, belegt sie nichts — der Chat bekommt
  // ihre Breite dazu, statt sie an Leerraum neben dem Startschirm zu verlieren.
  mounted.appRoot.classList.add('app--no-sidebar');
  assert.equal(mounted.resizer.fitChatToWelcome(), 1536 * 0.5, 'gedeckelt bei der Haelfte');
});

test('im schmalen Fenster deckelt die halbe Breite den Chat', async () => {
  // 900 - 260 - 624 = 16 px blieben dem Chat — das unterschreitet sein
  // Minimum. Dann ist die Spalte eben schmaler als der Startschirm gern haette.
  const mounted = await mount({
    appWidth: 900,
    sidebarWidth: 260,
    chatPanelWidth: undefined,
  });
  mounted.appRoot.classList.remove('app--no-preview');

  assert.equal(mounted.resizer.fitChatToWelcome(), CHAT_MIN);
});

test('ohne Anzeige oder ohne Chat gibt es nichts einzurichten', async () => {
  // Die Anzeige ist im Markup zu — dann fuellt der Chat ohnehin alles.
  const zu = await mount({ appWidth: 1536, chatPanelWidth: undefined });
  assert.equal(zu.resizer.fitChatToWelcome(), null);

  const ohneChat = await mount({ appWidth: 1536, chatHidden: true, chatPanelWidth: undefined });
  ohneChat.appRoot.classList.remove('app--no-preview');
  assert.equal(ohneChat.resizer.fitChatToWelcome(), null);
});

// ── The workspace keeps its minimum after every change (#637) ──────────────

// The window from the finding: 1,000 px, content pane and history open.
const NARROW = {
  appWidth: 1000,
  previewShown: true,
  historyOpen: true,
  sidebarWidth: 280,
  chatPanelWidth: 320,
  chatHistoryWidth: 200,
};

test('End and Home on the sidebar divider leave the content pane its minimum (#637)', async () => {
  const mounted = await mount(NARROW);
  assertContentKeepsItsMinimum(mounted, 'at the start');

  // Before, End set 600 px and left the content pane -120 px. The chat gives
  // way, the history folds away, and the sidebar stops where a chat at its
  // minimum still fits: 1000 - 200 - 260 and the dividers of sidebar and chat.
  press(mounted.divider, 'End');
  assertContentKeepsItsMinimum(mounted, 'after End');
  assert.equal(width(mounted.sidebar), 538);
  assert.equal(mounted.divider.getAttribute('aria-valuemax'), '538');
  assert.deepEqual(mounted.historyVisibility, [false]);

  // The room comes back, and so does the history that only left for want of it.
  press(mounted.divider, 'Home');
  assertContentKeepsItsMinimum(mounted, 'after Home');
  assert.equal(width(mounted.sidebar), SIDEBAR_MIN);
  assert.deepEqual(mounted.historyVisibility, [false, true]);
  assert.equal(width(mounted.chatHistory), 200);
});

test('dragging the sidebar divider leaves the content pane its minimum (#637)', async () => {
  const mounted = await mount(NARROW);
  drag(mounted.dom, mounted.divider, 900);
  assertContentKeepsItsMinimum(mounted, 'after the drag');
  assert.equal(width(mounted.sidebar), 538);
});

test('showing the sidebar makes room for it (#637)', async () => {
  const mounted = await mount({ ...NARROW, sidebarHidden: true, sidebarWidth: 520, chatHistoryWidth: 260 });
  assertContentKeepsItsMinimum(mounted, 'sidebar hidden');

  // This is all app.js does when the sidebar comes back.
  mounted.appRoot.classList.remove('app--no-sidebar');
  await tick();
  assertContentKeepsItsMinimum(mounted, 'sidebar shown');
  assert.equal(width(mounted.sidebar), 520, 'the sidebar comes back at its width');
});

test('showing the content pane makes room for it, at startup as well (#637)', async () => {
  // index.html starts without the content pane; app.js opens it once the
  // folder is known. Before, it then got 1000 - 280 - 320 - 260 = 140 px.
  const mounted = await mount({ ...NARROW, previewShown: false, chatHistoryWidth: 260 });
  assertContentKeepsItsMinimum(mounted, 'content pane hidden');
  mounted.appRoot.classList.remove('app--no-preview');
  await tick();
  assertContentKeepsItsMinimum(mounted, 'content pane shown');

  // The first start without a folder fits the chat to the welcome screen right
  // after opening the column, before the observer has run.
  const firstStart = await mount({ ...NARROW, previewShown: false, chatPanelWidth: null });
  firstStart.appRoot.classList.remove('app--no-preview');
  firstStart.resizer.fitChatToWelcome();
  assertContentKeepsItsMinimum(firstStart, 'welcome screen');
  await tick();
  assertContentKeepsItsMinimum(firstStart, 'welcome screen, after the observer');
});

test('a window that shrinks without the content pane still makes room (#637)', async () => {
  const mounted = await mount({ appWidth: 1200, historyOpen: true, chatHistoryWidth: 400 });
  mounted.resizeWindow(900);
  assertContentKeepsItsMinimum(mounted, 'content pane hidden');

  mounted.appRoot.classList.remove('app--no-preview');
  await tick();
  assertContentKeepsItsMinimum(mounted, 'content pane shown again');
});

test('a window that shrinks without the chat still makes room (#637)', async () => {
  const mounted = await mount({
    appWidth: 1200,
    previewShown: true,
    chatHidden: true,
    historyOpen: true,
    chatHistoryWidth: 600,
  });
  assert.equal(width(mounted.chatHistory), 600);
  mounted.resizeWindow(900);
  assertContentKeepsItsMinimum(mounted, 'chat hidden');
  // Without the chat its divider is gone; those of sidebar and history stay.
  assert.equal(width(mounted.chatHistory), 900 - 280 - CONTENT_MIN - 2 * DIVIDER_PX);
});

// ── Only what a gesture changed is written (#637) ──────────────────────────

test('a squeezed history grows back in a wider window (#637)', async () => {
  const mounted = await mount({ ...NARROW, chatHistoryWidth: 400 });
  const squeezed = width(mounted.chatHistory);
  assert.ok(squeezed < 400, `at 1,000 px the history has to give way (${squeezed} px)`);

  mounted.resizeWindow(1400);
  assert.equal(width(mounted.chatHistory), 400, 'back at its remembered width');
  assertContentKeepsItsMinimum(mounted, 'wider window');

  // And the same way back: the squeeze depends on the room, not on the path.
  mounted.resizeWindow(1000);
  assert.equal(width(mounted.chatHistory), squeezed);
  mounted.resizeWindow(1400);
  assert.equal(width(mounted.chatHistory), 400);
});

test('a squeeze followed by a step on another divider writes only that step (#637)', async () => {
  const calls = [];
  const mounted = await mount({
    ...NARROW,
    api: { setUIPrefs: async (patch) => { calls.push(patch); } },
    chatHistoryWidth: 400,
  });
  assert.ok(width(mounted.chatHistory) < 400, 'the history is squeezed');

  // Before: {"sidebarWidth":296,"chatPanelWidth":320,"chatHistoryWidth":200}.
  press(mounted.divider, 'ArrowRight');
  await sleep(400);
  assert.deepEqual(calls, [{ sidebarWidth: 296 }]);
});

test('a click on a divider without movement writes nothing (#637)', async () => {
  const calls = [];
  const mounted = await mount({
    api: { setUIPrefs: async (patch) => { calls.push(patch); } },
    previewShown: true,
    historyOpen: true,
  });
  drag(mounted.dom, mounted.divider);
  drag(mounted.dom, mounted.chatDivider);
  drag(mounted.dom, mounted.historyDivider);
  // A Home at the end position moves nothing either.
  press(mounted.divider, 'Home');
  press(mounted.divider, 'Home');
  await sleep(400);
  assert.deepEqual(calls, [{ sidebarWidth: SIDEBAR_MIN }], 'only the one Home that moved');
});

test('a drag writes the column it moved and nothing else (#637)', async () => {
  const calls = [];
  const mounted = await mount({
    api: { setUIPrefs: async (patch) => { calls.push(patch); } },
    previewShown: true,
  });
  // 1200 - 800: the chat divider sits at the left edge of the chat.
  drag(mounted.dom, mounted.chatDivider, 800);
  await sleep(0);
  assert.deepEqual(calls, [{ chatPanelWidth: 400 }]);
});

test('the chat the startup fitted to the welcome screen is not written later (#637)', async () => {
  const calls = [];
  const mounted = await mount({
    api: { setUIPrefs: async (patch) => { calls.push(patch); } },
    appWidth: 1536,
    previewShown: true,
    sidebarWidth: 260,
    // Nothing remembered (`undefined` would take mount's default).
    chatPanelWidth: null,
  });
  assert.equal(mounted.resizer.fitChatToWelcome(), 650);

  // The window grows, the chat takes its half — but it is still a layout.
  mounted.resizeWindow(1636);
  assert.equal(width(mounted.chatPanel), 700);
  press(mounted.divider, 'ArrowRight');
  await sleep(400);
  assert.deepEqual(calls, [{ sidebarWidth: 276 }]);
});

test('a remembered chat width moves with the window and is written alone (#637)', async () => {
  const calls = [];
  const mounted = await mount({
    api: { setUIPrefs: async (patch) => { calls.push(patch); } },
    previewShown: true,
    historyOpen: true,
    chatPanelWidth: 400,
  });
  mounted.resizeWindow(1400);
  assert.equal(width(mounted.chatPanel), 500, 'half of the growth');
  await sleep(400);
  assert.deepEqual(calls, [{ chatPanelWidth: 500 }]);

  mounted.resizeWindow(1200);
  assert.equal(width(mounted.chatPanel), 400, 'and back where it was');
});

// ── One minimum per column (#637) ──────────────────────────────────────────

test('SidebarResizer.js, styles.css and the settings contract agree on the column widths (#637)', () => {
  const read = (...segments) => fs.readFileSync(path.join(__dirname, '..', ...segments), 'utf8');
  const css = read('src', 'renderer', 'styles.css');
  const resizer = read('src', 'renderer', 'components', 'SidebarResizer.js');
  const contract = require('../src/shared/contracts/settings.js');

  const rule = (selector) => {
    const block = css.match(new RegExp(`^${selector} \\{([^}]*)\\}`, 'm'))?.[1];
    assert.ok(block, `styles.css needs a ${selector} rule`);
    const px = (property) => Number(block.match(new RegExp(`\\s${property}:\\s*(\\d+)px`))?.[1]);
    return { width: px('width'), minWidth: px('min-width') };
  };
  const js = (name) => {
    const value = resizer.match(new RegExp(`^const ${name} = (\\d+);`, 'm'))?.[1];
    assert.ok(value, `SidebarResizer.js needs ${name}`);
    return Number(value);
  };

  // Before, the sidebar said 150 in JS and in the contract and 180 in the CSS:
  // Home announced 150 and 180 rendered.
  const sidebar = rule('#sidebar');
  assert.equal(js('SIDEBAR_MIN'), sidebar.minWidth, 'sidebar minimum: JS and CSS');
  assert.equal(contract.SIDEBAR_WIDTH_MIN, sidebar.minWidth, 'sidebar minimum: contract and CSS');
  assert.equal(js('SIDEBAR_MAX'), contract.SIDEBAR_WIDTH_MAX, 'sidebar maximum');
  assert.equal(js('SIDEBAR_DEFAULT'), sidebar.width, 'sidebar default width');

  const chat = rule('#chat-panel');
  assert.equal(js('CHAT_MIN'), chat.minWidth, 'chat minimum: JS and CSS');
  assert.equal(contract.CHAT_PANEL_WIDTH_MIN, chat.minWidth, 'chat minimum: contract and CSS');
  assert.equal(js('CHAT_DEFAULT'), chat.width, 'chat default width');

  const history = rule('#chat-history');
  assert.equal(js('HISTORY_MIN'), history.minWidth, 'history minimum: JS and CSS');
  assert.equal(contract.CHAT_HISTORY_WIDTH_MIN, history.minWidth, 'history minimum: contract and CSS');
  assert.equal(js('HISTORY_MAX'), contract.CHAT_HISTORY_WIDTH_MAX, 'history maximum');
  assert.equal(js('HISTORY_DEFAULT'), history.width, 'history default width');

  assert.equal(js('DIVIDER_PX'), rule('\\.pane-divider').width, 'divider width');

  // The tests above count with the same numbers.
  assert.equal(SIDEBAR_MIN, js('SIDEBAR_MIN'));
  assert.equal(SIDEBAR_MAX, js('SIDEBAR_MAX'));
  assert.equal(CHAT_MIN, js('CHAT_MIN'));
  assert.equal(HISTORY_MIN, js('HISTORY_MIN'));
  assert.equal(CONTENT_MIN, js('CONTENT_MIN'));
  assert.equal(DIVIDER_PX, js('DIVIDER_PX'));
});

test('the dividers come out of the room, not out of the content pane (#637)', async () => {
  // The finding's window with all three dividers on screen. Uncounted, they
  // left the content pane 197 px: 1000 - 280 - 260 - 260 - 3.
  const mounted = await mount({ ...NARROW, chatHistoryWidth: 260 });
  const rest = 1000 - width(mounted.sidebar) - width(mounted.chatPanel)
    - width(mounted.chatHistory) - 3 * DIVIDER_PX;
  assert.equal(rest, CONTENT_MIN, 'the content pane keeps exactly its minimum');

  // Folded away for End, the history takes its divider with it; the chat's
  // and the sidebar's stay.
  press(mounted.divider, 'End');
  assert.equal(
    1000 - width(mounted.sidebar) - width(mounted.chatPanel) - 2 * DIVIDER_PX,
    CONTENT_MIN,
  );
});
