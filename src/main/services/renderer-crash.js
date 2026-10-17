'use strict';

const { createTranslator } = require('../../shared/i18n');

/**
 * When the app window's page dies (#978). Chromium ends a renderer that ran
 * out of memory, crashed or was killed, and the window stays — blank, with
 * nothing to click. The page cannot say anything any more, so main does: a
 * box that names what happened and offers to reload the window or quit.
 *
 * No silent reload: whatever the page held is gone, a reply that was still
 * running among it, and the user should know that before going on.
 *
 * `clean-exit` is a page that ended because the window closed; nothing to say.
 */
function createRendererCrashHandler({
  dialog,
  window,
  app,
  appName = 'Snotra Agent',
  getLocale = () => 'en',
  log = console,
}) {
  let asking = false;

  return async (_event, details = {}) => {
    const reason = String(details?.reason ?? 'unknown');
    if (reason === 'clean-exit') return;
    try {
      log?.error?.(`[window] The window's page is gone (reason: ${reason}, exit code: ${details?.exitCode ?? '?'}).`);
    } catch {
      // The box below matters more than the log line.
    }
    if (asking || !window || window.isDestroyed?.()) return;
    asking = true;
    try {
      const t = createTranslator(getLocale?.() || 'en');
      const { response } = await dialog.showMessageBox(window, {
        type: 'error',
        title: t('app.rendererGone.title'),
        message: t('app.rendererGone.title'),
        detail: t('app.rendererGone.detail', { appName, reason }),
        buttons: [t('app.rendererGone.reload'), t('app.rendererGone.quit', { appName })],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (window.isDestroyed?.()) return;
      if (response === 1) app?.quit?.();
      else window.webContents.reload();
    } catch (error) {
      try {
        log?.error?.('[window] The reload offer could not be shown:', error);
      } catch {
        // Nothing left to tell.
      }
    } finally {
      asking = false;
    }
  };
}

module.exports = { createRendererCrashHandler };
