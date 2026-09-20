// Tastaturbedienung und ARIA der beiden Panel-Trenner (Variante B, Issue-frei
// aus dem Splitter-Redesign).
//
// Die Optik des Griffs pruefen diese Tests nicht — das kann happy-dom nicht
// (kein Layout, keine Pseudo-Elemente). Geprueft wird die Verdrahtung: dass
// die Trenner ueberhaupt fokussierbar sind, dass die Pfeiltasten in die
// richtige Richtung wirken und dass die Breite erst nach Ruhe geschrieben wird.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 600;
const CHAT_MIN = 260;
const HISTORY_MIN = 180;

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
  appWidth = 1200,
} = {}) {
  const dom = setupRendererDom();
  const appRoot = dom.document.getElementById('app');
  stubAppWidth(appRoot, appWidth);
  // Die Verlaufsspalte startet im Markup weggeschaltet (Epic #223, Phase B).
  appRoot.classList.toggle('app--no-history', !historyOpen);
  // Die Chat-Spalte ist ebenso wegschaltbar; app.js setzt die Klasse beim Start.
  appRoot.classList.toggle('app--no-chat', chatHidden);

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

  // app.js raeumt direkt nach dem Aufbau einmal auf; ohne das stuende die
  // Verlaufsspalte im zu schmalen Fenster bis zur ersten Fensteraenderung da.
  resizer.ensureRoomForWorkspace();

  return {
    dom,
    resizer,
    appRoot,
    historyVisibility,
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

  // Eine breite Verlaufsspalte drueckt die Grenze unter die Haelfte.
  const breit = await mount({ historyOpen: true, chatHistoryWidth: 500 });
  press(breit.chatDivider, 'Home');
  assert.equal(width(breit.chatPanel), 420);
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
  press(mounted.historyDivider, 'Home');
  assert.equal(width(mounted.chatHistory), 620);
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
