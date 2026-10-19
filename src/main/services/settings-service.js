const { isDeepStrictEqual } = require('node:util');
const {
  createSettingsOk,
  createSettingsError,
  normalizeUiPrefsPatch,
  LLM_CONFIG_VERSION,
  hasPresetConnection,
  normalizeProviderPatch,
  normalizePresetConnectionPatch,
} = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');
const { KEY_ALWAYS_DURABLE } = require('./safe-storage-key-durability');
const {
  normalizeReasoningLevel,
  reasoningDefaultFor,
  reasoningLevelsFor,
  resolveReasoningLevel,
} = require('../../shared/contracts/reasoning');
const { createTranslator } = require('../../shared/i18n');
const { CONFIRMATION_ACTIONS, createRefusingConfirmation } = require('../../application/permissions/user-confirmation');
const { executionSwitchDialog } = require('./settings-confirmation-dialogs');
const {
  mergeProviderPatchIntoConfig,
  mergePresetConnection,
  carriesSecret,
  cloneLlmConfig,
  describeKeyReadability,
  isProviderConfigured,
  presetAccessLabel,
} = require('./llm-settings');

/**
 * What the settings dialog saves and what the chat bar sets (#1006): the
 * model entries with their connections, the active entry, the reasoning level
 * and the interface preferences. Until #1006 this sat in
 * `ipc/settings-handlers.js`; the handlers now parse and delegate.
 *
 * @typedef {import('../../shared/contracts/settings').UiPrefs} UiPrefs
 * @typedef {import('../../shared/contracts/settings').UiPrefsPatch} UiPrefsPatch
 * @typedef {keyof typeof EXECUTION_SWITCH_ACTIONS} ExecutionSwitch
 * @typedef {import('./llm-settings').SecretStoreLike} SecretStoreLike
 * @typedef {import('./llm-settings').SettingsFailure} SettingsFailure
 * @typedef {import('../../shared/contracts/settings').PresetWire} PresetWire
 * @typedef {import('../ports/llm-config-store-port').LlmConfigDocument} LlmConfigDocument
 * @typedef {import('../../shared/contracts/message').Message} Message
 * @typedef {{ providerId: string, model?: string, presetId?: string }} ChatTarget
 * @typedef {import('../../shared/contracts/settings').ProviderPatch} ProviderPatch
 * @typedef {import('../../shared/contracts/settings').PresetConnectionPatch} PresetConnectionPatch
 *
 * @typedef {Pick<ReturnType<typeof import('./chat-session-settings').createChatSessionSettings>,
 *   'reasoningEffortFor' | 'rememberReasoningEffort' | 'rememberPreset'>} SettingsChatSession
 * @typedef {Pick<ReturnType<typeof import('./skills-service').createSkillsService>, 'bindSelection'>} SettingsSkillBinding
 * @typedef {Pick<ReturnType<typeof import('./image-generation-settings').createImageGenerationSettings>, 'refresh'>} SettingsImageGeneration
 * @typedef {{ refresh: () => Promise<object> }} SettingsExecutionTool  python or shell: what was found, re-detected
 */

/** What switching each execution tool on is confirmed as (#1104). */
const EXECUTION_SWITCH_ACTIONS = Object.freeze({
  shellExecutionEnabled: CONFIRMATION_ACTIONS.SHELL_EXECUTION,
  pythonExecutionEnabled: CONFIRMATION_ACTIONS.PYTHON_EXECUTION,
});

/** @type {ExecutionSwitch[]} */
const EXECUTION_SWITCH_KEYS = ['shellExecutionEnabled', 'pythonExecutionEnabled'];

