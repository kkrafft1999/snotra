/**
 * Persistenz der LLM-/Provider-Konfiguration (ohne Chat-Verlauf/UI-Prefs).
 *
 * The configuration document. Only the fields the composition root and the
 * chat settings read are named; the rest is settled by the storage service.
 *
 * @typedef {{
 *   activePresetId?: string|null,
 *   defaultPresetId?: string|null,
 *   presetAliases?: Record<string, { presetId?: unknown, reasoningEffort?: unknown }>,
 *   [field: string]: any,
 * }} LlmConfigDocument
 *
 * @typedef {Object} LlmConfigStorePort
 * @property {() => Promise<LlmConfigDocument>} readLLMConfig
 * @property {(config: object) => Promise<void>} [writeLLMConfig]
 * @property {(updater: (config: LlmConfigDocument) => LlmConfigDocument|Promise<LlmConfigDocument>) => Promise<object>} updateLLMConfig
 * @property {(llmConfig: object) => { providerId: string, model?: string, presetId?: string,
 *   providerOptions?: Object<string, unknown> }} resolveChatModelTarget
 *   the active entry, or the active provider when no entry is active
 * @property {(raw: unknown) => import('../../shared/contracts/settings').PresetWire|null} normalizePresetEntry
 */

module.exports = {};
