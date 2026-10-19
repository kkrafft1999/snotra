/**
 * Provider-Katalog: Metadaten und Präsentation ohne Streaming/Netzwerk.
 *
 * @typedef {Object} ProviderCatalogEntry
 * @property {string} id
 * @property {import('./provider-runtime-port').ProviderText} name
 * @property {string} [defaultModel]
 * @property {string} [defaultBaseUrl]
 * @property {boolean} [defaultInsecureTls]
 * @property {'chat'|'full'} [defaultApiStyle]
 * @property {boolean} [defaultSupportsImages]
 * @property {boolean} [defaultSendTools]
 * @property {import('./provider-runtime-port').ProviderFields} fields
 * @property {import('./provider-runtime-port').ProviderPresentation} [presentation]
 * @property {string} [apiBase]
 * @property {Object<string, import('./provider-runtime-port').ProviderCapabilityDeclaration>} [capabilities]
 * @property {boolean} [optionalApiKey]
 * @property {boolean} [connectionPerPreset]
 * @property {import('../../shared/contracts/reasoning').ReasoningDeclaration} [reasoning]
 *
 * @typedef {Object} ProviderCatalogPort
 * @property {(id: string) => ProviderCatalogEntry|null} getProvider
 * @property {() => ProviderCatalogEntry[]} listProviderMeta
 * @property {(id: string) => boolean} exists
 */

module.exports = {};
