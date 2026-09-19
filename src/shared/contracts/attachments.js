/**
 * Bild-Anhaenge einer Chat-Nachricht (Issue #84).
 *
 * Der Nachrichten-Content bleibt im gesamten Chat-Kern ein String; ein Bild
 * haengt als eigenes Feld `attachments` an der Nachricht. Damit bleiben
 * Verlaufs-Fensterung, Tool-Trace und Titel-Ableitung unveraendert — nur die
 * Provider-Adapter muessen Bilder kennen.
 *
 * Die Normalisierung liegt hier, weil beide Seiten sie brauchen: der Renderer
 * beim Aufnehmen aus der Zwischenablage und der Main-Prozess beim Entgegen-
 * nehmen des IPC-Payloads. Was ueber IPC kommt, ist ungeprueft — der Main
 * verlaesst sich nicht darauf, dass der Renderer schon aufgeraeumt hat.
 *
 * Ein Anhang hat zwei Formen (Issue #94): unterwegs traegt er die Bilddaten
 * selbst (`dataBase64`), im gespeicherten Verlauf nur den Namen der Datei, die
 * daneben liegt (`file`). Base64 in der Session-JSON blaeht sie sonst auf —
 * vier Screenshots pro Nachricht schlagen mit Megabytes zu Buche.
 */
'use strict';

const { LIMITS } = require('../limits');

/** Formate, die alle unterstuetzten Anbieter gemeinsam annehmen. */
const IMAGE_ATTACHMENT_MEDIA_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const ATTACHMENT_KINDS = Object.freeze({ IMAGE: 'image' });

/**
 * Dateiendung je Medientyp. Der gespeicherte Verlauf legt ein Bild als Datei
 * ab und traegt in der Nachricht nur die Referenz (Issue #94) — die Endung
 * muss deshalb eindeutig aus dem Medientyp folgen und umgekehrt.
 */
const IMAGE_ATTACHMENT_EXTENSIONS = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
});

const IMAGE_ATTACHMENT_MEDIA_TYPE_BY_EXTENSION = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
});

/**
 * Erlaubter Dateiname einer abgelegten Anhangsdatei: Inhalts-Hash plus Endung.
 * Bewusst eng — der Name kommt aus der Verlaufsdatei bzw. ueber IPC und wird zu
 * einem Pfad zusammengesetzt; weder Trenner noch Punkte duerfen darin vorkommen.
 */
const ATTACHMENT_FILE_RE = /^[0-9a-f]{32,64}\.(?:png|jpg|gif|webp)$/;

// Aus LIMITS durchgereicht, damit der Renderer die Grenzwerte ueber das
// Contract-Bundle bekommt und sie nicht ein zweites Mal beziffert.
const MAX_IMAGE_ATTACHMENT_BYTES = LIMITS.MAX_IMAGE_ATTACHMENT_BYTES;
const MAX_IMAGES_PER_MESSAGE = LIMITS.MAX_IMAGES_PER_MESSAGE;
const MAX_IMAGE_EDGE_PX = LIMITS.MAX_IMAGE_EDGE_PX;

/**
 * Grobe Kosten eines Bildes fuer die Verlaufs-Fensterung. Die Fensterung
 * rechnet in Zeichen (1 Token ≈ 4 Zeichen); ein Bild mit 1568 px laengster
 * Kante kostet je nach Anbieter rund 1600 Tokens. Ohne diesen Posten faende
 * die Fensterung Bilder gratis und schoebe den Verlauf ueber das Budget.
 */
const IMAGE_ATTACHMENT_CHAR_COST = 1600 * 4;

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function isImageMediaType(value) {
  return typeof value === 'string' && IMAGE_ATTACHMENT_MEDIA_TYPES.includes(value.toLowerCase());
}

/** Groesse der dekodierten Daten, ohne dafuer wirklich zu dekodieren. */
function base64ByteLength(data) {
  if (typeof data !== 'string' || data.length === 0) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

/**
 * Prueft einen einzelnen Anhang und liefert die kanonische Form
 * `{ kind, mediaType, dataBase64, name }` — oder `null`, wenn etwas nicht
 * stimmt. Ein `data:`-Praefix wird abgetrennt, damit der Renderer eine
 * Data-URL uebergeben darf.
 */
function normalizeImageAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== undefined && raw.kind !== ATTACHMENT_KINDS.IMAGE) return null;

  let mediaType = typeof raw.mediaType === 'string' ? raw.mediaType.trim().toLowerCase() : '';
  let data = typeof raw.dataBase64 === 'string' ? raw.dataBase64.trim() : '';

  const dataUrl = /^data:([^;,]+);base64,(.*)$/is.exec(data);
  if (dataUrl) {
    if (!mediaType) mediaType = dataUrl[1].trim().toLowerCase();
    data = dataUrl[2].trim();
  }
  // Zeilenumbrueche kommen in Base64 aus manchen Quellen vor und sind harmlos.
  data = data.replace(/\s+/g, '');

  if (!isImageMediaType(mediaType)) return null;
  if (!data || !BASE64_RE.test(data) || data.length % 4 !== 0) return null;

  const bytes = base64ByteLength(data);
  if (bytes <= 0 || bytes > LIMITS.MAX_IMAGE_ATTACHMENT_BYTES) return null;

  const out = { kind: ATTACHMENT_KINDS.IMAGE, mediaType, dataBase64: data, bytes };
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
  if (name) out.name = name;
  return out;
}

