'use strict';

/**
 * Zugriff auf Shell und Zwischenablage (Issue #64).
 *
 * Das Hauptfenster laeuft mit `sandbox: true`. In einem sandboxed Preload
 * liefert `require('electron')` nur contextBridge, crashReporter, ipcRenderer,
 * nativeImage, sharedTexture, webFrame und webUtils — `shell` und `clipboard`
 * sind dort `undefined`. Ein direkter Aufruf im Preload wirft deshalb still
 * einen TypeError, und der Nutzer sieht nur, dass nichts passiert. Beides
 * gehoert darum in den Main-Prozess.
 */

/** Groesstes Textstueck, das in die Zwischenablage darf (Issue #83). */
const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;

/**
 * Web-Links und E-Mail-Adressen; alles andere (file:, javascript:, …) wird
 * abgewiesen. `mailto:` ist erlaubt, weil der Markdown-Sanitizer im Renderer
 * solche Links stehen laesst (Issue #82) — dann muss die Kette dahinter sie
 * auch oeffnen koennen.
 *
 * Bei `mailto:` zusaetzlich streng: keine Zeilenumbrueche, auch nicht
 * prozentkodiert. Sonst liesse sich ueber `%0A` ein zweiter Header (Bcc, …)
 * in die vorbereitete Mail schmuggeln.
 */
function isOpenableUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true;
    if (parsed.protocol !== 'mailto:') return false;
    if (!parsed.pathname.trim()) return false;
    return !/[\u0000-\u001f\u007f]/.test(trimmed) && !/%0[ad]/i.test(trimmed);
  } catch {
    return false;
  }
}

function registerShellHandlers({ ipcMain, shell, clipboard = null, REQ }) {
  ipcMain.handle(REQ.SHELL_OPEN_EXTERNAL, async (_event, url) => {
    if (!isOpenableUrl(url)) {
      return { ok: false, error: 'Nur http-, https- und mailto-Links können geöffnet werden.' };
    }
    try {
      await shell.openExternal(url.trim());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Link konnte nicht geöffnet werden.' };
    }
  });

  ipcMain.handle(REQ.SHELL_WRITE_CLIPBOARD_TEXT, async (_event, text) => {
    if (!clipboard) return { ok: false, error: 'Zwischenablage nicht verfügbar.' };
    const value = String(text ?? '');
    if (Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES) {
      return { ok: false, error: 'Text ist zu groß für die Zwischenablage.' };
    }
    try {
      // Ab Electron 44 liefert `writeText` ein Promise (Angleichung an die
      // W3C-Clipboard-API). Ohne `await` liefe ein Fehler am catch vorbei und
      // wir meldeten Erfolg, obwohl nichts in der Zwischenablage landete.
      await clipboard.writeText(value);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Konnte nichts in die Zwischenablage legen.' };
    }
  });
}

module.exports = { registerShellHandlers, isOpenableUrl, MAX_CLIPBOARD_TEXT_BYTES };
