/**
 * Provider-Katalog: Metadaten und Präsentation ohne Streaming/Netzwerk.
 *
 * @typedef {Object} ProviderCatalogEntry
 * @property {string} id
 * @property {string} name
 * @property {string} [defaultModel]
 * @property {string} [defaultBaseUrl]
 * @property {boolean} [defaultInsecureTls]
 * @property {{ apiKey?: boolean, baseUrl?: boolean, insecureTls?: boolean }} [fields]
 * @property {import('./provider-runtime-port').ProviderPresentation} [presentation]
 * @property {string} [apiBase]
 *
 * @typedef {Object} ProviderCatalogPort
 * @property {(id: string) => ProviderCatalogEntry|null} getProvider
 * @property {() => Array<ProviderCatalogEntry & { fields: object }>} listProviderMeta
 * @property {(id: string) => boolean} exists
 */

module.exports = {};
