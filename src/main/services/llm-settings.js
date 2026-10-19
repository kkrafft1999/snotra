const {
  createSettingsOk,
  createSettingsError,
  isApiStyle,
  hasPresetConnection,
  normalizeBaseUrl,
  normalizeStoredPresetConnection,
  PRESET_CONNECTION_PLAIN_FIELDS,
} = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');

/**
 * The rules of the model configuration (#1006): how a provider's or an
 * entry's connection is merged and encrypted, when an entry is usable, and
 * how the active entry is set. Moved out of `ipc/settings-handlers.js`, so the
 * composition root and a second front end reach them without a handler.
 *
 * @typedef {Pick<import('electron').SafeStorage, 'isEncryptionAvailable' | 'encryptString' | 'decryptString'>} SafeStorageLike
 * @typedef {import('../ports/provider-catalog-port').ProviderCatalogEntry} ProviderMeta
 * @typedef {import('../../shared/contracts/settings').PresetWire} PresetWire
 * @typedef {import('../ports/llm-config-store-port').LlmConfigDocument} LlmConfigDocument
 * @typedef {import('../../shared/contracts/message').Message} Message
 * @typedef {{ ok: false, error: Message|string, code?: string }} SettingsFailure
 * @typedef {import('../../shared/contracts/settings').ProviderPatch} ProviderPatch
 * @typedef {import('../../shared/contracts/settings').PresetConnection} PresetConnection
 * @typedef {import('../../shared/contracts/settings').PresetConnectionPatch} PresetConnectionPatch
 * @typedef {import('./storage-service').JsonObject} StoredEntry  a provider's stored connection, as parsed
 * @typedef {Pick<import('../ports/provider-catalog-port').ProviderCatalogPort, 'getProvider'>} ProviderLookup
 */

/**
 * @param {{ safeStorage: SafeStorageLike, providerCatalog: ProviderLookup }} deps
 * @param {LlmConfigDocument} config
 * @param {string} providerId
 * @param {ProviderPatch|null|undefined} patch
 * @returns {{ ok: true } | SettingsFailure}
 */
function mergeProviderPatchIntoConfig(deps, config, providerId, patch) {
  const { safeStorage, providerCatalog } = deps;
  const provider = providerCatalog.getProvider(providerId);
  if (!provider) return createSettingsError(createMessage('settings.error.provider.unknown'));
  // With a connection per entry (#202) none of this belongs under
  // `providers`. The payload comes from the renderer and is not believed: a
  // provider connection here would be migrated away on the next read anyway,
  // and until then be a second, competing truth.
  if (hasPresetConnection(provider)) return createSettingsOk();
  const prevEntry = (config.providers && config.providers[providerId]) || {};
  const next = { ...prevEntry };

  if (provider.fields?.apiKey) {
    if (patch?.removeApiKey === true) {
      delete next.apiKeyEnc;
    }
    const incomingKey = typeof patch?.apiKey === 'string' ? patch.apiKey.trim() : '';
    if (incomingKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        return createSettingsError(createMessage('settings.error.encryptionUnavailable'));
      }
      next.apiKeyEnc = safeStorage.encryptString(incomingKey).toString('base64');
    }
  }

  if (provider.fields?.baseUrl && typeof patch?.baseUrl === 'string' && patch.baseUrl.trim()) {
    next.baseUrl = patch.baseUrl.trim();
  }

  if (provider.fields?.insecureTls && typeof patch?.insecureTls === 'boolean') {
    next.insecureTls = patch.insecureTls;
  }

  // Fields of the "OpenAI-compatible" provider (#193).
  if (provider.fields?.displayName && typeof patch?.displayName === 'string') {
    const name = patch.displayName.trim();
    if (name) next.displayName = name;
    else delete next.displayName;
  }

  if (provider.fields?.apiStyle && isApiStyle(patch?.apiStyle)) {
    next.apiStyle = patch.apiStyle;
  }

  if (provider.fields?.extraHeaders) {
    if (patch?.removeExtraHeaders === true) {
      delete next.extraHeadersEnc;
    }
    const incomingHeaders = typeof patch?.extraHeaders === 'string' ? patch.extraHeaders.trim() : '';
    if (incomingHeaders) {
      // Extra headers can carry a gateway token and are treated like the API
      // key: they reach the disk encrypted or not at all.
      if (!safeStorage.isEncryptionAvailable()) {
        return createSettingsError(createMessage('settings.error.encryptionUnavailable'));
      }
      next.extraHeadersEnc = safeStorage.encryptString(incomingHeaders).toString('base64');
    }
  }

  if (provider.fields?.supportsImages && typeof patch?.supportsImages === 'boolean') {
    next.supportsImages = patch.supportsImages;
  }

  if (provider.fields?.sendTools && typeof patch?.sendTools === 'boolean') {
    next.sendTools = patch.sendTools;
  }

  config.providers = config.providers || {};
  config.providers[providerId] = next;
  return createSettingsOk();
}

