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

test('wer die Spalte eingeblendet hat, bekommt sie ohne Chat wieder', async () => {
  const { contentPaneVisibleOnStart } = await startupLayoutPromise;
  assert.equal(contentPaneVisibleOnStart({ preference: true, chatRestored: false }), true);
  // Kein Ladeergebnis (Fehler beim Start) zaehlt nicht als Chat.
  assert.equal(contentPaneVisibleOnStart({ preference: true, chatRestored: undefined }), true);
});

test('ohne gespeicherten Wunsch bleibt die Spalte zu', async () => {
  // Issue #255: Die frische Installation startet mit Baum und Chat. Fehlt die
  // Praeferenz, ist das keine stille Zustimmung zur Spalte.
  const { contentPaneVisibleOnStart } = await startupLayoutPromise;
  assert.equal(contentPaneVisibleOnStart({ preference: undefined, chatRestored: false }), false);
  assert.equal(contentPaneVisibleOnStart({ chatRestored: undefined }), false);
  assert.equal(contentPaneVisibleOnStart({ preference: undefined, chatRestored: true }), false);
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
  // Die Verlaufsspalte ebenso (Epic #223, Phase B): Sie soll niemandem beim
  // Start ungefragt eine Spalte wegnehmen.
  assert.match(appRoot[0], /class="[^"]*app--no-history/);
  const toggle = html.match(/<button[^>]*id="btn-toggle-content-pane"[^>]*>/);
  assert.ok(toggle, 'der Umschalter muss es geben');
  assert.match(
    toggle[0],
    /aria-pressed="false"/,
    'der Umschalter muss denselben Zustand melden wie das Layout'
  );
  // Die Chat-Spalte ist die einzige der vier, die offen startet.
  assert.doesNotMatch(appRoot[0], /class="[^"]*app--no-chat/);
});

test('die vier Spalten-Schalter stehen in der Titelzeile und melden ihren Zustand', () => {
  // Gespiegeltes Paar rechts: derselbe Mechanismus wie links, nur fuer Chat
  // und Verlauf. Faellt einer aus dem Markup, faellt hier der Test und nicht
  // erst die Verdrahtung in app.js bzw. ChatHistoryPanel.js.
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'index.html'),
    'utf8'
  );
  const titlebar = html.slice(html.indexOf('<header id="titlebar"'), html.indexOf('</header>'));
  const pressed = (id) => {
    const btn = titlebar.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    assert.ok(btn, `${id} muss in der Titelzeile stehen`);
    const state = btn[0].match(/aria-pressed="(true|false)"/);
    assert.ok(state, `${id} muss seinen Zustand melden`);
    return state[1];
  };
  assert.equal(pressed('btn-toggle-sidebar'), 'true');
  assert.equal(pressed('btn-toggle-content-pane'), 'false');
  assert.equal(pressed('btn-toggle-chat-panel'), 'true');
  assert.equal(pressed('btn-toggle-chat-history'), 'false');

  // Der Verlaufs-Schalter sass bis 1.7.1 in der Kopfzeile des Chats; dort darf
  // er nicht zusaetzlich stehen, sonst gibt es zwei Knoepfe fuer eine Spalte.
  assert.equal(
    html.match(/id="btn-toggle-chat-history"/g)?.length,
    1,
    'den Verlaufs-Schalter gibt es genau einmal'
  );
  assert.doesNotMatch(html, /id="btn-chat-history"/);
  assert.doesNotMatch(html, /id="btn-chat-history-close"/);

  // Der Knopf fuer einen neuen Chat steht in der Verlaufsspalte — so wie
  // "Ordner oeffnen" in der Kopfzeile des Baums.
  const historyHeader = html.slice(
    html.indexOf('<div id="chat-history-header">'),
    html.indexOf('id="chat-history-empty"')
  );
  assert.match(historyHeader, /id="btn-chat-new"/);
});
