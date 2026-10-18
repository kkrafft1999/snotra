import contracts from '../generated/contracts.js';
import { t } from '../i18n.js';

/**
 * Bild-Anhaenge im Composer (Issue #84).
 *
 * Einstieg ist die Zwischenablage: ein Screenshot liegt dort als Blob, nicht
 * als Datei auf der Platte. Vor dem Senden wird er verkleinert und als Base64
 * an die Nachricht gehaengt.
 *
 * Die Entscheidungen (nehmen wir das Bild? warum nicht?) liegen in reinen
 * Funktionen, damit sie ohne DOM pruefbar sind; nur das Verkleinern selbst
 * braucht Canvas und Bildschirm.
 */

const {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_EDGE_PX,
  isImageMediaType,
  toDataUrl,
} = contracts;

export { MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_EDGE_PX, toDataUrl };

/** Gruende, aus denen ein Bild abgelehnt wird — je mit fertigem Meldungstext. */
export const INTAKE_REJECTIONS = Object.freeze({
  UNSUPPORTED_TYPE: 'unsupported-type',
  TOO_MANY: 'too-many',
  TOO_LARGE: 'too-large',
  // Snotra has no image adapter for this provider yet (#91–#92) — the model
  // behind it may well take images, so the message must not blame it (#995).
  PROVIDER_PASSES_NO_IMAGES: 'provider-passes-no-images',
  // An OpenAI-compatible connection with "Allow image attachments" off: the
  // user's own setting, which they can change.
  CONNECTION_WITHOUT_IMAGES: 'connection-without-images',
});

/** Where the image limit of the active model comes from (#995). */
export const IMAGE_LIMITED_BY = Object.freeze({
  PROVIDER: 'provider',
  CONNECTION: 'connection',
});

function formatMiB(bytes) {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

/**
 * `provider` is the display name of the active provider; it only matters for
 * PROVIDER_PASSES_NO_IMAGES.
 */
export function rejectionMessage(reason, { provider = '' } = {}) {
  switch (reason) {
    case INTAKE_REJECTIONS.UNSUPPORTED_TYPE:
      return t('chat.image.error.unsupportedType');
    case INTAKE_REJECTIONS.TOO_MANY:
      return t('chat.image.error.tooMany', { max: MAX_IMAGES_PER_MESSAGE });
    case INTAKE_REJECTIONS.TOO_LARGE:
      return t('chat.image.error.tooLarge', { max: formatMiB(MAX_IMAGE_ATTACHMENT_BYTES) });
    case INTAKE_REJECTIONS.PROVIDER_PASSES_NO_IMAGES:
      return provider
        ? t('chat.image.error.providerPassesNoImages', { provider })
        : t('chat.image.error.providerPassesNoImages.unnamed');
    case INTAKE_REJECTIONS.CONNECTION_WITHOUT_IMAGES:
      return t('chat.image.error.connectionWithoutImages');
    default:
      return t('chat.image.error.generic');
  }
}

/**
 * Entscheidet vor dem Einlesen, welche der eingefuegten Dateien ueberhaupt in
 * Frage kommen. `existingCount` sind die Chips, die schon am Composer haengen.
 * `imagesSupported` sagt, ob der aktive Anbieter Bilder weiterreicht (#93).
 * `imagesLimitedBy` says why not — see IMAGE_LIMITED_BY (#995).
 *
 * @returns {{ accepted: any[], rejections: string[] }}
 */
export function planAttachmentIntake(
  existingCount,
  files,
  { imagesSupported = true, imagesLimitedBy = IMAGE_LIMITED_BY.PROVIDER } = {},
) {
  const list = Array.isArray(files) ? files : [];
  const accepted = [];
  const rejections = [];
  if (!imagesSupported) {
    const reason = imagesLimitedBy === IMAGE_LIMITED_BY.CONNECTION
      ? INTAKE_REJECTIONS.CONNECTION_WITHOUT_IMAGES
      : INTAKE_REJECTIONS.PROVIDER_PASSES_NO_IMAGES;
    return { accepted, rejections: list.length > 0 ? [reason] : [] };
  }
  let free = Math.max(0, MAX_IMAGES_PER_MESSAGE - (Number(existingCount) || 0));

  for (const file of list) {
    if (!isImageMediaType(file?.type)) {
      if (!rejections.includes(INTAKE_REJECTIONS.UNSUPPORTED_TYPE)) {
        rejections.push(INTAKE_REJECTIONS.UNSUPPORTED_TYPE);
      }
      continue;
    }
    if (free === 0) {
      if (!rejections.includes(INTAKE_REJECTIONS.TOO_MANY)) {
        rejections.push(INTAKE_REJECTIONS.TOO_MANY);
      }
      continue;
    }
    accepted.push(file);
    free -= 1;
  }
  return { accepted, rejections };
}

/** Bilder aus einem ClipboardEvent — Screenshots kommen hier als Datei an. */
export function imageFilesFromClipboard(clipboardData) {
  const items = clipboardData?.items ? Array.from(clipboardData.items) : [];
  const out = [];
  for (const item of items) {
    if (item?.kind !== 'file') continue;
    const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
    if (file && typeof file.type === 'string' && file.type.startsWith('image/')) out.push(file);
  }
  return out;
}

/**
 * Zielgroesse fuer das Verkleinern: laengste Kante auf MAX_IMAGE_EDGE_PX,
 * Seitenverhaeltnis bleibt. Kleinere Bilder bleiben unangetastet.
 */
export function scaledSize(width, height, maxEdge = MAX_IMAGE_EDGE_PX) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const longest = Math.max(w, h);
  if (longest <= maxEdge) return { width: w, height: h, scaled: false };
  const factor = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(w * factor)),
    height: Math.max(1, Math.round(h * factor)),
    scaled: true,
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error(t('chat.image.error.unreadable')));
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma === -1 ? '' : result.slice(comma + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas, mediaType, quality) {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), mediaType, quality);
  });
}

