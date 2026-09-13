const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

/**
 * Issue #131: Beim Betreten eines Ordners soll die Konversation erscheinen, die
 * dort zuletzt gefuehrt wurde. Es gibt keinen DOM-Test-Stack (#78), deshalb
 * exportiert ChatStream.js die Auswahl DOM-frei.
 */
const chatStreamPromise = import(
  pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'components', 'ChatStream.js')).href
);

function session(id, updatedAt, extra = {}) {
  return { id, updatedAt, title: `Chat ${id}`, messages: [{ role: 'user', content: id }], ...extra };
}

test('die gemerkte aktive Konversation hat Vorrang', async () => {
  const { pickSessionToRestore } = await chatStreamPromise;
  const sessions = [session('alt', 1000), session('neu', 5000)];
  const { session: picked, wasActive } = pickSessionToRestore(sessions, 'alt');
  assert.equal(picked.id, 'alt');
  assert.equal(wasActive, true, 'der Zeiger stand schon richtig, er muss nicht neu gesetzt werden');
});

test('ohne aktive ID kommt die zuletzt gefuehrte Konversation zurueck', async () => {
  const { pickSessionToRestore } = await chatStreamPromise;
  const sessions = [session('alt', 1000), session('neu', 5000), session('mittel', 3000)];
  const { session: picked, wasActive } = pickSessionToRestore(sessions, null);
  assert.equal(picked.id, 'neu');
  assert.equal(wasActive, false, 'die Wahl muss als neuer aktiver Chat gemerkt werden');
});

test('eine ins Leere zeigende aktive ID faellt auf die juengste Konversation zurueck', async () => {
  const { pickSessionToRestore } = await chatStreamPromise;
  // Der aktive Chat wurde geloescht oder weggeraeumt (MAX_CHAT_SESSIONS).
  const sessions = [session('alt', 1000), session('neu', 5000)];
  const { session: picked, wasActive } = pickSessionToRestore(sessions, 'weg');
  assert.equal(picked.id, 'neu');
  assert.equal(wasActive, false);
});

test('ein Ordner ohne brauchbare Konversation startet leer', async () => {
  const { pickSessionToRestore } = await chatStreamPromise;
  assert.deepEqual(pickSessionToRestore([], null), { session: null, wasActive: false });
  assert.deepEqual(pickSessionToRestore(undefined, 'a'), { session: null, wasActive: false });
  // Sessions ohne Nachrichten waeren ein leerer Chat — die zaehlen nicht.
  const leer = [{ id: 'a', updatedAt: 9000, messages: [] }, { id: 'b', updatedAt: 8000 }];
  assert.deepEqual(pickSessionToRestore(leer, 'a'), { session: null, wasActive: false });
});

test('fehlende Zeitstempel verdraengen keine echte Konversation', async () => {
  const { pickSessionToRestore } = await chatStreamPromise;
  const sessions = [session('ohne-datum', undefined), session('mit-datum', 42)];
  assert.equal(pickSessionToRestore(sessions, null).session.id, 'mit-datum');
});