/**
 * Does a save bring a key or headers to encrypt (#1060)?
 *
 * @param {Record<string, ProviderPatch>} providerPatches
 * @param {Map<string, PresetConnectionPatch>} connectionPatches
 */
function carriesSecret(providerPatches, connectionPatches) {
  /** @type {Array<'apiKey' | 'extraHeaders'>} */
  const secretFields = ['apiKey', 'extraHeaders'];
  const brings = (/** @type {ProviderPatch | PresetConnectionPatch | undefined} */ draft) => secretFields.some(
    (field) => typeof draft?.[field] === 'string' && draft[field].trim().length > 0
  );
  return Object.values(providerPatches).some(brings) || [...connectionPatches.values()].some(brings);
}

/**
 * @template {object} T
 * @param {T} config
 * @returns {T}
 */
function cloneLlmConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

/**
 * Can the current safeStorage key read a stored key? The plaintext is dropped
 * at once; only whether it decrypts counts.
 *
 * @param {Pick<SafeStorageLike, 'isEncryptionAvailable' | 'decryptString'>|null|undefined} safeStorage
 * @param {string|null|undefined} apiKeyEnc
 * @returns {boolean}
 */
function canDecryptApiKeyEnc(safeStorage, apiKeyEnc) {
  if (!apiKeyEnc || typeof safeStorage?.decryptString !== 'function') return false;
  if (!safeStorage.isEncryptionAvailable()) return false;
  try {
    const plain = safeStorage.decryptString(Buffer.from(apiKeyEnc, 'base64'));
    return typeof plain === 'string' && plain.length > 0;
  } catch {
    return false;
  }
}

/**
 * Merges an entry's stored connection with the draft (#202). Secrets are
 * encrypted here; an empty draft leaves everything as it is, `remove*` removes
 * one field.
 *
 * @param {{ safeStorage: SafeStorageLike }} deps
 * @param {{ previous?: PresetConnection, patch?: PresetConnectionPatch, provider?: ProviderMeta|null }} input
 * @returns {SettingsFailure | { ok: true, connection: PresetConnection|undefined }}
 */
