const { createRequestLifecycle } = require('./request-lifecycle');
const { isDeepStrictEqual } = require('node:util');
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
  workspaceActivation = null,
  getActiveWorkspaceRoot = () => null,
  presentation,
  toolCatalog,
  skillCatalog = null,
  webSearchSettings = null,
  pythonSettings = null,
  shellSettings = null,
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

  // Schreibt System-Prompt, Sprache, Tool-Auswahl und die uebrigen UI-Werte.
  // false heisst: der Schreibversuch selbst ist fehlgeschlagen.
  async function writeUiPrefsPatch(uiPatch) {
    try {
      await uiPrefsStore.updateUIPrefs(async (out) => Object.assign(out, uiPatch));
      // Beides entscheidet ueber die Sichtbarkeit von run_python (Issue #86)
      // und muss sofort greifen, nicht erst beim naechsten App-Start.
      if ('pythonExecutionEnabled' in uiPatch || 'pythonInterpreterPath' in uiPatch) {
        await pythonSettings?.refresh();
      }
      if ('shellExecutionEnabled' in uiPatch) {
        await shellSettings?.refresh();
      }
      return true;
    } catch {
      return false;
    }
  }

  // Der Modellteil ist abgelehnt, gespeichert wurde davon nichts. Die uebrigen
  // Einstellungen haben damit nichts zu tun — der System-Prompt haengt nicht am
  // OpenAI-Schluessel — und laufen trotzdem durch. Die Meldung sagt, was
  // uebernommen wurde und was nicht (Issue #97).
  async function rejectModelPart(message, uiPatch) {
    if (Object.keys(uiPatch).length === 0) return createSettingsError(message);
    if (!(await writeUiPrefsPatch(uiPatch))) {
      return createSettingsError(
        `${message} Die übrigen Einstellungen konnten ebenfalls nicht gespeichert werden.`
      );
    }
    return {
      ...createSettingsError(`${message} Die übrigen Einstellungen wurden gespeichert.`),
      uiPrefsSaved: true,
    };
  }

  ipcMain.handle(REQ.SETTINGS_COMMIT_SETTINGS, async (_event, payload) => {
    const uiPatch = normalizeUiPrefsPatch(payload?.uiPrefs);
    const rawPresets = Array.isArray(payload?.presets) ? payload.presets : [];
    const presets = rawPresets
      .map((row) => llmConfigStore.normalizePresetEntry(row))
      .filter(Boolean);
    if (presets.length === 0) {
      return rejectModelPart('Mindestens ein Modell-Eintrag ist erforderlich.', uiPatch);
    }
    const seen = new Set();
    for (const p of presets) {
      if (seen.has(p.id)) {
        return rejectModelPart('Doppelte Eintrags-IDs in der Liste.', uiPatch);
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
          return rejectModelPart('Verschlüsselter Speicher ist nicht verfügbar.', uiPatch);
        }
      }
    }

    let validationError = null;
    let previousConfig;
    let savedConfig;
    try {
      savedConfig = await llmConfigStore.updateLLMConfig(async (config) => {
        previousConfig = cloneLlmConfig(config);
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
    } catch {
      return createSettingsError(
        'Anbieter und Modell-Einträge konnten nicht gespeichert werden. Die UI-Einstellungen wurden nicht geändert.'
      );
    }
    if (validationError) return rejectModelPart(validationError.error, uiPatch);

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
        return createSettingsError(
          'UI-Einstellungen konnten nicht gespeichert werden. Anbieter und Modell-Einträge wurden bereits gespeichert; '
          + 'ihre Rücknahme ist fehlgeschlagen oder wurde wegen zwischenzeitlicher Änderungen ausgelassen. '
          + 'Bitte die Einstellungen erneut öffnen und prüfen.'
        );
      }
      return createSettingsError(
        'UI-Einstellungen konnten nicht gespeichert werden. Die Änderungen an Anbietern und Modell-Einträgen wurden zurückgenommen.'
      );
    }

    return createSettingsOk();
  });

  const modelRequests = createRequestLifecycle();
  ipcMain.handle(REQ.SETTINGS_CANCEL_MODELS, (event) => modelRequests.cancel(event.sender));
  ipcMain.handle(REQ.SETTINGS_LIST_MODELS, async (event, payload) => {
    const req = normalizeListModelsRequest(payload);
    return modelRequests.run(event.sender, (signal) => providerModels.listModels(req.providerId, { ...req, signal }));
  });

  ipcMain.handle(REQ.SETTINGS_GET_LAST_FOLDER, async () => {
    const folderPath = await workspaceFolderStore.getValidatedLastFolder();
    return { folderPath };
  });

  // Nimmt nur Ordner an, die der Main-Prozess schon kennt (Verlauf oder
  // letzter Ordner). Ein frei uebergebener Pfad kann die Vertrauensgrenze
  // damit nicht mehr verschieben (Issue #68).
  ipcMain.handle(REQ.SETTINGS_ACTIVATE_FOLDER, async (_event, folderPath) => {
    if (!workspaceActivation) return createSettingsError('Ordner konnte nicht geöffnet werden.');
    const activated = await workspaceActivation.activateKnownFolder(folderPath);
    if (!activated) return createSettingsError('Ordner konnte nicht geöffnet werden.');
    return { ...createSettingsOk(), folderPath: activated };
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

  // Skill-Verzeichnisse haengen am Workspace und sind damit Teil der
  // Vertrauensgrenze: der Root kommt aus dem Main, nicht aus dem Aufruf.
  async function buildSkillCatalog() {
    if (!skillCatalog || typeof skillCatalog.listCatalog !== 'function') return { skills: [] };
    const prefs = await uiPrefsStore.readUIPrefs();
    const workspaceRoot = getActiveWorkspaceRoot();
    return skillCatalog.listCatalog({
      workspaceRoot: typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null,
      activeSkills: Array.isArray(prefs.activeSkills) ? prefs.activeSkills : null,
    });
  }

  ipcMain.handle(REQ.SETTINGS_GET_SKILL_CATALOG, async () => buildSkillCatalog());

  ipcMain.handle(REQ.SETTINGS_RELOAD_SKILLS, async () => {
    if (skillCatalog && typeof skillCatalog.reload === 'function') skillCatalog.reload();
    return buildSkillCatalog();
  });

  // Websuche (Issue #63). Der hinterlegte Schluessel verlaesst den Main nie —
  // der Renderer erfaehrt nur, ob einer da ist.
  ipcMain.handle(REQ.SETTINGS_GET_WEB_SEARCH_STATE, async () => ({
    available: !!webSearchSettings,
    hasApiKey: webSearchSettings ? await webSearchSettings.refresh() : false,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  }));

  ipcMain.handle(REQ.SETTINGS_SET_WEB_SEARCH_API_KEY, async (_event, apiKey) => {
    if (!webSearchSettings) {
      return createSettingsError('Websuche ist in dieser Installation nicht verfügbar.');
    }
    const value = typeof apiKey === 'string' ? apiKey : '';
    const result = await webSearchSettings.setApiKey(value);
    if (!result?.ok) return createSettingsError(result?.error || 'Schlüssel konnte nicht gespeichert werden.');
    return { ...createSettingsOk(), hasApiKey: result.hasApiKey === true };
  });

  // Python-Ausfuehrung (Issue #86). Der Renderer erfaehrt, ob ein Interpreter
  // gefunden wurde und welcher — geschaltet wird ueber die UI-Prefs.
  ipcMain.handle(REQ.SETTINGS_GET_PYTHON_STATE, async () => {
    if (!pythonSettings) return { found: false, enabled: false, available: false };
    return { ...(await pythonSettings.refresh()), available: true };
  });

  // Shell-Ausfuehrung (Issue #102). Der Renderer erfaehrt, welche Shell
  // erkannt wurde und ob sie als Login-Shell laeuft (PATH aus dem Profil).
  ipcMain.handle(REQ.SETTINGS_GET_SHELL_STATE, async () => {
    if (!shellSettings) return { found: false, enabled: false, available: false };
    return { ...(await shellSettings.refresh()), available: true };
  });

  ipcMain.handle(REQ.SETTINGS_SET_UI_PREFS, async (_event, partial) => {
    const patch = normalizeUiPrefsPatch(partial);
    if (Object.keys(patch).length === 0) {
      return uiPrefsStore.readUIPrefs();
    }
    const updated = await uiPrefsStore.updateUIPrefs(async (out) => Object.assign(out, patch));
    // Beides entscheidet ueber die Sichtbarkeit von run_python und muss
    // sofort greifen, nicht erst beim naechsten App-Start.
    if ('pythonExecutionEnabled' in patch || 'pythonInterpreterPath' in patch) {
      await pythonSettings?.refresh();
    }
    if ('shellExecutionEnabled' in patch) {
      await shellSettings?.refresh();
    }
    return updated;
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
