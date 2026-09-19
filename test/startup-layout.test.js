// Startzustand von Fenster und mittlerer Spalte (Issue #208).
//
// Zwei Entscheidungen, die man sonst nur per Augenschein pruefen koennte:
// wie gross das Fenster aufgeht und ob die mittlere Spalte beim Start offen
// ist. Beide liegen als reine Funktionen vor, dazu eine Klammer um das
// Markup — der erste Bildaufbau kommt aus der index.html, nicht aus dem Code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  fitToWorkArea,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
} = require('../src/main/window.js');

const startupLayoutPromise = import(
  pathToFileURL(
    path.join(__dirname, '..', 'src', 'renderer', 'utils', 'startupLayout.js')
  ).href
);

test('die Startgroesse liegt 20 % ueber den frueheren 1280 x 800', () => {
  assert.equal(DEFAULT_WINDOW_WIDTH, Math.round(1280 * 1.2));
  assert.equal(DEFAULT_WINDOW_HEIGHT, Math.round(800 * 1.2));
});

test('auf einem grossen Bildschirm bleibt es beim Wunschmass', () => {
  assert.deepEqual(fitToWorkArea({ width: 2560, height: 1440 }), {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
  });
});

test('auf einem kleinen Bildschirm bleibt das Fenster in der Arbeitsflaeche', () => {
  // 13-Zoll-Notebook: 960 px waeren hoeher als der sichtbare Bereich.
  assert.deepEqual(fitToWorkArea({ width: 1440, height: 875 }), {
    width: 1440,
    height: 875,
  });
});

test('ohne brauchbare Bildschirmangabe gilt das Wunschmass', () => {
  const expected = { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  assert.deepEqual(fitToWorkArea(null), expected);
  assert.deepEqual(fitToWorkArea({ width: 0, height: -1 }), expected);
  assert.deepEqual(fitToWorkArea({ width: 'breit', height: NaN }), expected);
});

test('ein wiederhergestellter Chat laesst die mittlere Spalte zu', async () => {
  const { contentPaneVisibleOnStart } = await startupLayoutPromise;
  assert.equal(
    contentPaneVisibleOnStart({ preference: true, chatRestored: true }),
    false,
    'wer im Chat aufgehoert hat, soll dort weitermachen — nicht am Startschirm'
  );
});

test('ohne Chat erscheint der Startschirm wie bisher', async () => {
  const { contentPaneVisibleOnStart } = await startupLayoutPromise;
  assert.equal(contentPaneVisibleOnStart({ preference: true, chatRestored: false }), true);
  // Kein Ladeergebnis (Fehler beim Start) zaehlt nicht als Chat.
  assert.equal(contentPaneVisibleOnStart({ preference: true, chatRestored: undefined }), true);
});

test('die weggeschaltete Spalte bleibt weggeschaltet', async () => {
  const { contentPaneVisibleOnStart } = await startupLayoutPromise;
  assert.equal(contentPaneVisibleOnStart({ preference: false, chatRestored: false }), false);
  assert.equal(contentPaneVisibleOnStart({ preference: false, chatRestored: true }), false);
});

test('das Markup startet mit eingeklappter Spalte', () => {
  // Der erste Bildaufbau passiert, bevor app.js laeuft. Stuende hier die
  // offene Spalte, blitzte der Startschirm neben einem wiederhergestellten
  // Chat auf und spraenge gleich wieder weg.
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8'
  );
  const workspace = html.match(/<div id="workspace"[^>]*>/);
  assert.ok(workspace, '#workspace muss es geben');
  assert.match(workspace[0], /class="[^"]*workspace--no-preview/);
  const toggle = html.match(/<button[^>]*id="btn-toggle-content-pane"[^>]*>/);
  assert.ok(toggle, 'der Umschalter muss es geben');
  assert.match(
    toggle[0],
    /aria-pressed="false"/,
    'der Umschalter muss denselben Zustand melden wie das Layout'
  );
});
