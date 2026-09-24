// Startzustand der mittleren Spalte (Issues #208, #255, #258).
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
    contentPaneVisibleOnStart({ preference: true, chatRestored: true, hasFolder: true }),
    false,
    'wer im Chat aufgehoert hat, soll dort weitermachen — nicht am Startschirm'
  );
  // Auch ohne Ordner: Ein Gespraech schlaegt den Startschirm (#258).
  assert.equal(
    contentPaneVisibleOnStart({ chatRestored: true, hasFolder: false }),
    false
  );
});

test('wer die Spalte eingeblendet hat, bekommt sie ohne Chat wieder', async () => {
  const { contentPaneVisibleOnStart } = await startupLayoutPromise;
  assert.equal(
    contentPaneVisibleOnStart({ preference: true, chatRestored: false, hasFolder: true }),
    true
  );
  // Kein Ladeergebnis (Fehler beim Start) zaehlt nicht als Chat.
  assert.equal(
    contentPaneVisibleOnStart({ preference: true, chatRestored: undefined, hasFolder: true }),
    true
  );
});

test('die weggeschaltete Spalte bleibt weggeschaltet', async () => {
  const { contentPaneVisibleOnStart } = await startupLayoutPromise;
  assert.equal(
    contentPaneVisibleOnStart({ preference: false, chatRestored: false, hasFolder: true }),
    false
  );
  assert.equal(
    contentPaneVisibleOnStart({ preference: false, chatRestored: true, hasFolder: true }),
    false
  );
  // Ausdruecklich weggeschaltet heisst auch ohne Ordner weggeschaltet (#258) —
  // sonst kaeme der Startschirm gegen den Willen des Nutzers zurueck.
  assert.equal(
    contentPaneVisibleOnStart({ preference: false, chatRestored: false, hasFolder: false }),
    false
  );
});

test('ohne gespeicherten Wunsch entscheidet der Ordner', async () => {
  // Issue #255: Mit Ordner bleibt die Spalte zu — zu sehen gaebe es nur den
  // Startschirm. Issue #258: Ohne Ordner ist genau er das Richtige.
  const { contentPaneVisibleOnStart } = await startupLayoutPromise;
  assert.equal(
    contentPaneVisibleOnStart({ preference: undefined, chatRestored: false, hasFolder: true }),
    false
  );
  assert.equal(
    contentPaneVisibleOnStart({ preference: undefined, chatRestored: false, hasFolder: false }),
    true
  );
  // Gar keine Angabe (Fehler beim Lesen der Prefs) faellt auf denselben Weg.
  assert.equal(contentPaneVisibleOnStart({}), true);
});

test('die Breite des Startschirms steht im CSS und im Resizer gleich', () => {
  // Der Resizer rechnet mit 560 + 2 x 32 px, damit die Spalte beim Erststart
  // genau den Startschirm fasst (#258). Waechst `#welcome` im CSS, muss die
  // Zahl mitwachsen — sonst bleibt ein Streifen Leerraum stehen oder der Text
  // wird umgebrochen.
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'styles.css'),
    'utf8'
  );
  const welcome = css.slice(css.indexOf('#welcome {'), css.indexOf('.welcome-eyebrow'));
  const maxWidth = Number(welcome.match(/max-width:\s*(\d+)px/)?.[1]);
  const padding = Number(welcome.match(/padding:\s*\d+px\s+(\d+)px/)?.[1]);
  assert.equal(maxWidth, 560, 'Inhaltsbreite des Startschirms');
  assert.equal(padding, 32, 'seitliche Polsterung des Startschirms');

  const resizer = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'renderer', 'components', 'SidebarResizer.js'),
    'utf8'
  );
  const formel = resizer.match(/const CONTENT_WELCOME = (.+);/)?.[1];
  assert.ok(formel, 'CONTENT_WELCOME muss es geben');
  // eslint-disable-next-line no-new-func
  assert.equal(Function(`return ${formel}`)(), maxWidth + 2 * padding);
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
  // Since #318 the button says what it does instead of showing a bare plus.
  // The visible label is its accessible name, so no aria-label to drift from it.
  const newChatButton = historyHeader.slice(
    historyHeader.indexOf('id="btn-chat-new"'),
    historyHeader.indexOf('</button>')
  );
  assert.match(newChatButton, /class="btn-chat-new-label" data-i18n="history\.new"/);
  assert.doesNotMatch(newChatButton, /aria-label=/);
});
