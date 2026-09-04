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

/** Nur echte Web-Links; alles andere (file:, javascript:, …) wird abgewiesen. */
function isOpenableUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function registerShellHandlers({ ipcMain, shell, clipboard = null, REQ }) {
  ipcMain.handle(REQ.SHELL_OPEN_EXTERNAL, async (_event, url) => {
    if (!isOpenableUrl(url)) {
      return { ok: false, error: 'Nur http- und https-Links können geöffnet werden.' };
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
    try {
      clipboard.writeText(String(text ?? ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || 'Konnte nichts in die Zwischenablage legen.' };
    }
  });
}

module.exports = { registerShellHandlers, isOpenableUrl };