function mergePresetConnection({ safeStorage }, { previous, patch, provider }) {
  /** @type {PresetConnection & Record<string, unknown>} */
  const next = { ...(previous && typeof previous === 'object' ? previous : {}) };
  /** @type {PresetConnectionPatch & Record<string, unknown>} */
  const draft = patch && typeof patch === 'object' ? patch : {};
  const endpointBefore = normalizeBaseUrl(next.baseUrl || provider?.defaultBaseUrl);

  for (const key of PRESET_CONNECTION_PLAIN_FIELDS) {
    if (draft[key] === undefined) continue;
    if (draft[key] === null) delete next[key];
    else if (key === 'displayName' && !String(draft[key]).trim()) delete next.displayName;
    else next[key] = draft[key];
  }

  // A stored secret goes only to the endpoint it was stored with (#537). A new
  // address keeps neither the old key nor the old headers; what the draft
  // brings itself is set below (#560).
  if (normalizeBaseUrl(next.baseUrl || provider?.defaultBaseUrl) !== endpointBefore) {
    delete next.apiKeyEnc;
    delete next.extraHeadersEnc;
  }

  if (draft.removeApiKey === true) delete next.apiKeyEnc;
  if (typeof draft.apiKey === 'string' && draft.apiKey.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      return createSettingsError(createMessage('settings.error.encryptionUnavailable'));
    }
    next.apiKeyEnc = safeStorage.encryptString(draft.apiKey.trim()).toString('base64');
  }

  if (draft.removeExtraHeaders === true) delete next.extraHeadersEnc;
  if (typeof draft.extraHeaders === 'string' && draft.extraHeaders.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      return createSettingsError(createMessage('settings.error.encryptionUnavailable'));
    }
    next.extraHeadersEnc = safeStorage.encryptString(draft.extraHeaders.trim()).toString('base64');
  }

  return { ok: true, connection: normalizeStoredPresetConnection(next, provider) };
}

/**
 * The label of an incomplete entry: its own name, else the provider's.
 *
 * @param {ProviderMeta} meta
 * @param {PresetWire} preset
 */
function presetAccessLabel(meta, preset) {
  const name = preset?.connection?.displayName;
  return typeof name === 'string' && name.trim() ? name.trim() : meta.name;
}

/**
 * @param {{ safeStorage: SafeStorageLike }} deps
 * @param {ProviderMeta} meta
 * @param {StoredEntry} entry
 * @param {PresetWire} [preset] With `connectionPerPreset` the entry's connection
 *   decides, not the provider's (#202).
 * @returns {boolean}
 */
function isProviderConfigured({ safeStorage }, meta, entry, preset) {
  if (hasPresetConnection(meta)) {
    const conn = preset?.connection || {};
    if (!String(conn.baseUrl || meta.defaultBaseUrl || '').trim()) return false;
    // A stored key that no longer decrypts is worse than none: the request
    // would go out without authentication.
    if (conn.apiKeyEnc && !canDecryptApiKeyEnc(safeStorage, conn.apiKeyEnc)) return false;
    return true;
  }
  const baseUrlEff = meta.fields?.baseUrl
    ? (entry.baseUrl || meta.defaultBaseUrl || '')
    : '';
  // A provider with an optional key (#193) is complete once it has a server
  // URL — a local server without a key is not half a connection.
  const needsKey = meta.fields?.apiKey && meta.optionalApiKey !== true;
  return needsKey
    ? canDecryptApiKeyEnc(safeStorage, entry.apiKeyEnc)
    : meta.fields?.baseUrl
      ? !!String(baseUrlEff).trim()
      : true;
}

/**
 * Which stored keys the current safeStorage key still reads, per provider
 * and — in a namespace of its own, `preset:<id>` — per entry (#202).
 *
 * @param {SafeStorageLike} safeStorage
 * @param {LlmConfigDocument} config
 */
function describeKeyReadability(safeStorage, config) {
  // Stored does not mean readable: after a change of the app's name (the
  // safeStorage key hangs on it) or of the user account the key no longer
  // fits. The presentation shows that as keyUnreadable.
  /** @type {Record<string, boolean>} */
  const apiKeyDecryptable = {};
  for (const [providerId, entry] of Object.entries(config.providers || {})) {
    if (entry && entry.apiKeyEnc) {
      apiKeyDecryptable[providerId] = canDecryptApiKeyEnc(safeStorage, entry.apiKeyEnc);
    }
  }
  // Connection per entry (#202): the key belongs to the row, and so does the
  // question whether it still reads. A namespace of its own, so that an
  // entry's id never overwrites a provider id.
  for (const preset of Array.isArray(config.presets) ? config.presets : []) {
    const enc = preset?.connection?.apiKeyEnc;
    if (preset?.id && enc) {
      apiKeyDecryptable[`preset:${preset.id}`] = canDecryptApiKeyEnc(safeStorage, enc);
    }
  }
  return apiKeyDecryptable;
}

