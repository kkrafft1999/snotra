'use strict';

/**
 * The desktop's user-confirmation adapter (#980): the native message box of
 * the operating system, over the app window when there is one.
 *
 * It is the only adapter with `presence: 'desktop'`. The dialog is drawn by
 * the operating system in the main process, so neither the renderer nor any
 * other front end can answer it — that is what the presence guarantee rests
 * on (docs/security/security-concept.md §5). Without a dialog to show it confirms
 * nothing (`no-presence`), like the refusing implementation of the core.
 */

const { CONFIRMATION_REFUSALS, createConfirmationReceipts } = require('../../application/permissions/user-confirmation');

/**
 * @param {{
 *   dialog?: { showMessageBox: (...args: any[]) => Promise<{ response: number } | undefined> } | null,
 *   getMainWindow?: () => ({ isDestroyed?: () => boolean } | null),
 *   receipts?: { issue: (binding: { action: string, subject?: string }) => object },
 * }} deps  `receipts` is the registry the policy store redeems from; without
 *   it, receipts come from a private one and loosen nothing.
 * @returns {import('../../application/ports/user-confirmation-port').UserConfirmationPort}
 */
function createNativeConfirmationAdapter({ dialog = null, getMainWindow = () => null, receipts = createConfirmationReceipts() }) {
  function canConfirm() {
    return !!dialog && typeof dialog.showMessageBox === 'function';
  }

  /** @param {import('../../application/ports/user-confirmation-port').ConfirmationRequest} request */
  async function confirm({ action, subject = '', prompt, signal }) {
    if (!dialog || !canConfirm()) return { confirmed: false, reason: CONFIRMATION_REFUSALS.NO_PRESENCE };
    if (signal?.aborted) return { confirmed: false, reason: CONFIRMATION_REFUSALS.DECLINED };
    // Cancel is the default and the Escape answer, whatever the caller built:
    // Enter confirms nothing (#59). An aborted `signal` closes the box as
    // cancelled (#1114).
    const options = { ...prompt, defaultId: 1, cancelId: 1, ...(signal ? { signal } : {}) };
    const win = getMainWindow();
    const result = win && !win.isDestroyed?.()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (result?.response !== 0) return { confirmed: false, reason: CONFIRMATION_REFUSALS.DECLINED };
    return { confirmed: true, receipt: receipts.issue({ action, subject }) };
  }

  return { presence: 'desktop', canConfirm, confirm };
}

module.exports = { createNativeConfirmationAdapter };
