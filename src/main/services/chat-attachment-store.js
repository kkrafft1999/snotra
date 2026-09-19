'use strict';

/**
 * Ablage der Bild-Anhaenge eines Chats (Issue #94).
 *
 * Die Verlaufsdatei bleibt schlank: sie traegt je Anhang nur den Dateinamen,
 * die Bilddaten liegen daneben unter `chat-attachments/<chat>/<hash>.<ext>` im
 * userData-Verzeichnis. Vier Screenshots in einer Nachricht kosten die
 * Session-JSON damit ein paar Dutzend Zeichen statt mehrerer Megabyte.
 *
 * Der Dateiname ist der SHA-256 des Bildinhalts. Das macht das Schreiben
 * wiederholbar — der Renderer schickt beim Sichern jeder Runde dieselbe
 * Nachricht erneut mit, und derselbe Inhalt landet immer unter demselben
 * Namen, statt den Ordner mit Kopien zu fuellen.
 *
 * Alles, was von aussen kommt (Chat-ID aus dem Renderer, Dateiname aus der
 * Verlaufsdatei), wird vor dem Zusammensetzen eines Pfades geprueft: der Ordner
 * darf nur Anhaenge enthalten, und nichts darf aus ihm herausfuehren.
 */

const { createHash, randomUUID } = require('crypto');
const { LIMITS } = require('../../shared/limits');
const {
  ATTACHMENT_KINDS,
  attachmentFileExtension,
  attachmentMediaTypeForFile,
  isAttachmentFileName,
  normalizeImageAttachment,
  normalizeStoredAttachment,
} = require('../../shared/contracts/attachments');

const ATTACHMENTS_DIRNAME = 'chat-attachments';

/** Chat-IDs sind UUIDs aus dem Renderer; das hier ist die harmlose Teilmenge. */
const SAFE_CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

