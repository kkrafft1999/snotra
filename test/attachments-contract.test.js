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

// --- Ablage-Form: Datei-Referenz statt Base64 (Issue #94) -------------------

const {
  attachmentFileExtension,
  attachmentMediaTypeForFile,
  isAttachmentFileName,
  normalizeStoredAttachment,
  normalizeStoredAttachments,
  countImageAttachments,
} = require('../src/shared/contracts/attachments');

const HASH64 = 'a'.repeat(64);

test('attachmentFileExtension und attachmentMediaTypeForFile sind zueinander invers', () => {
  for (const mediaType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    const ext = attachmentFileExtension(mediaType);
    assert.ok(ext, `keine Endung fuer ${mediaType}`);
    assert.equal(attachmentMediaTypeForFile(`${HASH64}.${ext}`), mediaType);
  }
  assert.equal(attachmentFileExtension('image/svg+xml'), '');
  assert.equal(attachmentMediaTypeForFile('datei.svg'), '');
  assert.equal(attachmentMediaTypeForFile('ohne-endung'), '');
});

test('isAttachmentFileName laesst nur Hash plus bekannte Endung durch', () => {
  assert.equal(isAttachmentFileName(`${HASH64}.png`), true);
  // Alles, was aus dem Anhang-Ordner herausfuehren koennte, faellt durch.
  assert.equal(isAttachmentFileName(`../${HASH64}.png`), false);
  assert.equal(isAttachmentFileName(`sub/${HASH64}.png`), false);
  assert.equal(isAttachmentFileName('../../etc/passwd'), false);
  assert.equal(isAttachmentFileName(`${HASH64}.png.exe`), false);
  assert.equal(isAttachmentFileName(`${HASH64}.svg`), false);
  assert.equal(isAttachmentFileName('kurz.png'), false);
});

test('normalizeStoredAttachment nimmt nur die Referenz, nie die Bilddaten', () => {
  const ref = normalizeStoredAttachment({
    kind: 'image',
    mediaType: 'image/PNG',
    file: `${HASH64}.png`,
    bytes: 4096,
    name: '  Screenshot.png  ',
    dataBase64: PNG_1PX,
  });
  assert.deepEqual(ref, {
    kind: 'image',
    mediaType: 'image/png',
    file: `${HASH64}.png`,
    bytes: 4096,
    name: 'Screenshot.png',
  });
  assert.equal('dataBase64' in ref, false);
});

test('normalizeStoredAttachment verwirft Referenzen, die nicht zusammenpassen', () => {
  // Endung und Medientyp muessen dasselbe sagen.
  assert.equal(normalizeStoredAttachment({ mediaType: 'image/jpeg', file: `${HASH64}.png` }), null);
  assert.equal(normalizeStoredAttachment({ mediaType: 'image/png', file: '../x.png' }), null);
  assert.equal(normalizeStoredAttachment({ mediaType: 'image/png' }), null);
  assert.equal(normalizeStoredAttachment({ file: `${HASH64}.png` }), null);
  assert.equal(normalizeStoredAttachment({ kind: 'audio', mediaType: 'image/png', file: `${HASH64}.png` }), null);
  assert.equal(normalizeStoredAttachment(null), null);
});

test('normalizeStoredAttachments kappt bei MAX_IMAGES_PER_MESSAGE', () => {
  const many = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 3 }, (_, i) => ({
    mediaType: 'image/png',
    file: `${String(i).padStart(64, '0')}.png`,
  }));
  assert.equal(normalizeStoredAttachments(many).length, MAX_IMAGES_PER_MESSAGE);
  assert.deepEqual(normalizeStoredAttachments(undefined), []);
});

test('countImageAttachments zaehlt beide Formen', () => {
  assert.equal(
    countImageAttachments({
      attachments: [
        { kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX },
        { kind: 'image', mediaType: 'image/png', file: `${HASH64}.png` },
      ],
    }),
    2
  );
  assert.equal(countImageAttachments({}), 0);
});
