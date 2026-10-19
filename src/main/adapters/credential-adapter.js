'use strict';

/**
 * @param {Object} deps
 * @param {import('../ports/provider-secrets-port').ProviderSecretsPort} deps.providerSecrets
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