/**
 * The entry operations the chat's own settings need (#211): setting the
 * active entry and asking whether one is still usable.
 *
 * @param {{ llmConfigStore: Pick<import('../ports/llm-config-store-port').LlmConfigStorePort, 'readLLMConfig' | 'updateLLMConfig'>,
 *   providerCatalog: ProviderLookup, safeStorage: SafeStorageLike }} deps
 */
function createLlmPresets({ llmConfigStore, providerCatalog, safeStorage }) {
  /**
   * Sets the active entry — the only way there (#202, #211).
   *
   * `makeDefault` also writes `defaultPresetId`, the default for new chats.
   * Only an explicit choice does that; restoring a chat from the history does
   * not change the default.
   *
   * @param {unknown} rawPresetId
   * @param {{ makeDefault?: boolean }} [options]
   */
  async function applyActivePreset(rawPresetId, { makeDefault = false } = {}) {
    if (typeof rawPresetId !== 'string' || !rawPresetId.trim()) {
      return createSettingsError(createMessage('settings.error.preset.none'));
    }
    const presetId = rawPresetId.trim();
    let validationError = /** @type {SettingsFailure | null} */ (null);
    await llmConfigStore.updateLLMConfig(async (config) => {
      const preset = Array.isArray(config.presets)
        ? config.presets.find((p) => p && p.id === presetId)
        : null;
      const meta = preset ? providerCatalog.getProvider(preset.providerId) : null;
      if (!preset || !meta) {
        validationError = createSettingsError(createMessage('settings.error.preset.notFound'));
        return config;
      }
      const entry = (config.providers && config.providers[preset.providerId]) || {};
      if (!isProviderConfigured({ safeStorage }, meta, entry, preset)) {
        validationError = createSettingsError(createMessage('settings.error.preset.notConfigured'));
        return config;
      }
      config.activePresetId = presetId;
      if (makeDefault) config.defaultPresetId = presetId;
      config.activeProvider = preset.providerId;
      config.providers = config.providers || {};
      // With a connection per entry there is no provider entry to mirror the
      // active model into — and it would be migrated away on the next read
      // anyway (#202).
      if (!hasPresetConnection(meta)) {
        const pe = { ...(config.providers[preset.providerId] || {}) };
        pe.model = typeof preset.model === 'string' && preset.model.trim()
          ? preset.model.trim()
          : meta.defaultModel;
        config.providers[preset.providerId] = pe;
      }
      return config;
    });
    return validationError || createSettingsOk();
  }

  /**
   * Can the entry still serve as this chat's model (#211)? Deleted or
   * incompletely configured means no — then the default applies.
   *
   * @param {unknown} rawPresetId
   * @returns {Promise<boolean>}
   */
  async function isPresetUsable(rawPresetId) {
    if (typeof rawPresetId !== 'string' || !rawPresetId.trim()) return false;
    const presetId = rawPresetId.trim();
    const config = await llmConfigStore.readLLMConfig();
    const preset = Array.isArray(config.presets)
      ? config.presets.find((p) => p && p.id === presetId)
      : null;
    if (!preset) return false;
    const meta = providerCatalog.getProvider(preset.providerId);
    if (!meta) return false;
    const entry = (config.providers && config.providers[preset.providerId]) || {};
    return isProviderConfigured({ safeStorage }, meta, entry, preset);
  }

  return { applyActivePreset, isPresetUsable };
}

module.exports = {
  createLlmPresets,
  mergeProviderPatchIntoConfig,
  mergePresetConnection,
  carriesSecret,
  cloneLlmConfig,
  canDecryptApiKeyEnc,
  describeKeyReadability,
  isProviderConfigured,
  presetAccessLabel,
};
