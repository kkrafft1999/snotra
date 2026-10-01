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

const { createMessage } = require('../../shared/contracts/message');

/** Groesstes Textstueck, das in die Zwischenablage darf (Issue #83). */
const MAX_CLIPBOARD_TEXT_BYTES = 1024 * 1024;

// One predicate with the renderer's sanitizer (CR-B11-09), see the contract.
const { isOpenableUrl } = require('../../shared/contracts/links');

function registerShellHandlers({ ipcMain, shell, clipboard = null, REQ }) {
  ipcMain.handle(REQ.SHELL_OPEN_EXTERNAL, async (_event, url) => {
    if (!isOpenableUrl(url)) {
      return { ok: false, error: createMessage('shell.error.protocolNotAllowed') };
    }
    try {
      await shell.openExternal(url.trim());
      return { ok: true };
    } catch (e) {
      // What the operating system says is quoted as it stands; our own
      // sentences travel as keys and are worded where they are shown (#353).
      return { ok: false, error: e?.message || createMessage('chat.link.error.failed') };
    }
  });

  ipcMain.handle(REQ.SHELL_WRITE_CLIPBOARD_TEXT, async (_event, text) => {
    if (!clipboard) return { ok: false, error: createMessage('shell.error.clipboardUnavailable') };
    const value = String(text ?? '');
    if (Buffer.byteLength(value, 'utf8') > MAX_CLIPBOARD_TEXT_BYTES) {
      return { ok: false, error: createMessage('shell.error.clipboardTooLarge') };
    }
    try {
      // Ab Electron 44 liefert `writeText` ein Promise (Angleichung an die
      // W3C-Clipboard-API). Ohne `await` liefe ein Fehler am catch vorbei und
      // wir meldeten Erfolg, obwohl nichts in der Zwischenablage landete.
      await clipboard.writeText(value);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || createMessage('shell.error.clipboardFailed') };
    }
  });
}

module.exports = { registerShellHandlers, isOpenableUrl, MAX_CLIPBOARD_TEXT_BYTES };
