'use strict';

// The user-confirmation port as the composition root wires it (#980): one
// receipt registry, the native adapter over a fake dialog issuing from it,
// the policy store redeeming from it.

const { createConfirmationReceipts } = require('../../src/application/permissions/user-confirmation');
const { createNativeConfirmationAdapter } = require('../../src/main/adapters/native-confirmation-adapter');

function createTestConfirmations({ dialog = null, getMainWindow = () => null } = {}) {
  const receipts = createConfirmationReceipts();
  return {
    confirmations: createNativeConfirmationAdapter({ dialog, getMainWindow, receipts: { issue: receipts.issue } }),
    /** For `createToolPolicyStore({ confirmationReceipts })`. */
    storeReceipts: { redeem: receipts.redeem },
    /** Store options carrying a receipt, as if the user had confirmed — for seeding state. */
    confirmed: (action, subject = '') => ({ confirmation: receipts.issue({ action, subject }) }),
  };
}

module.exports = { createTestConfirmations };
