'use strict';

/**
 * @param {{ getEffectiveProviderConfig: import('../ports/provider-secrets-port').ProviderSecretsPort['getEffectiveProviderConfig'] }} storage
 * @returns {import('../ports/provider-secrets-port').ProviderSecretsPort}
 */
function createProviderSecretsPort(storage) {
  return {
    getEffectiveProviderConfig: (...args) => storage.getEffectiveProviderConfig(...args),
  };
}

module.exports = {
  createProviderSecretsPort,
};
