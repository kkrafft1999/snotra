import contracts from '../generated/contracts.js';

const {
  decodeWorkspaceImageSource,
  isWorkspaceImageSource,
  workspaceImageErrorMessage,
  workspaceImageDataUrl,
  WORKSPACE_IMAGE_ERRORS,
} = contracts;

/**
 * Bilder aus dem Arbeitsordner in einer Chat-Antwort (Issue #244).
 *
 * Das Markdown des Modells bringt `<img src="…">` mit, die Bytes liegen aber
 * im Workspace und damit außerhalb des App-Origins. Geladen wird deshalb per
 * IPC und als `data:`-URI gesetzt — die CSP bleibt, wie sie ist.
 *
 * Aufgelöst wird **nach** dem Sanitizing auf den fertigen Knoten im DOM, nie
 * per String-Ersetzung im HTML: DOMPurify läuft damit unverändert zuerst, und
 * was hier ankommt, ist bereits ein bereinigter Baum.
 */

/**
 * Bildrahmen mit Strich — dasselbe Zeichen wie beim verschwundenen Anhang aus
 * #94, damit „hier stand ein Bild“ überall gleich aussieht.
 */
const PLACEHOLDER_ICON_HTML =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" '
  + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round">'
  + '<rect x="3" y="4.5" width="18" height="15" rx="2"/>'
  + '<path d="M3.5 16.5 8.5 11l3.5 3.5"/><circle cx="15.5" cy="9" r="1.4"/></svg>';

/** Grund für Bildquellen, die gar nicht erst gegen den Workspace laufen. */
const EXTERNAL_SOURCE_MESSAGE = 'Nur Bilder aus dem Arbeitsordner werden angezeigt';

/**
 * Einmal geholte Bilder bleiben liegen: Ein erneut gerenderter Verlauf soll
 * nicht jedes Bild wieder über IPC ziehen. Der Schlüssel trägt den Workspace
 * mit — wird ein Verlauf in einem anderen Ordner geöffnet, gilt der Eintrag
 * des alten Ordners nicht, weil relative Pfade dort etwas anderes meinen.
 */
const cache = new Map();

/**
 * Obergrenze des Caches. Base64 kostet ein Drittel mehr als die Datei, und bei
 * 10 MB je Bild wäre ein unbegrenzter Cache in einem langen Verlauf kein
 * Zwischenspeicher mehr, sondern ein Leck. Verdrängt wird der älteste Eintrag
 * (Map hält die Einfügereihenfolge) — ein erneutes Rendern holt ihn wieder.
 */
const MAX_CACHE_ENTRIES = 24;

function cacheKey(workspaceRoot, src) {
  // JSON statt Verkettung: So kann kein Pfad die Trennstelle nachbilden.
  return JSON.stringify([workspaceRoot || '', src]);
}

function rememberResult(key, entry) {
  cache.set(key, entry);
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * Cache leeren. Der Aufrufer weiß, wann sich etwas geändert haben kann — ein
 * überschriebenes Bild trägt seinen neuen Inhalt nicht im Pfad.
 */
export function clearWorkspaceImageCache() {
  cache.clear();
}

function placeholderFor(altText, message) {
  const box = document.createElement('span');
  box.className = 'chat-md-image chat-md-image--placeholder';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', altText ? `${altText}: ${message}` : message);

  const icon = document.createElement('span');
  icon.className = 'chat-md-image-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = PLACEHOLDER_ICON_HTML;
  box.appendChild(icon);

  const text = document.createElement('span');
  text.className = 'chat-md-image-text';
  if (altText) {
    const alt = document.createElement('span');
    alt.className = 'chat-md-image-alt';
    alt.textContent = altText;
    text.appendChild(alt);
  }
  const reason = document.createElement('span');
  reason.className = 'chat-md-image-reason';
  reason.textContent = message;
  text.appendChild(reason);
  box.appendChild(text);
  return box;
}

/**
 * Ruhiger Platzhalter, solange die Nachricht noch läuft. Während des Streams
 * wird pro Animation-Frame das gesamte `innerHTML` neu gesetzt — ein sofort
 * aufgelöstes Bild ergäbe einen Ladevorgang je Frame samt Flackern, und ein
 * halb angekommenes `![Diagramm](diagr` wanderte unterwegs von Text zu Bild.
 */
function pendingFor(altText) {
  const box = placeholderFor(altText, 'Bild erscheint nach der Antwort');
  box.classList.remove('chat-md-image--placeholder');
  box.classList.add('chat-md-image--pending');
  return box;
}

function markLoaded(img, dataUrl) {
  img.classList.add('chat-md-image-img');
  // Das Dekodieren soll den Frame nicht aufhalten; der Verlauf scrollt sonst
  // spürbar später.
  img.setAttribute('decoding', 'async');
  img.src = dataUrl;
}

async function resolveOne(img, { api, workspaceRoot }) {
  // Markdown liefert eine URL, kein Dateipfad — zurueck in den Pfad, den das
  // Modell geschrieben hat (Backslashes, Umlaute, Leerzeichen).
  const src = decodeWorkspaceImageSource(img.getAttribute('src'));
  const altText = img.getAttribute('alt') || '';

  if (!isWorkspaceImageSource(src)) {
    // `data:` trägt seine Bytes selbst und ist per CSP erlaubt — das bleibt
    // stehen. Alles andere (http(s), file://) lädt unter dieser CSP nichts;
    // statt eines kaputten Bildes steht dort, warum.
    if (/^data:image\//i.test(src.trim())) return;
    img.replaceWith(placeholderFor(altText, EXTERNAL_SOURCE_MESSAGE));
    return;
  }

  const key = cacheKey(workspaceRoot, src);
  let entry = cache.get(key);
  if (!entry) {
    if (typeof api?.readWorkspaceImage !== 'function') {
      img.replaceWith(
        placeholderFor(altText, workspaceImageErrorMessage(WORKSPACE_IMAGE_ERRORS.NOT_FOUND))
      );
      return;
    }
    let result = null;
    try {
      result = await api.readWorkspaceImage(src);
    } catch {
      result = null;
    }
    entry = result?.ok
      ? { dataUrl: workspaceImageDataUrl(result) }
      : { message: workspaceImageErrorMessage(result?.reason) };
    rememberResult(key, entry);
  }

  // Zwischen Anfrage und Antwort kann der Verlauf neu gezeichnet worden sein —
  // dann hängt dieser Knoten an keinem Dokument mehr und wird nicht angefasst.
  if (!img.isConnected) return;
  if (entry.dataUrl) markLoaded(img, entry.dataUrl);
  else img.replaceWith(placeholderFor(altText, entry.message));
}

/**
 * Alle Bilder eines gerenderten Antwort-Knotens auflösen.
 *
 * @param {Element|null} container Der Knoten mit dem frisch gesetzten HTML.
 * @param {{ api: object, workspaceRoot: string|null, streaming?: boolean }} options
 * @returns {Promise<void>} Erfüllt, wenn über jedes Bild entschieden ist.
 */
export function applyWorkspaceImages(container, { api, workspaceRoot, streaming = false } = {}) {
  if (!container) return Promise.resolve();
  const images = [...container.querySelectorAll('img')];
  if (images.length === 0) return Promise.resolve();
  if (streaming) {
    for (const img of images) img.replaceWith(pendingFor(img.getAttribute('alt') || ''));
    return Promise.resolve();
  }
  return Promise.all(images.map((img) => resolveOne(img, { api, workspaceRoot })))
    .then(() => undefined);
}
