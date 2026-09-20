'use strict';

/**
 * Vertrag für `fs:readWorkspaceImage` (Issue #244): Ein vom Modell erzeugtes
 * Bild aus dem Arbeitsordner in der Chat-Antwort zeigen.
 *
 * Der Transport ist bewusst ein `data:`-URI über IPC statt eines eigenen
 * Schemas: `img-src 'self' data:` steht schon in der CSP des Renderers, es
 * braucht also weder eine Lockerung dort noch eine `protocol.handle`-
 * Registrierung im Main. Der Preis ist Base64 im Speicher (~+33 %) und kein
 * Browser-Caching — dagegen stehen das Größenlimit hier und der Cache im
 * Renderer.
 *
 * Der Main-Prozess bleibt die Vertrauensgrenze: Er entscheidet, ob ein Pfad im
 * Workspace liegt (lexikalisch **und** über `realpath`), ob der Typ erlaubt ist
 * (am Dateiinhalt, nicht an der Endung) und ob die Datei klein genug ist. Der
 * Renderer bekommt entweder Bytes oder einen Grund — nie einen Pfad, mit dem er
 * selbst etwas anfangen müsste.
 */

/** 10 MB. Darüber erscheint der Platzhalter statt eines halben Ladevorgangs. */
const MAX_WORKSPACE_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Gründe, aus denen ein Bild nicht kommt. Jeder trägt im Renderer einen
 * eigenen Platzhalter-Text — „geht nicht“ ohne Angabe wäre ein Zustand ohne
 * Rückmeldung.
 */
const WORKSPACE_IMAGE_ERRORS = Object.freeze({
  NO_WORKSPACE: 'no-workspace',
  OUTSIDE_WORKSPACE: 'outside-workspace',
  NOT_FOUND: 'not-found',
  UNSUPPORTED_TYPE: 'unsupported-type',
  TOO_LARGE: 'too-large',
});

const WORKSPACE_IMAGE_ERROR_MESSAGES = Object.freeze({
  [WORKSPACE_IMAGE_ERRORS.NO_WORKSPACE]: 'Kein Arbeitsordner geöffnet',
  [WORKSPACE_IMAGE_ERRORS.OUTSIDE_WORKSPACE]: 'Außerhalb des Arbeitsordners',
  [WORKSPACE_IMAGE_ERRORS.NOT_FOUND]: 'Bild nicht gefunden',
  [WORKSPACE_IMAGE_ERRORS.UNSUPPORTED_TYPE]: 'Dieses Bildformat wird nicht angezeigt',
  [WORKSPACE_IMAGE_ERRORS.TOO_LARGE]: 'Bild zu groß zum Anzeigen',
});

/**
 * Erlaubte Typen. SVG steht bewusst nicht dabei: Eine SVG-Datei ist ein
 * Dokument mit Skript- und Verweismöglichkeiten, kein reines Pixelbild — das
 * gehört eigens betrachtet und nicht nebenbei mitgenommen (Issue #244).
 */
const WORKSPACE_IMAGE_MIME_TYPES = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Kopf-Bytes je Typ. Mehr als das liest die Erkennung nie. */
const WORKSPACE_IMAGE_SNIFF_BYTES = 16;