/**
 * Liest eine Bilddatei ein, verkleinert sie bei Bedarf und liefert den fertigen
 * Anhang. Retina-Screenshots sind sonst unnoetig gross — mehrere Megabyte fuer
 * eine Bildschirmhaelfte sind normal.
 *
 * @returns {Promise<{ ok: true, attachment: object } | { ok: false, reason: string }>}
 */
export async function prepareImageAttachment(file) {
  if (!isImageMediaType(file?.type)) {
    return { ok: false, reason: INTAKE_REJECTIONS.UNSUPPORTED_TYPE };
  }

  // Animierte GIFs ueberleben den Canvas-Weg nicht (nur das erste Bild bliebe
  // uebrig), darum gehen sie unveraendert durch — solange sie ins Limit passen.
  const skipCanvas = file.type === 'image/gif';
  let blob = file;
  let mediaType = file.type;

  if (!skipCanvas && typeof createImageBitmap === 'function') {
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      bitmap = null;
    }
    if (bitmap) {
      const target = scaledSize(bitmap.width, bitmap.height);
      const needsReencode = target.scaled || file.size > MAX_IMAGE_ATTACHMENT_BYTES;
      if (needsReencode) {
        const canvas = document.createElement('canvas');
        canvas.width = target.width;
        canvas.height = target.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(bitmap, 0, 0, target.width, target.height);
        // PNG bleibt PNG (Screenshots mit Text bleiben scharf); erst wenn das
        // Ergebnis zu gross ist, wird auf JPEG ausgewichen.
        let encoded = await canvasToBlob(canvas, mediaType, 0.92);
        if (encoded && encoded.size > MAX_IMAGE_ATTACHMENT_BYTES && mediaType !== 'image/jpeg') {
          const asJpeg = await canvasToBlob(canvas, 'image/jpeg', 0.85);
          if (asJpeg && asJpeg.size < encoded.size) {
            encoded = asJpeg;
            mediaType = 'image/jpeg';
          }
        }
        if (encoded) blob = encoded;
      }
      bitmap.close?.();
    }
  }

  if (blob.size > MAX_IMAGE_ATTACHMENT_BYTES) {
    return { ok: false, reason: INTAKE_REJECTIONS.TOO_LARGE };
  }

  const dataBase64 = await blobToBase64(blob);
  if (!dataBase64) return { ok: false, reason: INTAKE_REJECTIONS.TOO_LARGE };

  return {
    ok: true,
    attachment: {
      kind: 'image',
      mediaType,
      dataBase64,
      bytes: blob.size,
      // No name of our own: the chip and the gallery fall back to the catalogue (#595).
      name: typeof file.name === 'string' ? file.name : '',
    },
  };
}
