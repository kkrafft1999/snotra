// Vertrag fuer Bilder aus dem Arbeitsordner (Issue #244).
//
// Zwei Entscheidungen stehen hier und nirgends sonst: Welcher Dateikopf als
// welches Bild gilt — und welches `src` ueberhaupt gegen den Workspace laufen
// darf. Beides ist reine Rechnerei ohne DOM und ohne Dateisystem.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_WORKSPACE_IMAGE_BYTES,
  WORKSPACE_IMAGE_ERRORS,
  WORKSPACE_IMAGE_MIME_TYPES,
  sniffImageMime,
  decodeWorkspaceImageSource,
  isWorkspaceImageSource,
  createWorkspaceImageResult,
  createWorkspaceImageError,
  workspaceImageErrorMessage,
  workspaceImageDataUrl,
} = require('../src/shared/contracts/workspace-image');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const GIF87 = Buffer.from('GIF87a....', 'latin1');
const GIF89 = Buffer.from('GIF89a....', 'latin1');
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'latin1'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'latin1'),
]);

test('erkennt die vier erlaubten Typen am Dateikopf', () => {
  assert.equal(sniffImageMime(PNG), 'image/png');
  assert.equal(sniffImageMime(JPEG), 'image/jpeg');
  assert.equal(sniffImageMime(GIF87), 'image/gif');
  assert.equal(sniffImageMime(GIF89), 'image/gif');
  assert.equal(sniffImageMime(WEBP), 'image/webp');
  // Die Liste im Vertrag und die Erkennung duerfen nicht auseinanderlaufen.
  assert.deepEqual(
    [...new Set([PNG, JPEG, GIF89, WEBP].map(sniffImageMime))].sort(),
    [...WORKSPACE_IMAGE_MIME_TYPES].sort()
  );
});

test('SVG und Fremdformate fallen durch — die Endung rettet nichts', () => {
  // Genau das, was in `diagramm.svg` steht: ein Textdokument ohne Bildkopf.
  assert.equal(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">')), null);
  assert.equal(sniffImageMime(Buffer.from('<?xml version="1.0"?><svg/>')), null);
  assert.equal(sniffImageMime(Buffer.from('BM6\x00\x00\x00', 'latin1')), null, 'BMP steht nicht auf der Liste');
  assert.equal(sniffImageMime(Buffer.from('nur Text')), null);
});

test('ein zu kurzer Kopf ist kein Bild, kein Absturz', () => {
  assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  assert.equal(sniffImageMime(Buffer.from([0x89, 0x50])), null);
  assert.equal(sniffImageMime(null), null);
  assert.equal(sniffImageMime(undefined), null);
  // RIFF allein ist noch kein WebP — dafuer braucht es die zweite Marke.
  assert.equal(sniffImageMime(Buffer.from('RIFF....AVI ', 'latin1')), null);
});

test('aufgeloest wird nur, was keine eigene Herkunft nennt', () => {
  for (const src of ['diagramm.png', 'bilder/plot.png', './plot.png', '/Users/k/ws/plot.png', 'C:\\ws\\plot.png']) {
    assert.equal(isWorkspaceImageSource(src), true, src);
  }
  for (const src of ['https://example.com/x.png', 'http://x/y.png', 'file:///etc/passwd',
    'data:image/png;base64,AAA', '//cdn.example.com/x.png', '', '   ', null, 42]) {
    assert.equal(isWorkspaceImageSource(src), false, String(src));
  }
});

test('jeder Grund traegt einen Platzhalter-Text, auch ein unbekannter', () => {
  for (const reason of Object.values(WORKSPACE_IMAGE_ERRORS)) {
    const error = createWorkspaceImageError(reason);
    assert.equal(error.ok, false);
    assert.equal(error.reason, reason);
    assert.ok(error.message.length > 0, reason);
  }
  // Ein Grund von aussen, den es nicht gibt, faellt auf „nicht gefunden“.
  assert.equal(createWorkspaceImageError('quatsch').reason, WORKSPACE_IMAGE_ERRORS.NOT_FOUND);
  assert.ok(workspaceImageErrorMessage(undefined).length > 0);
});

test('der data:-URI entsteht nur aus einem vollstaendigen Ergebnis', () => {
  const ok = createWorkspaceImageResult({ mime: 'image/png', base64: 'AAA', mtimeMs: 7, size: 3 });
  assert.equal(workspaceImageDataUrl(ok), 'data:image/png;base64,AAA');
  assert.equal(ok.mtimeMs, 7);
  assert.equal(workspaceImageDataUrl(createWorkspaceImageError(WORKSPACE_IMAGE_ERRORS.TOO_LARGE)), '');
  assert.equal(workspaceImageDataUrl(null), '');
  assert.equal(workspaceImageDataUrl({ ok: true, mime: 'image/png' }), '');
});

test('das Groessenlimit ist gesetzt und nicht aus Versehen null', () => {
  assert.equal(MAX_WORKSPACE_IMAGE_BYTES, 10 * 1024 * 1024);
});

test('aus der Markdown-URL wird wieder der Pfad des Modells', () => {
  // `marked` erzeugt eine URL, keinen Dateipfad, und kodiert entsprechend.
  assert.equal(decodeWorkspaceImageSource('C:%5Cws%5Cplot.png'), 'C:\\ws\\plot.png');
  assert.equal(decodeWorkspaceImageSource('bilder/gr%C3%BCn.png'), 'bilder/grün.png');
  assert.equal(decodeWorkspaceImageSource('bilder/mein%20plot.png'), 'bilder/mein plot.png');
  // Ohne „%“ gibt es nichts zu tun — nur trimmen.
  assert.equal(decodeWorkspaceImageSource('  bilder/plot.png  '), 'bilder/plot.png');
  // Kaputte Kodierung wirft nicht, sie bleibt stehen und scheitert an der Pfadpruefung.
  assert.equal(decodeWorkspaceImageSource('100%-fertig.png'), '100%-fertig.png');
  assert.equal(decodeWorkspaceImageSource('%E0%A4%A.png'), '%E0%A4%A.png');
  assert.equal(decodeWorkspaceImageSource(null), '');
});
