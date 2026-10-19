'use strict';

/**
 * @typedef {import('../../application/ports/config-proposal-port').ConfigProposalPort} ConfigProposalPort
 */

/**
 * The part of `application/chat/chat-session-settings.js` this adapter calls, written
 * from the consumer's side: that module is not in the checked program.
 * @typedef {Object} ChatSessionSettings
 * @property {ConfigProposalPort['overridesFor']} configOverridesFor
 * @property {ConfigProposalPort['accept']} acceptConfigProposal
 * @property {ConfigProposalPort['decline']} declineConfigProposal
 */

/**
 * What a chat switched for itself, and the card that changes it (#774). The
 * overrides live in the chat's row (`application/chat/chat-session-settings.js`); a
 * proposal is checked against the catalogue by
 * `services/chat-configuration-service.js`. Moved out of the composition root
 * in #1098 so that the type check compares it with the port.
 *
 * @param {{
 *   chatSessionSettings: ChatSessionSettings,
 *   prepareProposal: ConfigProposalPort['prepare'],
 * }} deps  `prepareProposal` is the configuration service's check; a function,
 *   because that service is built after the chat application
 * @returns {import('../../application/ports/config-proposal-port').ConfigProposalPort}
 */
function createConfigProposalAdapter({ chatSessionSettings, prepareProposal }) {
  return {
    overridesFor: (chatId) => chatSessionSettings.configOverridesFor(chatId),
    prepare: (input) => prepareProposal(input),
    accept: (chatId, proposal) => chatSessionSettings.acceptConfigProposal(chatId, proposal),
    decline: (chatId, proposal) => chatSessionSettings.declineConfigProposal(chatId, proposal),
  };
}

module.exports = { createConfigProposalAdapter };
