// Bild-Anhaenge einer Chat-Nachricht (Issue #84).
//
// Der Payload kommt aus dem Renderer und ist damit ungeprueft: der Main-Prozess
// normalisiert selbst, statt sich auf das Aufraeumen im Renderer zu verlassen.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeImageAttachment,
  normalizeAttachments,
  imageAttachmentsOf,
  attachmentsCharCost,
  toDataUrl,
  base64ByteLength,
  IMAGE_ATTACHMENT_CHAR_COST,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_ATTACHMENT_BYTES,
} = require('../src/shared/contracts/attachments');

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('normalizeImageAttachment liefert die kanonische Form', () => {
  const result = normalizeImageAttachment({
    kind: 'image',
    mediaType: 'image/PNG',
    dataBase64: PNG_1PX,
    name: '  Screenshot.png  ',
  });
  assert.equal(result.kind, 'image');
  assert.equal(result.mediaType, 'image/png');
  assert.equal(result.dataBase64, PNG_1PX);
  assert.equal(result.name, 'Screenshot.png');
  assert.equal(result.bytes, base64ByteLength(PNG_1PX));
});

test('normalizeImageAttachment trennt ein data:-Praefix ab', () => {
  const result = normalizeImageAttachment({ dataBase64: `data:image/jpeg;base64,${PNG_1PX}` });
  assert.equal(result.mediaType, 'image/jpeg');
  assert.equal(result.dataBase64, PNG_1PX);
});

test('normalizeImageAttachment weist Unbrauchbares ab', () => {
  const bad = [
    null,
    'nur ein String',
    { mediaType: 'image/svg+xml', dataBase64: PNG_1PX },
    { mediaType: 'application/pdf', dataBase64: PNG_1PX },
    { mediaType: 'image/png', dataBase64: 'kein!base64$' },
    { mediaType: 'image/png', dataBase64: '' },
    { kind: 'file', mediaType: 'image/png', dataBase64: PNG_1PX },
  ];
  for (const raw of bad) {
    assert.equal(normalizeImageAttachment(raw), null, JSON.stringify(raw));
  }
});

test('normalizeImageAttachment weist Bilder ueber dem Byte-Limit ab', () => {
  // 'A' ist ein gueltiges Base64-Zeichen; vier davon ergeben drei Byte.
  const zuGross = 'A'.repeat(Math.ceil((MAX_IMAGE_ATTACHMENT_BYTES + 1024) / 3) * 4);
  assert.equal(normalizeImageAttachment({ mediaType: 'image/png', dataBase64: zuGross }), null);
});

test('normalizeAttachments kappt bei MAX_IMAGES_PER_MESSAGE und wirft Muell weg', () => {
  const eingabe = [];
  for (let i = 0; i < MAX_IMAGES_PER_MESSAGE + 3; i += 1) {
    eingabe.push({ mediaType: 'image/png', dataBase64: PNG_1PX });
  }
  eingabe.splice(1, 0, { mediaType: 'text/plain', dataBase64: PNG_1PX });

  const result = normalizeAttachments(eingabe);
  assert.equal(result.length, MAX_IMAGES_PER_MESSAGE);
  assert.deepEqual(normalizeAttachments(undefined), []);
  assert.deepEqual(normalizeAttachments('nope'), []);
});

test('imageAttachmentsOf und attachmentsCharCost sehen nur gueltige Bilder', () => {
  const message = {
    role: 'user',
    content: 'Was ist hier los?',
    attachments: [
      { kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX },
      { kind: 'image', mediaType: 'image/png', dataBase64: '' },
      { kind: 'note', mediaType: 'image/png', dataBase64: PNG_1PX },
    ],
  };
  assert.equal(imageAttachmentsOf(message).length, 1);
  assert.equal(attachmentsCharCost(message), IMAGE_ATTACHMENT_CHAR_COST);
  assert.equal(attachmentsCharCost({ role: 'user', content: 'x' }), 0);
});

test('toDataUrl baut die Data-URL fuer Anzeige und Responses-API', () => {
  assert.equal(
    toDataUrl({ mediaType: 'image/png', dataBase64: PNG_1PX }),
    `data:image/png;base64,${PNG_1PX}`,
  );
  assert.equal(toDataUrl(null), '');
});
