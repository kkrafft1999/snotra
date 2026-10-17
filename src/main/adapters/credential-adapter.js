'use strict';

/**
 * @returns {import('../ports/credential-port').CredentialPort}
 */
function createCredentialAdapter({ providerSecrets }) {
  return {
    async getApiKey(providerId) {
      const cfg = await providerSecrets.getEffectiveProviderConfig(providerId);
      return cfg?.apiKey || null;
    },
  };
}

module.exports = {
  createCredentialAdapter,
};
