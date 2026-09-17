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

/**
 * happy-dom kennt kein Layout: getBoundingClientRect() liefert ueberall 0.
 * Fuer den Chat-Trenner haengt die Obergrenze aber an der Breite des
 * Workspace, deshalb wird sie hier gesetzt — sonst faellt jeder Wert auf das
 * Minimum und der Test prueft nichts.
 */
function stubWorkspaceWidth(workspace, width) {
  workspace.getBoundingClientRect = () => ({
    width, height: 800, top: 0, bottom: 800, left: 0, right: width, x: 0, y: 0,
  });
}

async function mount({ api = {}, sidebarWidth = 280, chatPanelWidth = 320 } = {}) {
  const dom = setupRendererDom();
  const workspace = dom.document.getElementById('workspace');
  stubWorkspaceWidth(workspace, 1200);

  const { initSidebarResizer } = await importRenderer('components', 'SidebarResizer.js');
  initSidebarResizer({
    api,
    initialSidebarWidth: sidebarWidth,
    initialChatPanelWidth: chatPanelWidth,
  });

  return {
    dom,
    divider: dom.document.getElementById('divider'),
    sidebar: dom.document.getElementById('sidebar'),
    chatDivider: dom.document.getElementById('chat-divider'),
    chatPanel: dom.document.getElementById('chat-panel'),
  };
}

function press(element, key, { shiftKey = false } = {}) {
  const event = new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

const width = (element) => parseInt(element.style.width, 10);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('beide Trenner sind als bedienbarer Separator ausgezeichnet', async () => {
  const { divider, chatDivider } = await mount();

  for (const [name, element] of [['divider', divider], ['chat-divider', chatDivider]]) {
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
