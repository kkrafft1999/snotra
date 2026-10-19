/**
 * Entschlüsselte Provider-Zugangsdaten (narrow secrets surface).
 *
 * @typedef {Object} EffectiveProviderConfig
 * @property {string} [apiKey]
 * @property {string} [baseUrl]
 * @property {boolean} [insecureTls]
 * @property {string} [model]
 * @property {string} [displayName]      "OpenAI-compatible": the name the entry shows
 * @property {string} [apiStyle]         "OpenAI-compatible": `chat` or `full`
 * @property {string} [extraHeaders]     decrypted, one `Name: value` per line
 * @property {boolean} [supportsImages]
 * @property {boolean} [sendTools]
 * @property {number} [maxOutputTokens]  only where the provider declares the field (#931)
 *
 * @typedef {Object} ProviderSecretsPort
 * @property {(providerId: string, scope?: { presetId?: string }) => Promise<EffectiveProviderConfig|null>} getEffectiveProviderConfig
 *   `presetId`: the entry whose own connection applies (#202)
 */

module.exports = {};
