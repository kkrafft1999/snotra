'use strict';

/**
 * The tokenizer profile of the model a new chat would use (#1219). The
 * settings estimate what each tool's schema costs with its divisor, as the
 * chat's context breakdown does for a round (#178, #996) — so the two give
 * the same figure for the same tool.
 *
 * @param {Pick<import('../ports/llm-port').LlmPort, 'resolveChatTarget' | 'prepareSendBundle'>} llm
 * @returns {() => Promise<string | undefined>}
 */
function createActiveTokenizerProfile(llm) {
  return async function activeTokenizerProfile() {
    try {
      const target = await llm.resolveChatTarget();
      // No model set up, or one whose provider is gone: nothing to ask.
      if (!('providerId' in target)) return undefined;
      return (await llm.prepareSendBundle(target))?.traits?.tokenizerProfile;
    } catch {
      // A connection that cannot be read leaves the default profile, which
      // still gives the settings a figure.
      return undefined;
    }
  };
}

module.exports = { createActiveTokenizerProfile };
