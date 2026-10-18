'use strict';

/**
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
