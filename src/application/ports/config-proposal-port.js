/**
 * Config-proposal port (#774): what a chat switched for itself, and the way
 * the model asks for a change. The core asks the user on a card through the
 * approval port and records the answer here; it never decides a switch on
 * its own.
 *
 * Where the overrides are kept (the chat's row in the history) and how a
 * proposal is checked against the catalogue is known only to main
 * (`services/chat-session-settings.js`, `services/chat-configuration-service.js`).
 */

/**
 * @typedef {import('../../shared/contracts/chat-configuration').ChatConfigOverrides} ChatConfigOverrides
 */

/**
 * @typedef {Object} ConfigProposal
 * @property {'skill'|'tool'} kind
 * @property {string} name
 * @property {boolean} enable
 * @property {string} [reason]  the model's sentence, shown as its words
 */

/**
 * @typedef {Object} ConfigProposalPort
 * @property {(chatId: string|null) => Promise<ChatConfigOverrides|null>} overridesFor
 *   what the chat switched beyond the settings (`normalizeChatConfigOverrides`)
 * @property {(input: { chatId: string|null, workspaceRoot: string|null, chatSkillNames: string[],
 *   overrides: ChatConfigOverrides|null, proposal: ConfigProposal }) => Promise<{ error: string } | { declined: true } | { card: object }>} prepare
 *   checks a proposal; only `card` may reach the user
 * @property {(chatId: string, proposal: ConfigProposal) => Promise<ChatConfigOverrides|null>} accept
 * @property {(chatId: string, proposal: ConfigProposal) => Promise<ChatConfigOverrides|null>} decline
 */

module.exports = {};
