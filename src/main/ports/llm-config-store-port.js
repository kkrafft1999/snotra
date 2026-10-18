/**
 * Persistenz der LLM-/Provider-Konfiguration (ohne Chat-Verlauf/UI-Prefs).
 *
 * @typedef {Object} LlmConfigStorePort
 * @property {() => Promise<object>} readLLMConfig
 * @property {(config: object) => Promise<void>} [writeLLMConfig]
 * @property {(updater: (config: object) => object|Promise<object>) => Promise<object>} updateLLMConfig
 * @property {(llmConfig: object) => { providerId: string, model?: string, presetId?: string,
 *   providerOptions?: Object<string, unknown> }} resolveChatModelTarget
 *   the active entry, or the active provider when no entry is active
 * @property {(raw: object) => object|null} normalizePresetEntry
 */

module.exports = {};
