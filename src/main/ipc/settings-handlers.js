const {
  createSettingsOk,
  createSettingsError,
  normalizeListModelsRequest,
  normalizeUiPrefsPatch,
} = require('../../shared/contracts/settings');

function registerSettingsHandlers({
  ipcMain,
  safeStorage,
  llmConfigStore,
  uiPrefsStore,
  workspaceFolderStore,
  providerCatalog,
  providerModels,
  REQ,
  setActiveWorkspaceRoot,
  presentation,
  toolCatalog,
  skillCatalog = null,
}) {
  if (!presentation || typeof presentation.buildLlmStateDto !== 'function') {
    throw new Error('registerSettingsHandlers requires an injected settings presentation service.');
  }
  const presentationService = presentation;

  ipcMain.handle(REQ.SETTINGS_GET_LLM_STATE, async () => {
    const encryptionAvailable = safeStorage.isEncryptionAvailable();
    const config = await llmConfigStore.readLLMConfig();
    const chatTarget = llmConfigStore.resolveChatModelTarget(config);
    const presetsWire = Array.isArray(config.presets)
      ? config.presets.map((row) => llmConfigStore.normalizePresetEntry(row)).filter(Boolean)
      : [];
    // Gespeichert heisst nicht lesbar: nach einem Wechsel des App-Namens
    // (safeStorage-Schluessel haengt daran) oder des Benutzerkontos passt der
    // Schluessel nicht mehr. Die Praesentation zeigt das als keyUnreadable.
    const apiKeyDecryptable = {};
    for (const [providerId, entry] of Object.entries(config.providers || {})) {
      if (entry && entry.apiKeyEnc) {
        apiKeyDecryptable[providerId] = canDecryptApiKeyEnc(safeStorage, entry.apiKeyEnc);
      }
    }
    return presentationService.buildLlmStateDto({
      encryptionAvailable,
      config: { ...config, presets: presetsWire },
      chatTarget,
      apiKeyDecryptable,
    });
  });

  function mergeProviderPatchIntoConfig(config, providerId, patch) {
    return mergeProviderPatchIntoConfigImpl({ safeStorage, providerCatalog }, config, providerId, patch);
  }

  ipcMain.handle(REQ.SETTINGS_SET_ACTIVE_PRESET, async (_event, presetId) => {
    if (typeof presetId !== 'string' || !presetId.trim()) {
      return createSettingsError('Kein Eintrag gewählt.');
    }
    let validationError = null;
    await llmConfigStore.updateLLMConfig(async (config) => {
      const preset = Array.isArray(config.presets)
        ? config.presets.find((p) => p && p.id === presetId.trim())
        : null;
      if (!preset || !providerCatalog.getProvider(preset.providerId)) {
        validationError = createSettingsError('Eintrag nicht gefunden.');
        return config;
      }
      const meta = providerCatalog.getProvider(preset.providerId);
      const entry = (config.providers && config.providers[preset.providerId]) || {};
      if (!isProviderConfigured({ safeStorage }, meta, entry)) {
        validationError = createSettingsError('Anbieter ist noch nicht konfiguriert.');
        return config;
      }
      config.activePresetId = presetId.trim();
      config.activeProvider = preset.providerId;
      config.providers = config.providers || {};
      const pe = { ...(config.providers[preset.providerId] || {}) };
      pe.model = typeof preset.model === 'string' && preset.model.trim()
        ? preset.model.trim()
        : meta.defaultModel;
      config.providers[preset.providerId] = pe;
      return config;
    });
    if (validationError) return validationError;
    return createSettingsOk();
  });

  ipcMain.handle(REQ.SETTINGS_COMMIT_SETTINGS, async (_event, payload) => {
    const rawPresets = Array.isArray(payload?.presets) ? payload.presets : [];
    const presets = rawPresets
      .map((row) => llmConfigStore.normalizePresetEntry(row))
      .filter(Boolean);
    if (presets.length === 0) {
      return createSettingsError('Mindestens ein Modell-Eintrag ist erforderlich.');
    }
    const seen = new Set();
    for (const p of presets) {
      if (seen.has(p.id)) {
        return createSettingsError('Doppelte Eintrags-IDs in der Liste.');
      }
      seen.add(p.id);
    }
    let activePresetId = typeof payload?.activePresetId === 'string' ? payload.activePresetId.trim() : null;
    if (!activePresetId || !presets.some((pr) => pr.id === activePresetId)) {
      activePresetId = presets[0].id;
    }

    const patches =
      payload?.providerPatches && typeof payload.providerPatches === 'object'
        ? payload.providerPatches
        : {};

    for (const pr of presets) {
      const meta = providerCatalog.getProvider(pr.providerId);
      if (!meta) continue;
      const patch = patches[pr.providerId];
      const incomingKey = typeof patch?.apiKey === 'string' ? patch.apiKey.trim() : '';
      if (meta.fields?.apiKey && incomingKey) {
        if (!safeStorage.isEncryptionAvailable()) {
          return createSettingsError('Verschlüsselter Speicher ist nicht verfügbar.');
        }
      }
    }

    let validationError = null;
    await llmConfigStore.updateLLMConfig(async (config) => {
      const draft = cloneLlmConfig(config);

      for (const providerId of Object.keys(patches)) {
        const res = mergeProviderPatchIntoConfig(draft, providerId, patches[providerId]);
        if (!res.ok) {
          validationError = res;
          return config;
        }
      }

      for (const pr of presets) {
        const meta = providerCatalog.getProvider(pr.providerId);
        const entry = (draft.providers && draft.providers[pr.providerId]) || {};
        if (!isProviderConfigured({ safeStorage }, meta, entry)) {
          validationError = createSettingsError(
            `Zugang für „${meta.name}“ ist unvollständig (z. B. API-Schlüssel oder Server-URL).`
          );
          return config;
        }
      }

      const providerIdsInUse = new Set(presets.map((pr) => pr.providerId));
      draft.providers = draft.providers || {};
      for (const pid of Object.keys(draft.providers)) {
        if (!providerIdsInUse.has(pid)) {
          delete draft.providers[pid];
        }
      }

      draft.version = 3;
      draft.presets = presets;
      draft.activePresetId = activePresetId;
      const target = llmConfigStore.resolveChatModelTarget(draft);
      draft.activeProvider = target.providerId;
      const activeEntryPid = target.providerId;
      if (activeEntryPid && providerCatalog.getProvider(activeEntryPid)) {
        const pe = { ...(draft.providers[activeEntryPid] || {}) };
        pe.model = target.model;
        draft.providers[activeEntryPid] = pe;
      }

      return draft;
    });
    if (validationError) return validationError;

    const uiPatch = normalizeUiPrefsPatch(payload?.uiPrefs);
    if (Object.keys(uiPatch).length > 0) {
      await uiPrefsStore.updateUIPrefs(async (out) => Object.assign(out, uiPatch));
    }

    return createSettingsOk();
  });

  ipcMain.handle(REQ.SETTINGS_LIST_MODELS, async (_event, payload) => {
    const req = normalizeListModelsRequest(payload);
    return providerModels.listModels(req.providerId, req);
  });

  ipcMain.handle(REQ.SETTINGS_GET_LAST_FOLDER, async () => {
    const folderPath = await workspaceFolderStore.getValidatedLastFolder();
    return { folderPath };
  });

  ipcMain.handle(REQ.SETTINGS_SET_LAST_FOLDER, async (_event, folderPath) => {
    await workspaceFolderStore.persistLastFolder(folderPath);
    if (setActiveWorkspaceRoot) {
      setActiveWorkspaceRoot(folderPath);
    }
    return createSettingsOk();
  });

  ipcMain.handle(REQ.SETTINGS_GET_FOLDER_HISTORY, async () => {
    const paths = await workspaceFolderStore.getValidatedFolderHistory();
    return { paths };
  });

  // Liefert die bereinigte Liste gleich mit, damit der Renderer Menü und
  // Welcome-Chips ohne zweiten Roundtrip neu zeichnen kann.
  ipcMain.handle(REQ.SETTINGS_REMOVE_FOLDER_FROM_HISTORY, async (_event, folderPath) => {
    const removed = await workspaceFolderStore.removeFolderFromHistory(folderPath);
    const paths = await workspaceFolderStore.getValidatedFolderHistory();
    return { ok: removed === true, paths };
  });

  ipcMain.handle(REQ.SETTINGS_GET_UI_PREFS, async () => uiPrefsStore.readUIPrefs());

  ipcMain.handle(REQ.SETTINGS_GET_TOOL_CATALOG, async () => ({
    tools: typeof toolCatalog?.listCatalog === 'function' ? toolCatalog.listCatalog() : [],
  }));

  async function buildSkillCatalog(workspaceRoot) {
    if (!skillCatalog || typeof skillCatalog.listCatalog !== 'function') return { skills: [] };
    const prefs = await uiPrefsStore.readUIPrefs();
    return skillCatalog.listCatalog({
      workspaceRoot: typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null,
      activeSkills: Array.isArray(prefs.activeSkills) ? prefs.activeSkills : null,
    });
  }

  ipcMain.handle(REQ.SETTINGS_GET_SKILL_CATALOG, async (_event, workspaceRoot) =>
    buildSkillCatalog(workspaceRoot)
  );

  ipcMain.handle(REQ.SETTINGS_RELOAD_SKILLS, async (_event, workspaceRoot) => {
    if (skillCatalog && typeof skillCatalog.reload === 'function') skillCatalog.reload();
    return buildSkillCatalog(workspaceRoot);
  });

  ipcMain.handle(REQ.SETTINGS_SET_UI_PREFS, async (_event, partial) => {
    const patch = normalizeUiPrefsPatch(partial);
    if (Object.keys(patch).length === 0) {
      return uiPrefsStore.readUIPrefs();
    }
    return uiPrefsStore.updateUIPrefs(async (out) => Object.assign(out, patch));
  });
}

