'use strict';

/**
 * The window's side of the error path (#978): its global handlers report what
 * nobody caught, and the background-error notice copies the diagnostics.
 * Main decides what is logged and what the clipboard gets; the window only
 * hands over the error.
 *
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {Record<string, string>} deps.REQ
 * @param {ReturnType<typeof import('../services/error-reporter').createErrorReporter>} deps.reporter
 * @param {ReturnType<typeof import('../services/diagnostics').createDiagnostics>} deps.diagnostics
 */
function registerDiagnosticsHandlers({ ipcMain, REQ, reporter, diagnostics }) {
  ipcMain.handle(REQ.DIAGNOSTICS_REPORT_ERROR, async (_event, payload) => ({
    ok: reporter.reportRenderer(payload),
  }));

  ipcMain.handle(REQ.DIAGNOSTICS_COPY, async () => ({ ok: diagnostics.copy() }));
}

module.exports = { registerDiagnosticsHandlers };
