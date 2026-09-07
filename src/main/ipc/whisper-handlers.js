const { createRequestLifecycle } = require('./request-lifecycle');

function registerWhisperHandlers({ ipcMain, speech, uiPrefsStore, REQ }) {
  const requests = createRequestLifecycle();
  ipcMain.handle(REQ.WHISPER_CANCEL, (event) => requests.cancel(event.sender));
  ipcMain.handle(REQ.WHISPER_TRANSCRIBE, (event, audioBuffer) => requests.run(event.sender, async (signal) => {
    const uiPrefs = await uiPrefsStore.readUIPrefs();
    return speech.transcribeAudio(audioBuffer, { language: uiPrefs.appLocale, signal });
  }));
}

module.exports = { registerWhisperHandlers };