/**
 * Normalisiert eine Anhangsliste und kappt sie bei MAX_IMAGES_PER_MESSAGE.
 * Ungueltige Eintraege fallen weg; das Ergebnis ist immer ein Array.
 */
function normalizeAttachments(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= LIMITS.MAX_IMAGES_PER_MESSAGE) break;
    const normalized = normalizeImageAttachment(raw);
    if (normalized) out.push(normalized);
  }
  return out;
}

/** Endung, unter der ein Bild dieses Medientyps abgelegt wird ('' = unbekannt). */
function attachmentFileExtension(mediaType) {
  if (typeof mediaType !== 'string') return '';
  return IMAGE_ATTACHMENT_EXTENSIONS[mediaType.trim().toLowerCase()] || '';
}

/** Medientyp zu einer Anhangsdatei — aus der Endung, nicht aus fremden Angaben. */
function attachmentMediaTypeForFile(file) {
  if (typeof file !== 'string') return '';
  const dot = file.lastIndexOf('.');
  if (dot < 0) return '';
  return IMAGE_ATTACHMENT_MEDIA_TYPE_BY_EXTENSION[file.slice(dot + 1).toLowerCase()] || '';
}

/** Ist das ein Dateiname, den die Ablage selbst vergeben haben kann? */
function isAttachmentFileName(value) {
  return typeof value === 'string' && ATTACHMENT_FILE_RE.test(value);
}

/**
 * Anhang in Ablage-Form: `{ kind, mediaType, file }` statt Base64 (Issue #94).
 * Liefert `null`, sobald etwas nicht stimmt — insbesondere, wenn Endung und
 * Medientyp auseinanderlaufen. Base64 wird hier nie uebernommen; genau das
 * haelt die Verlaufsdatei schlank.
 */
function normalizeStoredAttachment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== undefined && raw.kind !== ATTACHMENT_KINDS.IMAGE) return null;

  const mediaType = typeof raw.mediaType === 'string' ? raw.mediaType.trim().toLowerCase() : '';
  const file = typeof raw.file === 'string' ? raw.file.trim() : '';
  if (!isImageMediaType(mediaType) || !isAttachmentFileName(file)) return null;
  if (attachmentMediaTypeForFile(file) !== mediaType) return null;

  const out = { kind: ATTACHMENT_KINDS.IMAGE, mediaType, file };
  const bytes = Math.round(Number(raw.bytes) || 0);
  if (bytes > 0) out.bytes = bytes;
  const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 120) : '';
  if (name) out.name = name;
  return out;
}

/** Anhangsliste in Ablage-Form, bei MAX_IMAGES_PER_MESSAGE gekappt. */
function normalizeStoredAttachments(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= LIMITS.MAX_IMAGES_PER_MESSAGE) break;
    const normalized = normalizeStoredAttachment(raw);
    if (normalized) out.push(normalized);
  }
  return out;
}

/** Zaehlt die Bild-Anhaenge einer Nachricht, gleich ob Base64 oder Referenz. */
function countImageAttachments(message) {
  const list = Array.isArray(message?.attachments) ? message.attachments : [];
  return list.filter((a) => a && (a.kind === undefined || a.kind === ATTACHMENT_KINDS.IMAGE)).length;
}

/** Nur die Bilder einer Nachricht — bequemer Zugriff fuer die Provider. */
function imageAttachmentsOf(message) {
  const list = Array.isArray(message?.attachments) ? message.attachments : [];
  return list.filter((a) => a?.kind === ATTACHMENT_KINDS.IMAGE && isImageMediaType(a.mediaType) && a.dataBase64);
}

/** Geschaetzte Zeichenkosten der Anhaenge einer Nachricht (Fensterung). */
function attachmentsCharCost(message) {
  return imageAttachmentsOf(message).length * IMAGE_ATTACHMENT_CHAR_COST;
}

/** Data-URL zur Anzeige im Renderer bzw. fuer die OpenAI-Responses-API. */
function toDataUrl(attachment) {
  if (!attachment?.mediaType || !attachment?.dataBase64) return '';
  return `data:${attachment.mediaType};base64,${attachment.dataBase64}`;
}

module.exports = {
  ATTACHMENT_KINDS,
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_EDGE_PX,
  IMAGE_ATTACHMENT_MEDIA_TYPES,
  IMAGE_ATTACHMENT_CHAR_COST,
  ATTACHMENT_FILE_RE,
  isImageMediaType,
  attachmentFileExtension,
  attachmentMediaTypeForFile,
  isAttachmentFileName,
  normalizeStoredAttachment,
  normalizeStoredAttachments,
  countImageAttachments,
  base64ByteLength,
  normalizeImageAttachment,
  normalizeAttachments,
  imageAttachmentsOf,
  attachmentsCharCost,
  toDataUrl,
};
