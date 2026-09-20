// Bilder aus dem Arbeitsordner am echten DOM (Issue #244).
//
// Geprueft wird die Verdrahtung: welches `src` ueberhaupt ueber IPC geht, was
// aus einem abgelehnten Ergebnis wird, dass waehrend des Streams nichts laedt
// und dass ein zweites Rendern desselben Verlaufs ohne IPC auskommt.
//
// Ob ein data:-URI am Ende wirklich Pixel ergibt, kann dieser Stack nicht
// sagen — happy-dom rendert keine Bilder. Das prueft `e2e/smoke.test.mjs` in
// der laufenden App ueber `naturalWidth`. Zu den weiteren Grenzen siehe
// test/helpers/dom.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');
const { WORKSPACE_IMAGE_ERRORS } = require('../src/shared/contracts/workspace-image');

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_1PX}`;

let dom = null;
let images = null;

/** Antwort des Main-Prozesses, pro Test austauschbar. */
let readImpl = async () => ({ ok: true, mime: 'image/png', base64: PNG_1PX, mtimeMs: 1, size: 70 });
const asked = [];

const api = {
  readWorkspaceImage: async (imagePath) => {
    asked.push(imagePath);
    return readImpl(imagePath);
  },
};

test.before(async () => {
  dom = setupRendererDom();
  images = await importRenderer('chat', 'workspaceImages.js');
});

test.after(() => dom?.cleanup());

test.beforeEach(() => {
  asked.length = 0;
  images.clearWorkspaceImageCache();
  readImpl = async () => ({ ok: true, mime: 'image/png', base64: PNG_1PX, mtimeMs: 1, size: 70 });
});

/** Ein Antwort-Knoten, wie ihn markdownToSafeHtml nach dem Sanitizing liefert. */
function bubble(html) {
  const el = document.createElement('div');
  el.className = 'chat-md';
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

test('ein relativer Pfad wird geholt und als data:-URI gesetzt', async () => {
  const el = bubble('<p><img src="bilder/plot.png" alt="Diagramm"></p>');
  await images.applyWorkspaceImages(el, { api, workspaceRoot: '/ws' });

  assert.deepEqual(asked, ['bilder/plot.png']);
  const img = el.querySelector('img');
  assert.equal(img.getAttribute('src'), PNG_DATA_URL);
  assert.equal(img.getAttribute('alt'), 'Diagramm', 'der Alt-Text bleibt stehen');
  assert.ok(img.classList.contains('chat-md-image-img'));
});

test('ein absoluter Pfad geht genauso durch — entschieden wird im Main', async () => {
  const abs = path.join('/ws', 'plot.png');
  const el = bubble(`<p><img src="${abs}" alt="Plot"></p>`);
  await images.applyWorkspaceImages(el, { api, workspaceRoot: '/ws' });

  assert.deepEqual(asked, [abs]);
  assert.equal(el.querySelector('img').getAttribute('src'), PNG_DATA_URL);
});

test('jeder Ablehnungsgrund wird zu einem Platzhalter mit Text', async () => {
  for (const reason of Object.values(WORKSPACE_IMAGE_ERRORS)) {
    readImpl = async () => ({ ok: false, reason });
    images.clearWorkspaceImageCache();
    const el = bubble('<p><img src="plot.png" alt="Diagramm"></p>');
    await images.applyWorkspaceImages(el, { api, workspaceRoot: '/ws' });

    assert.equal(!!el.querySelector('img'), false, `${reason}: kein Broken-Image-Knoten mehr`);
    const box = el.querySelector('.chat-md-image--placeholder');
    assert.ok(box, reason);
    assert.equal(box.getAttribute('role'), 'img');
    assert.equal(box.querySelector('.chat-md-image-alt').textContent, 'Diagramm');
    const grund = box.querySelector('.chat-md-image-reason').textContent;
    assert.ok(grund.length > 0, `${reason}: der Grund steht als Text da`);
    // Der Grund gehoert auch in den Namen, sonst hoert eine Sprachausgabe nur „Bild“.
    assert.equal(box.getAttribute('aria-label'), `Diagramm: ${grund}`);
  }
});

test('ein Fehler auf dem IPC-Weg endet ebenfalls im Platzhalter', async () => {
  readImpl = async () => { throw new Error('Kanal weg'); };
  const el = bubble('<p><img src="plot.png" alt="Diagramm"></p>');
  await images.applyWorkspaceImages(el, { api, workspaceRoot: '/ws' });
  assert.ok(el.querySelector('.chat-md-image--placeholder'));
});

test('fremde Quellen werden nicht gefragt — data: bleibt unangetastet', async () => {
  const el = bubble(
    '<p><img src="https://example.com/x.png" alt="Fremd">'
    + '<img src="file:///etc/passwd" alt="Datei">'
    + `<img src="${PNG_DATA_URL}" alt="Eigenes"></p>`
  );
  await images.applyWorkspaceImages(el, { api, workspaceRoot: '/ws' });

  assert.deepEqual(asked, [], 'kein IPC fuer Quellen mit eigener Herkunft');
  const platzhalter = [...el.querySelectorAll('.chat-md-image--placeholder')];
  assert.equal(platzhalter.length, 2);
  // Das data:-Bild traegt seine Bytes selbst und ist per CSP erlaubt.
  const bleibt = el.querySelectorAll('img');
  assert.equal(bleibt.length, 1);
  assert.equal(bleibt[0].getAttribute('alt'), 'Eigenes');
});

test('waehrend des Streams laedt nichts — nur ein ruhiger Platzhalter', async () => {
  const el = bubble('<p><img src="plot.png" alt="Diagramm"></p>');
  await images.applyWorkspaceImages(el, { api, workspaceRoot: '/ws', streaming: true });

  assert.deepEqual(asked, [], 'kein Ladevorgang je Animation-Frame');
  assert.equal(!!el.querySelector('img'), false);
  const box = el.querySelector('.chat-md-image--pending');
  assert.ok(box, 'der Platzhalter ist als „laeuft noch“ gekennzeichnet');
  assert.equal(box.classList.contains('chat-md-image--placeholder'), false);
  assert.equal(box.querySelector('.chat-md-image-alt').textContent, 'Diagramm');
});

test('dasselbe Bild wird nur einmal geholt, auch ueber mehrere Blasen', async () => {
  for (let i = 0; i < 3; i += 1) {
    const el = bubble('<p><img src="plot.png" alt="Diagramm"></p>');
    await images.applyWorkspaceImages(el, { api, workspaceRoot: '/ws' });
    assert.equal(el.querySelector('img').getAttribute('src'), PNG_DATA_URL);
  }
  assert.deepEqual(asked, ['plot.png'], 'der Cache spart die weiteren Runden');
});

test('ein anderer Workspace sieht den Cache-Eintrag nicht', async () => {
  await images.applyWorkspaceImages(bubble('<p><img src="plot.png"></p>'), { api, workspaceRoot: '/ws-a' });
  await images.applyWorkspaceImages(bubble('<p><img src="plot.png"></p>'), { api, workspaceRoot: '/ws-b' });
  // Derselbe relative Pfad meint in einem anderen Ordner etwas anderes.
  assert.deepEqual(asked, ['plot.png', 'plot.png']);
});

test('ein neu geschriebenes Bild kommt nach dem Leeren des Caches frisch', async () => {
  const el1 = bubble('<p><img src="plot.png"></p>');
  await images.applyWorkspaceImages(el1, { api, workspaceRoot: '/ws' });

  readImpl = async () => ({ ok: true, mime: 'image/gif', base64: 'R0lGOD', mtimeMs: 2, size: 6 });
  images.clearWorkspaceImageCache();
  const el2 = bubble('<p><img src="plot.png"></p>');
  await images.applyWorkspaceImages(el2, { api, workspaceRoot: '/ws' });

  assert.equal(asked.length, 2);
  assert.equal(el2.querySelector('img').getAttribute('src'), 'data:image/gif;base64,R0lGOD');
});

test('ein Knoten, der zwischenzeitlich aus dem Dokument fiel, wird nicht angefasst', async () => {
  const el = bubble('<p><img src="plot.png" alt="Diagramm"></p>');
  const img = el.querySelector('img');
  const lauf = images.applyWorkspaceImages(el, { api, workspaceRoot: '/ws' });
  // Der Verlauf wird neu gezeichnet, waehrend die Antwort noch unterwegs ist.
  el.remove();
  await lauf;
  assert.equal(img.getAttribute('src'), 'plot.png', 'unveraendert — er haengt nirgends mehr');
});

test('ohne den IPC-Kanal steht der Platzhalter statt eines kaputten Bildes', async () => {
  const el = bubble('<p><img src="plot.png" alt="Diagramm"></p>');
  await images.applyWorkspaceImages(el, { api: {}, workspaceRoot: '/ws' });
  assert.ok(el.querySelector('.chat-md-image--placeholder'));
});

test('ein Knoten ohne Bilder und ein fehlender Knoten laufen ins Leere', async () => {
  await images.applyWorkspaceImages(null, { api, workspaceRoot: '/ws' });
  await images.applyWorkspaceImages(bubble('<p>nur Text</p>'), { api, workspaceRoot: '/ws' });
  assert.deepEqual(asked, []);
  await flush();
});
