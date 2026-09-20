// Startzustand der mittleren Spalte (Issue #208).
//
// Ob beim Start der Startschirm neben dem Chat steht, koennte man sonst nur per
// Augenschein pruefen. Die Entscheidung liegt deshalb als reine Funktion vor,
// dazu eine Klammer um das Markup — der erste Bildaufbau kommt aus der
// index.html, nicht aus dem Code. Die Fenstergroesse prueft
// test/window-state.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const startupLayoutPromise = import(
  pathToFileURL(
    path.join(__dirname, '..', 'src', 'renderer', 'utils', 'startupLayout.js')
  ).href
);

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
  // Der Zustand haengt seit Epic #223 (Phase A) an #app: Arbeitsbereich und
  // Chat sind dort Geschwister, und beide Wegschalt-Klassen sitzen am selben
  // Container.
  const appRoot = html.match(/<main id="app"[^>]*>/);
  assert.ok(appRoot, '#app muss es geben');
  assert.match(appRoot[0], /class="[^"]*app--no-preview/);
  const toggle = html.match(/<button[^>]*id="btn-toggle-content-pane"[^>]*>/);
  assert.ok(toggle, 'der Umschalter muss es geben');
  assert.match(
    toggle[0],
    /aria-pressed="false"/,
    'der Umschalter muss denselben Zustand melden wie das Layout'
  );
});
