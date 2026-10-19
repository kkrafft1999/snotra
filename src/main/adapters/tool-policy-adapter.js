'use strict';

const { createHash } = require('node:crypto');
const {
  normalizeToolPermissionMode,
  isCommandRule,
  TOOL_POLICY_INTEGRITY: INTEGRITY,
} = require('../../shared/contracts/tool-permissions');

/**
 * What the policy store hands back, written from the consumer's side:
 * `tool-policy-store.js` is not in the checked program (#1098). `integrity`
 * is a plain string here, since the store also reports `unreadable`.
 * @typedef {Omit<import('../../application/ports/tool-policy-port').ToolPolicySnapshot, 'integrity'|'rulesVersion'> & { integrity: string }} ToolPolicyState
 */

/**
 * The permission state for one run (#66, concept §7), read from the signed
 * policy store. Moved out of the composition root in #1098 so that the type
 * check compares it with the port.
 *
 * @param {{
 *   toolPolicyStore: { read: () => Promise<ToolPolicyState> },
 *   resolveChatMode?: (chatId: string) => string|null,
 * }} deps  `resolveChatMode` gives the mode of a chat that is running in the
 *   background (#320); `null` means "the store's mode applies"
 * @returns {import('../../application/ports/tool-policy-port').ToolPolicyPort}
 */
function createToolPolicyAdapter({ toolPolicyStore, resolveChatMode = () => null }) {
  return {
    async read({ chatId = null } = {}) {
      const state = await toolPolicyStore.read();
      // A rules file that cannot be read grants nothing and blocks
      // nothing; the engine stops tools on a throw (concept §3, #512).
      if (state.integrity === INTEGRITY.UNREADABLE) throw new Error('The permission rules could not be read.');
      return {
        mode: modeForRun(state, chatId, resolveChatMode),
        rules: state.rules,
        sensitivePathPatterns: state.sensitivePathPatterns,
        policyVersion: state.policyVersion,
        rulesVersion: rulesVersionOf(state),
        // `unreadable` threw above, so what is left is the port's union.
        integrity: /** @type {import('../../application/ports/tool-policy-port').ToolPolicySnapshot['integrity']} */ (state.integrity),
        encryptionAvailable: state.encryptionAvailable,
        // Hosts kept open per workspace (#946) and in every workspace
        // (#1119); not part of the rules version, so keeping one costs
        // no chat its approvals.
        workspaceHosts: state.workspaceHosts,
        globalHosts: state.globalHosts,
      };
    },
  };
}

/**
 * A remembered chat mode only counts while the policy file is intact. On a
 * failed signature the store falls back to `smart` (concept §7), and a chat in
 * the background must not keep a looser mode past that.
 */
function modeForRun(state, chatId, resolveChatMode) {
  if (state.integrity !== 'ok' && state.integrity !== 'missing') return state.mode;
  if (!chatId) return state.mode;
  let remembered = null;
  try {
    remembered = resolveChatMode(chatId);
  } catch {
    remembered = null;
  }
  return normalizeToolPermissionMode(remembered || state.mode);
}

/**
 * Everything a session approval depends on apart from the mode: the rules, the
 * sensitive path patterns and the integrity state. The store's
 * `policyVersion` also moves when only the mode is written — which now happens
 * whenever another chat comes on screen (#320).
 */
function rulesVersionOf(state) {
  const hash = createHash('sha256');
  // Command rules (#121) are left out: they allow one `shell_execute` line,
  // which no session approval can cover, so remembering a command must not
  // cost the user the approvals of the chats that are open.
  const rules = (Array.isArray(state.rules) ? state.rules : []).filter((rule) => !isCommandRule(rule));
  hash.update(JSON.stringify([state.integrity, rules, state.sensitivePathPatterns]));
  return hash.digest('hex').slice(0, 32);
}

module.exports = { createToolPolicyAdapter };
