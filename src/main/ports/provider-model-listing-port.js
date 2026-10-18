/**
 * Modellauflistung über Provider-Laufzeit (Settings-IPC).
 *
 * What the settings dialog sends: the draft connection, and the entry whose
 * stored connection applies (#202). A stored secret only goes to the
 * endpoint it was stored with (#537).
 *
 * @typedef {Object} ProviderModelListRequest
 * @property {string} [presetId]
 * @property {string} [baseUrl]
 * @property {string} [apiKey]
 * @property {boolean} [insecureTls]
 * @property {string} [extraHeaders]
 * @property {AbortSignal} [signal]
 *
 * @typedef {Object} ProviderModelListingPort
 * @property {(providerId: string, request: ProviderModelListRequest) => Promise<{ models?: Array<{ id: string, label?: string }>,
 *   error?: import('../../shared/contracts/message').Message|string }>} listModels
 *   `error` is a message descriptor wherever Snotra says it itself (#308)
 */

module.exports = {};