/**
 * @param {object} deps
 * @param {SecretStoreLike} deps.secretStore
 * @param {import('../../shared/contracts/safe-storage-key').SafeStorageKeyDurability} [deps.safeStorageKey]
 * @param {import('../ports/llm-config-store-port').LlmConfigStorePort} deps.llmConfigStore
 * @param {import('../ports/ui-prefs-store-port').UiPrefsStorePort} deps.uiPrefsStore
 * @param {import('../ports/provider-catalog-port').ProviderCatalogPort} deps.providerCatalog
 * @param {ReturnType<typeof import('./llm-settings').createLlmPresets>} deps.presets
 * @param {SettingsChatSession|null} [deps.chatSessionSettings]
 * @param {SettingsSkillBinding|null} [deps.skillCatalog]
 * @param {() => string|null} [deps.getActiveWorkspaceRoot]
 * @param {SettingsImageGeneration|null} [deps.imageGenerationSettings]
 * @param {SettingsExecutionTool|null} [deps.pythonSettings]
 * @param {SettingsExecutionTool|null} [deps.shellSettings]
 * @param {((locale: unknown) => void)|null} [deps.onAppLocaleChanged]
 * @param {((show: unknown) => void)|null} [deps.onShowHiddenFilesChanged]
 * @param {import('../../application/ports/user-confirmation-port').UserConfirmationPort} [deps.confirmations]
 * @param {string} [deps.platform]
 */
