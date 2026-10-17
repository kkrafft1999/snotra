/**
 * Entschlüsselte Provider-Zugangsdaten (narrow secrets surface).
 *
 * @typedef {Object} EffectiveProviderConfig
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {boolean} [insecureTls]
 * @property {string} [model]
 *
 * @typedef {Object} ProviderSecretsPort
 * @property {(providerId: string, scope?: { presetId?: string }) => Promise<EffectiveProviderConfig|null>} getEffectiveProviderConfig
 *   `presetId`: the entry whose own connection applies (#202)
 */

module.exports = {};
