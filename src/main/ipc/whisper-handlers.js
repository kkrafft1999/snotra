const { createRequestLifecycle } = require('./request-lifecycle');

/**
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {import('../ports/speech-port').SpeechPort} deps.speech
 * @param {import('../ports/ui-prefs-store-port').UiPrefsStorePort} deps.uiPrefsStore
 * @param {Record<string, string>} deps.REQ
 */
function registerWhisperHandlers({ ipcMain, speech, uiPrefsStore, REQ }) {
  const requests = createRequestLifecycle();
  ipcMain.handle(REQ.WHISPER_CANCEL, (event) => requests.cancel(event.sender));
  ipcMain.handle(REQ.WHISPER_TRANSCRIBE, (event, audioBuffer) => requests.run(event.sender, async (signal) => {
    const uiPrefs = await uiPrefsStore.readUIPrefs();
    return speech.transcribeAudio(audioBuffer, { language: uiPrefs.appLocale, signal });
  }));
}

module.exports = { registerWhisperHandlers };
