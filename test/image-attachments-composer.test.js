// Aufnahme von Bildern in den Composer (Issue #84).
//
// Das Verkleinern selbst braucht Canvas und laeuft nur im Renderer; die
// Entscheidungen davor — welches Bild kommt rein, welche Zielgroesse, welche
// Meldung bei Ablehnung — sind DOM-frei und werden hier geprueft.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const modulePromise = import(
  pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'chat', 'imageAttachments.js')).href
);

const { LIMITS } = require('../src/shared/limits');

function fakeFile(type, name = 'shot.png') {
  return { type, name, size: 1024 };
}

test('planAttachmentIntake nimmt Bilder bis zum Limit', async () => {
  const { planAttachmentIntake, INTAKE_REJECTIONS } = await modulePromise;

  const files = [];
  for (let i = 0; i < LIMITS.MAX_IMAGES_PER_MESSAGE + 2; i += 1) files.push(fakeFile('image/png'));

  const { accepted, rejections } = planAttachmentIntake(0, files);
  assert.equal(accepted.length, LIMITS.MAX_IMAGES_PER_MESSAGE);
  assert.deepEqual(rejections, [INTAKE_REJECTIONS.TOO_MANY]);
});

test('planAttachmentIntake rechnet die schon haengenden Chips mit', async () => {
  const { planAttachmentIntake } = await modulePromise;

  const { accepted } = planAttachmentIntake(LIMITS.MAX_IMAGES_PER_MESSAGE - 1, [
    fakeFile('image/png'),
    fakeFile('image/png'),
  ]);
  assert.equal(accepted.length, 1);
});

test('planAttachmentIntake weist fremde Formate ab, ohne die anderen zu verlieren', async () => {
  const { planAttachmentIntake, INTAKE_REJECTIONS } = await modulePromise;

  const { accepted, rejections } = planAttachmentIntake(0, [
    fakeFile('image/svg+xml', 'diagramm.svg'),
    fakeFile('application/pdf', 'bericht.pdf'),
    fakeFile('image/jpeg', 'foto.jpg'),
  ]);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].name, 'foto.jpg');
  assert.deepEqual(rejections, [INTAKE_REJECTIONS.UNSUPPORTED_TYPE]);
});

test('rejectionMessage liefert zu jedem Grund einen lesbaren Satz', async () => {
  const { rejectionMessage, INTAKE_REJECTIONS } = await modulePromise;

  for (const reason of Object.values(INTAKE_REJECTIONS)) {
    const text = rejectionMessage(reason);
    assert.ok(text.length > 10, reason);
  }
  assert.ok(rejectionMessage('unbekannt').length > 10);
});

test('scaledSize verkleinert nur die laengste Kante und haelt das Seitenverhaeltnis', async () => {
  const { scaledSize } = await modulePromise;
  const max = LIMITS.MAX_IMAGE_EDGE_PX;

  assert.deepEqual(scaledSize(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(scaledSize(max, max), { width: max, height: max, scaled: false });

  const quer = scaledSize(max * 2, max);
  assert.equal(quer.scaled, true);
  assert.equal(quer.width, max);
  assert.equal(quer.height, Math.round(max / 2));

  const hoch = scaledSize(max, max * 4);
  assert.equal(hoch.width, Math.round(max / 4));
  assert.equal(hoch.height, max);

  // Extrem schmale Bilder duerfen nicht auf 0 Pixel zusammenfallen.
  assert.equal(scaledSize(max * 100, 1).height, 1);
});

test('imageFilesFromClipboard nimmt nur Dateien vom Typ image/*', async () => {
  const { imageFilesFromClipboard } = await modulePromise;

  const png = fakeFile('image/png');
  const clipboardData = {
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => png },
      { kind: 'file', type: 'application/pdf', getAsFile: () => fakeFile('application/pdf') },
    ],
  };

  assert.deepEqual(imageFilesFromClipboard(clipboardData), [png]);
  assert.deepEqual(imageFilesFromClipboard(null), []);
  assert.deepEqual(imageFilesFromClipboard({}), []);
});
