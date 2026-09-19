/**
 * Chat-Modell-Ziel (provider-unabhängiger Contract).
 *
 * providerOptions enthält provider-spezifische Preset-Optionen (z. B.
 * reasoningEffort). Der Anwendungs-Core behandelt das Objekt als opaque;
 * der LLM-Adapter interpretiert und merged es in die Provider-Konfiguration.
 *
 * `presetId` benennt den Eintrag, aus dem das Ziel stammt. Bei Anbietern, deren
 * Verbindung am Eintrag hängt statt am Anbieter (Issue #202), ist er die
 * einzige Angabe, mit der sich Server-URL und Schlüssel auflösen lassen.
 * Bewusst nur die Kennung: Das Ziel geht als DTO bis in den Renderer, und
 * Geheimnisse haben dort nichts zu suchen.
 */
'use strict';

/**
 * @typedef {Record<string, unknown>} ProviderOptions
 */

/**
 * @typedef {Object} ChatModelTarget
 * @property {string} providerId
 * @property {string} model
 * @property {string} [presetId]
 * @property {ProviderOptions} [providerOptions]
 */

/**
 * @param {{ providerId: string, model: string, presetId?: string, providerOptions?: ProviderOptions }} params
 * @returns {ChatModelTarget}
 */
function createChatModelTarget({ providerId, model, presetId, providerOptions }) {
  const out = {
    providerId: String(providerId ?? ''),
    model: String(model ?? ''),
  };
  if (typeof presetId === 'string' && presetId.trim()) {
    out.presetId = presetId.trim();
  }
  if (providerOptions && typeof providerOptions === 'object' && Object.keys(providerOptions).length > 0) {
    out.providerOptions = { ...providerOptions };
  }
  return out;
}

module.exports = {
  createChatModelTarget,
};
