'use strict';

/**
 * The feedback form's two requests (#1045): the diagnostics it shows, and the
 * message it sends. The window names the provider of the chat on screen; main
 * decides whether that name may go out and sends the request itself.
 *
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {ReturnType<typeof import('../services/feedback-service').createFeedbackService>} deps.feedback
 * @param {Record<string, string>} deps.REQ
 */
function registerFeedbackHandlers({ ipcMain, feedback, REQ }) {
  ipcMain.handle(REQ.FEEDBACK_GET_DIAGNOSTICS, async (_event, providerId) =>
    feedback.getDiagnostics(typeof providerId === 'string' ? providerId : ''));

  ipcMain.handle(REQ.FEEDBACK_SEND, async (_event, payload) => feedback.send(payload));
}

module.exports = { registerFeedbackHandlers };