function createSettingsService({
  secretStore,
  /** When ciphertext may reach the disk (#1060); without it, at once. */
  safeStorageKey = KEY_ALWAYS_DURABLE,
  llmConfigStore,
  uiPrefsStore,
  providerCatalog,
  presets,
  // Model and permission mode belong to the chat (#211): an explicit choice
  // holds for the chat on screen *and* becomes the default for new ones.
  // Without the service (tests) it stays as before.
  chatSessionSettings = null,
  skillCatalog = null,
  getActiveWorkspaceRoot = () => null,
  imageGenerationSettings = null,
  pythonSettings = null,
  shellSettings = null,
  /**
   * Reports a language change to the composition root (epic #277). The main
   * process keeps the language in memory and rebuilds its menu — neither
   * belongs here; this service only knows when it happens.
   */
  onAppLocaleChanged = null,
  /**
   * The same for the hidden files in the tree (#436): the renderer owns the
   * switch, the main process only keeps the checkbox in the View menu in step.
   */
  onShowHiddenFilesChanged = null,
  /**
   * The user-confirmation port (#980). An execution tool switched on is asked
   * through it (#1104); without a person at the machine it does not go
   * through — the store takes none without its receipt.
   */
  confirmations = createRefusingConfirmation(),
  /** Windows has no sandbox; the prompt for an execution tool says so. */
  platform = process.platform,
}) {
  /**
   * The levels the chat's model takes and the one it runs with (#725) — the
   * same resolution a round makes in the LLM adapter.
   *
   * @param {ChatTarget} target
   */
  function reasoningLevelsOf(target) {
    const provider = providerCatalog.getProvider(target?.providerId);
    const model = target?.model || provider?.defaultModel || '';
    return {
      levels: reasoningLevelsFor(provider, model),
      defaultLevel: reasoningDefaultFor(provider, model),
    };
  }

  /**
   * @param {ChatTarget} target
   */
  async function chatReasoningState(target) {
    const { levels, defaultLevel } = reasoningLevelsOf(target);
    if (levels.length === 0) return { level: null, levels: [], defaultLevel: null };
    /** @type {string|null} */
    let own = null;
    try {
      own = (await chatSessionSettings?.reasoningEffortFor()) || null;
    } catch {
      // Without the chat's own level the model's default applies.
      own = null;
    }
    return {
      level: resolveReasoningLevel({ levels, own, defaultLevel }),
      levels,
      defaultLevel,
    };
  }

  /**
   * What the presentation needs to describe the model settings: the stored
   * entries, the chat's target, which keys still decrypt, the reasoning state
   * and the interface language.
   */
  async function describeLlmState() {
    const config = await llmConfigStore.readLLMConfig();
    const chatTarget = llmConfigStore.resolveChatModelTarget(config);
    /** @type {PresetWire[]} */
    const presetsWire = [];
    for (const row of Array.isArray(config.presets) ? config.presets : []) {
      const preset = llmConfigStore.normalizePresetEntry(row);
      if (preset) presetsWire.push(preset);
    }
    // Provider names and hints come in the stored language (#310), read fresh.
    const prefs = await uiPrefsStore.readUIPrefs();
    return {
      config: { ...config, presets: presetsWire },
      chatTarget,
      apiKeyDecryptable: describeKeyReadability(secretStore, config),
      locale: prefs.appLocale,
      reasoning: await chatReasoningState(chatTarget),
    };
  }

  /**
   * The level chosen for the chat on screen (#725). Only a level its model
   * takes is kept; the renderer offers no other, so anything else is refused.
   *
   * @param {unknown} rawLevel
   */
  async function setReasoningEffort(rawLevel) {
    const level = normalizeReasoningLevel(rawLevel);
    const config = await llmConfigStore.readLLMConfig();
    const { levels } = reasoningLevelsOf(llmConfigStore.resolveChatModelTarget(config));
    if (!level || !levels.includes(level)) {
      return createSettingsError(createMessage('settings.error.reasoningLevel', { level: String(rawLevel ?? '').slice(0, 32) }));
    }
    if (!(await chatSessionSettings?.rememberReasoningEffort(level))) {
      return createSettingsError(createMessage('settings.error.reasoningNoChat'));
    }
    return createSettingsOk();
  }

  /**
   * An explicit choice in the chat bar: it holds for the chat on screen and
   * becomes the default for new ones (#211).
   *
   * @param {unknown} presetId
   */
  async function setActivePreset(presetId) {
    const result = await presets.applyActivePreset(presetId, { makeDefault: true });
    if (!result.ok) return result;
    await chatSessionSettings?.rememberPreset(String(presetId).trim());
    return createSettingsOk();
  }

  /**
   * An execution tool switched on is asked through the port first (#1104).
   * One the person declined leaves the patch, so the rest still saves; the
   * receipts go to the store, which switches nothing on without one.
   *
   * @param {UiPrefsPatch} patch
   * @returns {Promise<{ patch: UiPrefsPatch, receipts: Partial<Record<ExecutionSwitch, unknown>>, notConfirmed: ExecutionSwitch[] }>}
   */
  async function confirmExecutionSwitches(patch) {
    const wanted = EXECUTION_SWITCH_KEYS.filter((key) => patch[key] === true);
    if (wanted.length === 0) return { patch, receipts: {}, notConfirmed: [] };
    const current = await uiPrefsStore.readUIPrefs();
    const t = createTranslator(current.appLocale);
    const out = { ...patch };
    /** @type {Partial<Record<ExecutionSwitch, unknown>>} */
    const receipts = {};
    /** @type {ExecutionSwitch[]} */
    const notConfirmed = [];
    for (const key of wanted) {
      if (current[key] === true) continue;
      const outcome = await confirmations.confirm({
        action: EXECUTION_SWITCH_ACTIONS[key],
        subject: '',
        prompt: executionSwitchDialog(key, t, platform),
      });
      if (outcome?.confirmed === true && outcome.receipt) {
        receipts[key] = outcome.receipt;
      } else {
        delete out[key];
        notConfirmed.push(key);
      }
    }
    return { patch: out, receipts, notConfirmed };
  }

  /**
   * The renderer sends the names it shows ticked; which skill each name means
   * is decided here, against the open folder (#576). A workspace skill goes
   * into that folder's own list, everything else into the global one, and
   * what this folder's catalogue cannot see is kept. Runs under the
   * preferences lock, on the stored state it is about to write over.
   *
   * @param {UiPrefs} current
   * @param {UiPrefsPatch} uiPatch
   */
  async function bindSkillSelection(current, uiPatch) {
    if (!Array.isArray(uiPatch.activeSkills) || typeof skillCatalog?.bindSelection !== 'function') {
      return uiPatch;
    }
    const workspaceRoot = getActiveWorkspaceRoot();
    const bound = await skillCatalog.bindSelection({
      workspaceRoot: typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null,
      selected: uiPatch.activeSkills,
      activeSkills: Array.isArray(current.activeSkills) ? current.activeSkills : null,
      activeWorkspaceSkills: current.activeWorkspaceSkills || null,
    });
    return { ...uiPatch, activeSkills: bound.activeSkills, activeWorkspaceSkills: bound.activeWorkspaceSkills };
  }

  /**
   * What a written preferences patch changes outside the file. One place for
   * both paths that write preferences — two copies had drifted apart (#562).
   *
   * @param {UiPrefsPatch} patch
   */
  async function applyUiPrefsPatch(patch) {
    if ('appLocale' in patch) onAppLocaleChanged?.(patch.appLocale);
    if ('showHiddenFiles' in patch) onShowHiddenFilesChanged?.(patch.showHiddenFiles);
    // Both decide whether run_python is offered (#86) and take effect at once,
    // not only at the next start.
    if ('pythonExecutionEnabled' in patch || 'pythonInterpreterPath' in patch) {
      await pythonSettings?.refresh();
    }
    if ('shellExecutionEnabled' in patch) {
      await shellSettings?.refresh();
    }
    if ('imageModel' in patch) {
      await imageGenerationSettings?.refresh();
    }
  }

  /**
   * Writes system prompt, language, tool choice and the other interface
   * values. False means the write itself failed.
   *
   * @param {UiPrefsPatch} requested
   */
  async function writeUiPrefsPatch(requested) {
    try {
      const { patch: uiPatch, receipts } = await confirmExecutionSwitches(requested);
      await uiPrefsStore.updateUIPrefs(
        async (out) => Object.assign(out, await bindSkillSelection(out, uiPatch)),
        { confirmations: receipts }
      );
      await applyUiPrefsPatch(uiPatch);
      return true;
    } catch {
      // The caller says the preferences were not saved; false is that answer.
      return false;
    }
  }

  /**
   * The interface preferences on their own (`SETTINGS_SET_UI_PREFS`): the
   * stored state, with the switches the person did not confirm named.
   *
   * @param {unknown} partial
   */
  async function setUiPrefs(partial) {
    const { patch, receipts, notConfirmed } = await confirmExecutionSwitches(normalizeUiPrefsPatch(partial));
    /** @param {UiPrefs} prefs */
    const withNotConfirmed = (prefs) => (notConfirmed.length > 0 ? { ...prefs, notConfirmed } : prefs);
    if (Object.keys(patch).length === 0) {
      return withNotConfirmed(await uiPrefsStore.readUIPrefs());
    }
    // Ticked skills are bound to the open folder here as well (#576).
    const updated = await uiPrefsStore.updateUIPrefs(
      async (out) => Object.assign(out, await bindSkillSelection(out, patch)),
      { confirmations: receipts }
    );
    await applyUiPrefsPatch(patch);
    return withNotConfirmed(updated);
  }

  // The model part is refused and nothing of it was saved. The other settings
  // have nothing to do with it — the system prompt does not hang on the
  // OpenAI key — and go through anyway. The message says what was taken over
  // and what was not (#97). The reason goes into the sentence as a message of
  // its own, so both read in one language (#308).
  /**
   * @param {Message|string} reason
   * @param {UiPrefsPatch} uiPatch
   */
  async function rejectModelPart(reason, uiPatch) {
    if (Object.keys(uiPatch).length === 0) return createSettingsError(reason);
    if (!(await writeUiPrefsPatch(uiPatch))) {
      return createSettingsError(createMessage('settings.error.modelPart.othersFailed', { reason }));
    }
    return {
      ...createSettingsError(createMessage('settings.error.modelPart.othersSaved', { reason })),
      uiPrefsSaved: true,
    };
  }

  /**
   * The settings dialog's save (`SETTINGS_COMMIT_SETTINGS`): the model entries
   * with their connections and the interface preferences, the first rolled
   * back when the second cannot be written.
   *
   * @param {any} payload  straight from the renderer, parsed here
   */
  async function commitSettings(payload) {
    const uiPatch = normalizeUiPrefsPatch(payload?.uiPrefs);
    const rawPresets = Array.isArray(payload?.presets) ? payload.presets : [];
    // Normalising drops plaintext secrets (as it should). Each row's
    // connection draft is therefore taken from the raw payload first and
    // encrypted below under the file lock (#202).
    /** @type {Map<string, PresetConnectionPatch>} */
    const connectionPatches = new Map();
    for (const row of rawPresets) {
      const provider = row?.providerId ? providerCatalog.getProvider(row.providerId) : null;
      if (!provider || !hasPresetConnection(provider) || typeof row.id !== 'string') continue;
      const patch = normalizePresetConnectionPatch(row.connection, provider);
      // Keyed like the normalised preset, whose id is trimmed (#562).
      if (patch) connectionPatches.set(row.id.trim(), patch);
    }
    /** @type {PresetWire[]} */
    const entries = [];
    for (const row of rawPresets) {
      const preset = llmConfigStore.normalizePresetEntry(row);
      if (preset) entries.push(preset);
    }
    if (entries.length === 0) {
      return rejectModelPart(createMessage('settings.error.presets.empty'), uiPatch);
    }
    const seen = new Set();
    for (const p of entries) {
      if (seen.has(p.id)) {
        return rejectModelPart(createMessage('settings.error.presets.duplicateId'), uiPatch);
      }
      seen.add(p.id);
    }
    let activePresetId = typeof payload?.activePresetId === 'string' ? payload.activePresetId.trim() : null;
    if (!activePresetId || !entries.some((pr) => pr.id === activePresetId)) {
      activePresetId = entries[0].id;
    }

    // Each patch through the contract, so its limits hold here too (#562). An
    // unknown provider keeps an empty patch; the merge below refuses it.
    const rawPatches =
      payload?.providerPatches && typeof payload.providerPatches === 'object'
        ? payload.providerPatches
        : {};
    /** @type {Record<string, ProviderPatch>} */
    const patches = Object.create(null);
    for (const [providerId, raw] of Object.entries(rawPatches)) {
      patches[providerId] = normalizeProviderPatch(raw, providerCatalog.getProvider(providerId));
    }

    for (const pr of entries) {
      const meta = providerCatalog.getProvider(pr.providerId);
      if (!meta) continue;
      const patch = patches[pr.providerId];
      const incomingKey = typeof patch?.apiKey === 'string' ? patch.apiKey.trim() : '';
      const presetPatch = connectionPatches.get(pr.id);
      const incomingPresetSecret = !!(presetPatch?.apiKey || presetPatch?.extraHeaders);
      if (meta.fields?.apiKey && (incomingKey || incomingPresetSecret)) {
        if (!secretStore.isEncryptionAvailable()) {
          return rejectModelPart(createMessage('settings.error.encryptionUnavailable'), uiPatch);
        }
      }
    }

    // A key or headers go to the disk encrypted. On a fresh Windows profile
    // the save waits until the key behind secretStore is on disk itself
    // (#1060) — before the config lock, so nothing else waits with it.
    if (secretStore.isEncryptionAvailable() && carriesSecret(patches, connectionPatches)) {
      await safeStorageKey.whenDurable();
    }

    // Set inside the updater below, so the declared type has to survive the
    // `null` it starts with.
    let validationError = /** @type {SettingsFailure | null} */ (null);
    /** @type {LlmConfigDocument} */
    let previousConfig;
    /** @type {object} */
    let savedConfig;
    try {
      savedConfig = await llmConfigStore.updateLLMConfig(async (config) => {
        previousConfig = cloneLlmConfig(config);
        const draft = cloneLlmConfig(config);

        for (const providerId of Object.keys(patches)) {
          const res = mergeProviderPatchIntoConfig({ secretStore, providerCatalog }, draft, providerId, patches[providerId]);
          if (!res.ok) {
            validationError = res;
            return config;
          }
        }

        // Connection per entry (#202): what stays comes from the stored entry,
        // what is new from the draft. It is encrypted here; the plaintext goes
        // no further.
        const storedById = new Map(
          (Array.isArray(config.presets) ? config.presets : [])
            .filter((row) => row && typeof row.id === 'string')
            .map((row) => [row.id, row])
        );
        for (const pr of entries) {
          const meta = providerCatalog.getProvider(pr.providerId);
          if (!meta || !hasPresetConnection(meta)) continue;
          const merged = mergePresetConnection({ secretStore }, {
            previous: storedById.get(pr.id)?.connection,
            patch: connectionPatches.get(pr.id),
            provider: meta,
          });
          if (!merged.ok) {
            validationError = merged;
            return config;
          }
          pr.connection = merged.connection;
        }

        // An entry that was already stored incomplete and still is does not
        // block the save: a fresh profile starts with an OpenAI entry without
        // a key, and adding a first working model next to it has to be
        // possible (#670). What is new, or was complete before, still has to
        // be complete.
        const wasStoredIncomplete = (/** @type {PresetWire} */ pr) => {
          const stored = storedById.get(pr.id);
          if (!stored || stored.providerId !== pr.providerId) return false;
          const meta = providerCatalog.getProvider(stored.providerId);
          if (!meta) return false;
          const entry = (config.providers && config.providers[stored.providerId]) || {};
          return !isProviderConfigured({ secretStore }, meta, entry, stored);
        };
        const usableIds = new Set();
        for (const pr of entries) {
          const meta = providerCatalog.getProvider(pr.providerId);
          if (!meta) {
            validationError = createSettingsError(createMessage('settings.error.provider.unknown'));
            return config;
          }
          const entry = (draft.providers && draft.providers[pr.providerId]) || {};
          if (isProviderConfigured({ secretStore }, meta, entry, pr)) {
            usableIds.add(pr.id);
            continue;
          }
          if (wasStoredIncomplete(pr)) continue;
          validationError = createSettingsError(
            createMessage('settings.error.accessIncomplete', { label: presetAccessLabel(meta, pr) })
          );
          return config;
        }
        // The chat can only run on a usable entry. When the chosen one is
        // not and another is, the first usable one takes over (#670).
        if (!usableIds.has(activePresetId)) {
          const firstUsable = entries.find((pr) => usableIds.has(pr.id));
          if (firstUsable) activePresetId = firstUsable.id;
        }

        const providerIdsInUse = new Set(entries.map((pr) => pr.providerId));
        draft.providers = draft.providers || {};
        for (const pid of Object.keys(draft.providers)) {
          if (!providerIdsInUse.has(pid)) {
            delete draft.providers[pid];
          }
        }

        // The version comes from the contract layer: a number hard-wired here
        // would make the next read migrate again, which broke the rollback
        // comparison (#202).
        draft.version = LLM_CONFIG_VERSION;
        draft.presets = entries;
        draft.activePresetId = activePresetId;
        draft.defaultPresetId = activePresetId;
        const target = llmConfigStore.resolveChatModelTarget(draft);
        draft.activeProvider = target.providerId;
        const activeEntryPid = target.providerId;
        const activeMeta = activeEntryPid ? providerCatalog.getProvider(activeEntryPid) : null;
        if (activeMeta && !hasPresetConnection(activeMeta)) {
          const pe = { ...(draft.providers[activeEntryPid] || {}) };
          pe.model = target.model;
          draft.providers[activeEntryPid] = pe;
        }

        return draft;
      });
    } catch {
      // The store could not write: the dialog says so, nothing was saved.
      return createSettingsError(createMessage('settings.error.modelsNotSaved'));
    }
    if (validationError) return rejectModelPart(/** @type {SettingsFailure} */ (validationError).error, uiPatch);

    if (Object.keys(uiPatch).length > 0 && !(await writeUiPrefsPatch(uiPatch))) {
      try {
        await llmConfigStore.updateLLMConfig(async (current) => {
          // Compare under the store lock: never undo a newer settings save
          // or a preset selection that arrived while the UI write was pending.
          if (!isDeepStrictEqual(current, savedConfig)) {
            throw new Error('LLM settings changed since this save.');
          }
          return previousConfig;
        });
      } catch {
        // A newer save came in, or the write failed: the dialog says the rollback did not happen.
        return createSettingsError(createMessage('settings.error.uiNotSaved.rollbackFailed'));
      }
      return createSettingsError(createMessage('settings.error.uiNotSaved.rolledBack'));
    }

    // The dialog chooses explicitly as well: the chat on screen takes the
    // entry, not only the next new one (#211).
    await chatSessionSettings?.rememberPreset(activePresetId);
    // The OpenAI key may have come or gone; the image tool follows it (#85).
    await imageGenerationSettings?.refresh().catch(() => { /* the tool is re-checked at its next use */ });
    return createSettingsOk();
  }

  return { describeLlmState, setReasoningEffort, setActivePreset, setUiPrefs, commitSettings };
}

module.exports = { createSettingsService };