function startsWith(bytes, signature, offset = 0) {
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

function ascii(text) {
  return [...text].map((c) => c.charCodeAt(0));
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF87_SIGNATURE = ascii('GIF87a');
const GIF89_SIGNATURE = ascii('GIF89a');
const RIFF_SIGNATURE = ascii('RIFF');
const WEBP_SIGNATURE = ascii('WEBP');

/**
 * Erkennt den Bildtyp am Dateikopf. Die Endung zählt nicht: Ein Modell, das
 * eine Textdatei `plot.png` nennt, soll keinen Anzeigeversuch auslösen, und
 * ein richtiges PNG namens `plot.bin` soll ihn bekommen.
 *
 * @param {Uint8Array|Buffer|Array<number>} header Die ersten Bytes der Datei.
 * @returns {string|null} MIME-Typ oder `null`, wenn es keiner der erlaubten ist.
 */
function sniffImageMime(header) {
  const bytes = header || [];
  if (bytes.length < 4) return null;
  if (startsWith(bytes, PNG_SIGNATURE)) return 'image/png';
  if (startsWith(bytes, JPEG_SIGNATURE)) return 'image/jpeg';
  if (startsWith(bytes, GIF87_SIGNATURE) || startsWith(bytes, GIF89_SIGNATURE)) return 'image/gif';
  if (bytes.length >= 12 && startsWith(bytes, RIFF_SIGNATURE) && startsWith(bytes, WEBP_SIGNATURE, 8)) {
    return 'image/webp';
  }
  return null;
}

/**
 * Holt aus dem `src` eines gerenderten `<img>` den Pfad zurück, den das Modell
 * geschrieben hat.
 *
 * Nötig, weil Markdown eine URL erzeugt und keinen Dateipfad: `marked`
 * prozent-kodiert alles, was in einer URL nicht roh stehen darf. Aus
 * `![x](C:\ws\plot.png)` wird `C:%5Cws%5Cplot.png`, aus `bilder/grün.png`
 * wird `bilder/gr%C3%BCn.png`, und ein Leerzeichen schreibt das Modell ohnehin
 * als `%20`. Ohne Rückwandlung fände der Main-Prozess keine dieser Dateien.
 *
 * Ist die Kodierung kaputt (einzelnes `%`), bleibt der Rohwert stehen — er
 * scheitert dann an der Pfadprüfung statt an einer Ausnahme.
 */
function decodeWorkspaceImageSource(src) {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (!raw.includes('%')) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * Darf dieses `src` überhaupt gegen den Workspace aufgelöst werden?
 *
 * Nein für alles, was schon eine eigene Herkunft nennt: `http(s)://`,
 * `file://`, `data:`, protokoll-relative `//host/…` — und für ein leeres
 * Attribut. Ja für alles andere, also relative Pfade (`bilder/plot.png`) und
 * absolute Pfade (`/Users/…/ws/plot.png`, `C:\…`). Ob ein absoluter Pfad
 * wirklich im Workspace liegt, entscheidet der Main-Prozess — hier geht es nur
 * darum, wofür überhaupt gefragt wird.
 */
function isWorkspaceImageSource(src) {
  const raw = typeof src === 'string' ? src.trim() : '';
  if (!raw) return false;
  if (raw.startsWith('//')) return false;
  // Ein Schema steht vor dem ersten „:“ und besteht aus Buchstaben, Ziffern,
  // „+“, „-“ und „.“. `C:\bilder` ist damit kein Schema (ein Buchstabe reicht
  // nicht), `data:` und `file:` schon.
  return !/^[a-z][a-z0-9+.-]+:/i.test(raw);
}

function createWorkspaceImageResult({ mime, base64, mtimeMs = 0, size = 0 } = {}) {
  return { ok: true, mime, base64, mtimeMs, size };
}

function createWorkspaceImageError(reason) {
  const known = Object.values(WORKSPACE_IMAGE_ERRORS).includes(reason)
    ? reason
    : WORKSPACE_IMAGE_ERRORS.NOT_FOUND;
  return { ok: false, reason: known, message: WORKSPACE_IMAGE_ERROR_MESSAGES[known] };
}

/** Platzhalter-Text zu einem Grund — auch für unbekannte Gründe nie leer. */
function workspaceImageErrorMessage(reason) {
  return (
    WORKSPACE_IMAGE_ERROR_MESSAGES[reason]
    || WORKSPACE_IMAGE_ERROR_MESSAGES[WORKSPACE_IMAGE_ERRORS.NOT_FOUND]
  );
}

function workspaceImageDataUrl(result) {
  if (!result?.ok || !result.mime || !result.base64) return '';
  return `data:${result.mime};base64,${result.base64}`;
}

module.exports = {
  MAX_WORKSPACE_IMAGE_BYTES,
  decodeWorkspaceImageSource,
  WORKSPACE_IMAGE_ERRORS,
  WORKSPACE_IMAGE_ERROR_MESSAGES,
  WORKSPACE_IMAGE_MIME_TYPES,
  WORKSPACE_IMAGE_SNIFF_BYTES,
  sniffImageMime,
  isWorkspaceImageSource,
  createWorkspaceImageResult,
  createWorkspaceImageError,
  workspaceImageErrorMessage,
  workspaceImageDataUrl,
};