function mergeProviderPatchIntoConfigImpl(deps, config, providerId, patch) {
  const { safeStorage, providerCatalog } = deps;
  const provider = providerCatalog.getProvider(providerId);
  if (!provider) return createSettingsError('Unbekannter Provider.');
  const prevEntry = (config.providers && config.providers[providerId]) || {};
  const next = { ...prevEntry };

  if (provider.fields?.apiKey) {
    if (patch?.removeApiKey === true) {
      delete next.apiKeyEnc;
    }
    const incomingKey = typeof patch?.apiKey === 'string' ? patch.apiKey.trim() : '';
    if (incomingKey) {
      if (!safeStorage.isEncryptionAvailable()) {
        return createSettingsError('Verschlüsselter Speicher ist nicht verfügbar.');
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

  config.providers = config.providers || {};
  config.providers[providerId] = next;
  return createSettingsOk();
}

function cloneLlmConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

// Prueft, ob ein gespeicherter Key mit dem aktuellen safeStorage-Schluessel
// lesbar ist. Das Ergebnis wird sofort verworfen; nur die Entscheidbarkeit
// zaehlt.
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

function isProviderConfigured({ safeStorage }, meta, entry) {
  const baseUrlEff = meta.fields?.baseUrl
    ? (entry.baseUrl || meta.defaultBaseUrl || '')
    : '';
  return meta.fields?.apiKey
    ? canDecryptApiKeyEnc(safeStorage, entry.apiKeyEnc)
    : meta.fields?.baseUrl
      ? !!String(baseUrlEff).trim()
      : true;
}

module.exports = { registerSettingsHandlers, mergeProviderPatchIntoConfigImpl, canDecryptApiKeyEnc };