function createChatAttachmentStore({ app, fs, path, log = console }) {
  function rootDir() {
    return path.join(app.getPath('userData'), ATTACHMENTS_DIRNAME);
  }

  /**
   * Verzeichnisname eines Chats. Eine unauffaellige ID wird unveraendert
   * uebernommen, alles andere bekommt ihren Hash — so kann keine ID mit `/`
   * oder `..` aus dem Anhang-Ordner herausfuehren, ohne dass deswegen Bilder
   * verloren gingen.
   */
  function chatDirName(chatId) {
    const raw = typeof chatId === 'string' ? chatId.trim() : '';
    if (!raw) return '';
    if (raw !== '.' && raw !== '..' && SAFE_CHAT_ID_RE.test(raw)) return raw;
    return createHash('sha256').update(raw).digest('hex').slice(0, 32);
  }

  function chatDir(chatId) {
    const name = chatDirName(chatId);
    return name ? path.join(rootDir(), name) : '';
  }

  /** Schreibt ein Bild unter seinem Inhalts-Hash und liefert die Referenz. */
  async function writeImage(dir, attachment) {
    const ext = attachmentFileExtension(attachment.mediaType);
    if (!ext) return null;
    const buf = Buffer.from(attachment.dataBase64, 'base64');
    if (buf.length === 0 || buf.length > LIMITS.MAX_IMAGE_ATTACHMENT_BYTES) return null;

    const file = `${createHash('sha256').update(buf).digest('hex')}.${ext}`;
    const target = path.join(dir, file);
    let exists = false;
    try {
      exists = (await fs.stat(target)).size === buf.length;
    } catch {
      exists = false;
    }
    if (!exists) {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${target}.tmp-${randomUUID()}`;
      await fs.writeFile(tmp, buf);
      try {
        await fs.rename(tmp, target);
      } catch (err) {
        await fs.unlink(tmp).catch(() => {});
        throw err;
      }
    }

    const ref = { kind: ATTACHMENT_KINDS.IMAGE, mediaType: attachment.mediaType, file, bytes: buf.length };
    if (attachment.name) ref.name = attachment.name;
    return ref;
  }

  /**
   * Ein Anhang in Ablage-Form. Liegen Bilddaten bei, werden sie geschrieben —
   * auch wenn schon eine Referenz dransteht: das Schreiben ist ohnehin
   * wiederholbar und heilt nebenbei eine Referenz auf eine verschwundene Datei.
   */
  async function toStoredRef(dir, raw) {
    const withData = normalizeImageAttachment(raw);
    if (withData) {
      try {
        const ref = await writeImage(dir, withData);
        if (ref) return ref;
      } catch (err) {
        log?.warn?.(`[chat-attachments] Bild nicht gespeichert: ${err?.message || err}`);
      }
    }
    return normalizeStoredAttachment(raw);
  }

  /**
   * Legt die Anhaenge aller Nachrichten einer Session ab und liefert die
   * Nachrichten mit Referenzen statt Bilddaten zurueck. Nachrichten ohne
   * Anhang bleiben unangetastet.
   */
  async function persistMessages(chatId, messages) {
    if (!Array.isArray(messages)) return messages;
    const dir = chatDir(chatId);
    if (!dir) return messages;

    const out = [];
    for (const message of messages) {
      const list = Array.isArray(message?.attachments) ? message.attachments : null;
      if (!list || list.length === 0) {
        out.push(message);
        continue;
      }
      const refs = [];
      for (const raw of list.slice(0, LIMITS.MAX_IMAGES_PER_MESSAGE)) {
        const ref = await toStoredRef(dir, raw);
        if (ref) refs.push(ref);
      }
      out.push({ ...message, attachments: refs });
    }
    return out;
  }

  /**
   * Liest ein abgelegtes Bild fuer die Anzeige. Eine fehlende Datei ist kein
   * Fehler, sondern `{ ok: false }` — der Renderer zeigt dann einen Platzhalter.
   */
  async function readAttachment(chatId, file) {
    const dir = chatDir(chatId);
    if (!dir || !isAttachmentFileName(file)) return { ok: false };
    const mediaType = attachmentMediaTypeForFile(file);
    if (!mediaType) return { ok: false };

    const target = path.join(dir, file);
    // Der Name ist bereits auf Hash + Endung eingeschraenkt; der Pfadvergleich
    // steht als zweite Schranke daneben und kostet nichts.
    if (path.dirname(target) !== dir) return { ok: false };
    try {
      const buf = await fs.readFile(target);
      if (!buf || buf.length === 0 || buf.length > LIMITS.MAX_IMAGE_ATTACHMENT_BYTES) return { ok: false };
      return { ok: true, mediaType, dataBase64: buf.toString('base64') };
    } catch {
      return { ok: false };
    }
  }

  /** Bilder eines geloeschten Chats mit entfernen. */
  async function deleteChat(chatId) {
    const dir = chatDir(chatId);
    if (!dir) return;
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch (err) {
      log?.warn?.(`[chat-attachments] Ordner nicht geloescht: ${err?.message || err}`);
    }
  }

  /**
   * Raeumt alles weg, wozu es keine Session mehr gibt: aus dem Verlauf
   * gefallene Chats (MAX_CHAT_SESSIONS), geloeschte Chats und Reste aus einer
   * in Quarantaene gestellten Verlaufsdatei.
   */
  async function pruneChats(keepIds) {
    const keep = new Set();
    for (const id of Array.isArray(keepIds) ? keepIds : []) {
      const name = chatDirName(id);
      if (name) keep.add(name);
    }
    let entries;
    try {
      entries = await fs.readdir(rootDir(), { withFileTypes: true });
    } catch {
      return; // Noch kein Anhang abgelegt — nichts aufzuraeumen.
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || keep.has(entry.name)) continue;
      try {
        await fs.rm(path.join(rootDir(), entry.name), { recursive: true, force: true });
      } catch (err) {
        log?.warn?.(`[chat-attachments] Verwaister Ordner blieb liegen: ${err?.message || err}`);
      }
    }
  }

  return { persistMessages, readAttachment, deleteChat, pruneChats };
}

module.exports = { createChatAttachmentStore, ATTACHMENTS_DIRNAME };
