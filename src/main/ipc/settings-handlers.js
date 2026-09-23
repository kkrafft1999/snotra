const { createRequestLifecycle } = require('./request-lifecycle');
const { isDeepStrictEqual } = require('node:util');
const {
  createSettingsOk,
  createSettingsError,
  normalizeListModelsRequest,
  normalizeUiPrefsPatch,
  isApiStyle,
  LLM_CONFIG_VERSION,
  hasPresetConnection,
  normalizePresetConnectionPatch,
  normalizeStoredPresetConnection,
  PRESET_CONNECTION_PLAIN_FIELDS,
} = require('../../shared/contracts/settings');
const { createMessage } = require('../../shared/contracts/message');
const {
  MEMORY_SCOPES,
  MEMORY_SCOPE_ORDER,
  MEMORY_SCOPE_SHORT_PATHS,
  MAX_MEMORY_CHARS,
  isMemoryScope,
  parseMemoryEntries,
} = require('../../shared/contracts/memory');

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
  memory = null,
  webSearchSettings = null,
  mcpSettings = null,
  pythonSettings = null,
  shellSettings = null,
  // Modell und Freigabemodus gehoeren zum Chat (Issue #211): Eine
  // ausdrueckliche Wahl gilt fuer den laufenden Chat *und* wird der Standard
  // fuer neue. Fehlt der Dienst (Tests), bleibt es beim bisherigen Verhalten.
  chatSessionSettings = null,
  /**
   * Reports a language change to the composition root (epic #277). The main
   * process keeps the language in memory and rebuilds its menu — neither
   * belongs here; this handler only knows when it happens.
   */
  onAppLocaleChanged = null,
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
    // Verbindung je Eintrag (Issue #202): Der Schluessel haengt an der Zeile,
    // also auch die Frage, ob er noch lesbar ist. Eigener Namensraum, damit
    // eine Preset-Kennung nie eine Provider-ID ueberschreibt.
    for (const preset of Array.isArray(config.presets) ? config.presets : []) {
      const enc = preset?.connection?.apiKeyEnc;
      if (preset?.id && enc) {
        apiKeyDecryptable[`preset:${preset.id}`] = canDecryptApiKeyEnc(safeStorage, enc);
      }
    }
    // Provider names and hints come in the stored language (#310), read fresh
    // for the same reason as the tool catalogue below.
    const prefs = await uiPrefsStore.readUIPrefs();
    return presentationService.buildLlmStateDto({
      encryptionAvailable,
      config: { ...config, presets: presetsWire },
      chatTarget,
      apiKeyDecryptable,
      locale: prefs.appLocale,
    });
  });

  function mergeProviderPatchIntoConfig(config, providerId, patch) {
    return mergeProviderPatchIntoConfigImpl({ safeStorage, providerCatalog }, config, providerId, patch);
  }

  ipcMain.handle(REQ.SETTINGS_SET_ACTIVE_PRESET, async (_event, presetId) => {
    // Ausdrueckliche Wahl in der Chat-Leiste: gilt fuer den laufenden Chat und
    // wird der Standard fuer neue (Issue #211).
    const result = await applyActivePreset(
      { llmConfigStore, providerCatalog, safeStorage },
      presetId,
      { makeDefault: true }
    );
    if (!result.ok) return result;
    await chatSessionSettings?.rememberPreset(presetId.trim());
    return createSettingsOk();
  });

  // Schreibt System-Prompt, Sprache, Tool-Auswahl und die uebrigen UI-Werte.
  // false heisst: der Schreibversuch selbst ist fehlgeschlagen.
  async function writeUiPrefsPatch(uiPatch) {
    try {
      await uiPrefsStore.updateUIPrefs(async (out) => Object.assign(out, uiPatch));
      if ('appLocale' in uiPatch) onAppLocaleChanged?.(uiPatch.appLocale);
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
  // uebernommen wurde und was nicht (Issue #97). The reason goes into the
  // sentence as a message of its own, so both read in one language (#308).
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

  ipcMain.handle(REQ.SETTINGS_COMMIT_SETTINGS, async (_event, payload) => {
    const uiPatch = normalizeUiPrefsPatch(payload?.uiPrefs);
    const rawPresets = Array.isArray(payload?.presets) ? payload.presets : [];
    // Die Normalisierung wirft Klartext-Geheimnisse weg (und das soll sie).
    // Der Verbindungs-Entwurf je Zeile wird deshalb vorher aus dem Rohpayload
    // gezogen und unten unter dem Dateilock verschluesselt (Issue #202).
    const connectionPatches = new Map();
    for (const row of rawPresets) {
      const provider = row?.providerId ? providerCatalog.getProvider(row.providerId) : null;
      if (!provider || !hasPresetConnection(provider) || typeof row.id !== 'string') continue;
      const patch = normalizePresetConnectionPatch(row.connection, provider);
      if (patch) connectionPatches.set(row.id, patch);
    }
    const presets = rawPresets
      .map((row) => llmConfigStore.normalizePresetEntry(row))
      .filter(Boolean);
    if (presets.length === 0) {
      return rejectModelPart(createMessage('settings.error.presets.empty'), uiPatch);
    }
    const seen = new Set();
    for (const p of presets) {
      if (seen.has(p.id)) {
        return rejectModelPart(createMessage('settings.error.presets.duplicateId'), uiPatch);
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
      const presetPatch = connectionPatches.get(pr.id);
      const incomingPresetSecret = !!(presetPatch?.apiKey || presetPatch?.extraHeaders);
      if (meta.fields?.apiKey && (incomingKey || incomingPresetSecret)) {
        if (!safeStorage.isEncryptionAvailable()) {
          return rejectModelPart(createMessage('settings.error.encryptionUnavailable'), uiPatch);
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

        // Verbindung je Eintrag (Issue #202): Was bleibt, kommt aus dem
        // gespeicherten Eintrag; was neu ist, aus dem Entwurf. Verschluesselt
        // wird hier, der Klartext geht nicht weiter.
        const storedById = new Map(
          (Array.isArray(config.presets) ? config.presets : [])
            .filter((row) => row && typeof row.id === 'string')
            .map((row) => [row.id, row])
        );
        for (const pr of presets) {
          const meta = providerCatalog.getProvider(pr.providerId);
          if (!meta || !hasPresetConnection(meta)) continue;
          const merged = mergePresetConnection({ safeStorage }, {
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

        for (const pr of presets) {
          const meta = providerCatalog.getProvider(pr.providerId);
          const entry = (draft.providers && draft.providers[pr.providerId]) || {};
          if (!isProviderConfigured({ safeStorage }, meta, entry, pr)) {
            validationError = createSettingsError(
              createMessage('settings.error.accessIncomplete', { label: presetAccessLabel(meta, pr) })
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

        // Die Version kommt aus der Contract-Schicht: Eine fest verdrahtete
        // Zahl hier liesse den naechsten Lesevorgang erneut migrieren und
        // brach damit den Rollback-Vergleich (Issue #202).
        draft.version = LLM_CONFIG_VERSION;
        draft.presets = presets;
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
      return createSettingsError(createMessage('settings.error.modelsNotSaved'));
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
        return createSettingsError(createMessage('settings.error.uiNotSaved.rollbackFailed'));
      }
      return createSettingsError(createMessage('settings.error.uiNotSaved.rolledBack'));
    }

    // Auch der Dialog waehlt ausdruecklich: Der laufende Chat uebernimmt den
    // Eintrag, nicht nur der naechste neue (Issue #211).
    await chatSessionSettings?.rememberPreset(activePresetId);
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
    if (!workspaceActivation) return createSettingsError(createMessage('settings.error.folderNotOpened'));
    const activated = await workspaceActivation.activateKnownFolder(folderPath);
    if (!activated) return createSettingsError(createMessage('settings.error.folderNotOpened'));
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

  // Die Beschreibungen kommen seit #291 aus dem Katalog und haengen damit an
  // der Sprache. Gelesen wird sie hier frisch aus den Einstellungen: Beim
  // Sprachwechsel ist sie bereits geschrieben, bevor der Renderer die Liste
  // neu holt (`writeUiPrefsPatch`), und ein gemerkter Stand koennte hier nur
  // hinterherhinken.
  ipcMain.handle(REQ.SETTINGS_GET_TOOL_CATALOG, async () => {
    if (typeof toolCatalog?.listCatalog !== 'function') return { tools: [] };
    const prefs = await uiPrefsStore.readUIPrefs();
    return { tools: toolCatalog.listCatalog({ locale: prefs.appLocale }) };
  });

  // Skill-Verzeichnisse haengen am Workspace und sind damit Teil der
  // Vertrauensgrenze: der Root kommt aus dem Main, nicht aus dem Aufruf.
  async function buildSkillCatalog() {
    if (!skillCatalog || typeof skillCatalog.listCatalog !== 'function') return { skills: [] };
    const prefs = await uiPrefsStore.readUIPrefs();
    const workspaceRoot = getActiveWorkspaceRoot();
    return skillCatalog.listCatalog({
      workspaceRoot: typeof workspaceRoot === 'string' && workspaceRoot.trim() ? workspaceRoot : null,
      activeSkills: Array.isArray(prefs.activeSkills) ? prefs.activeSkills : null,
      // A system skill quotes settings pages; in the catalogue they read in the
      // language of the interface showing them (#294).
      locale: prefs.appLocale,
    });
  }

  ipcMain.handle(REQ.SETTINGS_GET_SKILL_CATALOG, async () => buildSkillCatalog());

  ipcMain.handle(REQ.SETTINGS_RELOAD_SKILLS, async () => {
    if (skillCatalog && typeof skillCatalog.reload === 'function') skillCatalog.reload();
    return buildSkillCatalog();
  });

  // Gedaechtnis (Issue #166). Der Renderer bekommt beide Ebenen mit ihren
  // Eintraegen und dem echten Pfad — der Pfad ist hier Anzeige, kein Auftrag:
  // Gelesen und geschrieben wird ausschliesslich ueber den Port, der die
  // Ebene selbst aufloest.
  async function buildMemoryState() {
    if (!memory) return { available: false, scopes: [] };
    const workspaceRoot = getActiveWorkspaceRoot();
    const prefs = await uiPrefsStore.readUIPrefs();
    const paths = memory.paths({ workspaceRoot });
    const files = await memory.load({ workspaceRoot });
    const byScope = new Map(files.map((file) => [file.scope, file]));
    return {
      available: true,
      selfEnabled: prefs.memorySelfEnabled !== false,
      scopes: MEMORY_SCOPE_ORDER.map((scope) => {
        const file = byScope.get(scope) || null;
        const text = file ? file.text : '';
        return {
          scope,
          // Ohne geoeffneten Ordner gibt es die Projekt-Ebene nicht; die
          // Oberflaeche soll das sagen statt einen leeren Kasten zu zeigen.
          path: paths[scope],
          // Der absolute Pfad ist unter `path` fuer den Tooltip da. In der
          // Karte steht die kurze Form: ein `/var/folders/…`-Pfad sprengt die
          // Zeile und sagt nichts, was der Ordnername nicht besser saegte.
          shortPath: MEMORY_SCOPE_SHORT_PATHS[scope],
          folderName:
            scope === MEMORY_SCOPES.WORKSPACE && workspaceRoot
              ? workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || null
              : null,
          enabled:
            scope === MEMORY_SCOPES.WORKSPACE
              ? prefs.memoryWorkspaceEnabled !== false
              : prefs.memoryUserEnabled !== false,
          chars: text.length,
          maxChars: MAX_MEMORY_CHARS,
          truncated: file ? file.truncated === true : false,
          entries: parseMemoryEntries(text),
        };
      }),
    };
  }

  ipcMain.handle(REQ.SETTINGS_GET_MEMORY, async () => buildMemoryState());

  ipcMain.handle(REQ.SETTINGS_FORGET_MEMORY, async (_event, payload) => {
    if (!memory) return createSettingsError(createMessage('settings.error.memory.unavailable'));
    const scope = payload?.scope;
    const line = payload?.line;
    if (!isMemoryScope(scope) || !Number.isInteger(line)) {
      return createSettingsError(createMessage('settings.error.memory.invalidRequest'));
    }
    try {
      const result = await memory.forget({ scope, line, workspaceRoot: getActiveWorkspaceRoot() });
      // Der neue Stand geht direkt mit zurueck: Ein zweiter Aufruf koennte
      // zwischen Loeschen und Nachladen eine andere Datei sehen, und dann
      // zeigte die Liste Zeilennummern, die nicht mehr stimmen.
      return { ok: true, removed: result.removed === true, state: await buildMemoryState() };
    } catch (error) {
      return createSettingsError(error?.message || createMessage('settings.error.memory.forgetFailed'));
    }
  });

  // Websuche (Issue #63). Der hinterlegte Schluessel verlaesst den Main nie —
  // der Renderer erfaehrt nur, ob einer da ist.
  ipcMain.handle(REQ.SETTINGS_GET_WEB_SEARCH_STATE, async () => ({
    available: !!webSearchSettings,
    hasApiKey: webSearchSettings ? await webSearchSettings.refresh() : false,
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  }));

  // MCP-Server (Issue #108).
  //
  // Diese Handler sehen **nie** einen entschluesselten env-Wert: was sie
  // zurueckgeben, hat der Store schon maskiert, und das Testen laeuft ueber
  // die Kennung des gespeicherten Servers statt ueber mitgeschickte Werte.
  // Die Grenze ist in test/infrastructure-boundaries.test.js festgenagelt.

  async function buildMcpCatalog() {
    if (!mcpSettings) return { servers: [], connections: [], skippedTools: [] };
    return {
      servers: await mcpSettings.listServers(),
      connections: mcpSettings.describeConnections(),
      skippedTools: mcpSettings.describeSkippedTools(),
    };
  }

  ipcMain.handle(REQ.SETTINGS_GET_MCP_CATALOG, async () => buildMcpCatalog());

  ipcMain.handle(REQ.SETTINGS_SAVE_MCP_SERVER, async (_event, input) => {
    if (!mcpSettings) return createSettingsError(createMessage('settings.error.mcp.unavailable'));
    const result = await mcpSettings.save(input);
    if (!result?.ok) {
      return { ...createSettingsError(result?.errors?.[0] || createMessage('settings.mcp.saveFailed')),
        errors: result?.errors || [] };
    }
    // Direkt uebernehmen: sonst zeigte die Oberflaeche den neuen Stand, waehrend
    // der Dienst noch mit dem alten liefe.
    await mcpSettings.reload();
    return { ...createSettingsOk(), ...(await buildMcpCatalog()) };
  });

  ipcMain.handle(REQ.SETTINGS_DELETE_MCP_SERVER, async (_event, id) => {
    if (!mcpSettings) return createSettingsError(createMessage('settings.error.mcp.unavailable'));
    const result = await mcpSettings.remove(typeof id === 'string' ? id : '');
    if (!result?.ok) {
      return { ...createSettingsError(result?.errors?.[0] || createMessage('settings.mcp.deleteFailed')),
        errors: result?.errors || [] };
    }
    await mcpSettings.reload();
    return { ...createSettingsOk(), ...(await buildMcpCatalog()) };
  });

  ipcMain.handle(REQ.SETTINGS_RELOAD_MCP_SERVERS, async () => {
    if (!mcpSettings) return createSettingsError(createMessage('settings.error.mcp.unavailable'));
    await mcpSettings.reload();
    return { ...createSettingsOk(), ...(await buildMcpCatalog()) };
  });

  ipcMain.handle(REQ.SETTINGS_TEST_MCP_SERVER, async (_event, id) => {
    if (!mcpSettings) return createSettingsError(createMessage('settings.error.mcp.unavailable'));
    const wanted = typeof id === 'string' ? id.trim() : '';
    if (!wanted) return createSettingsError(createMessage('settings.error.mcp.idMissing'));
    const result = await mcpSettings.test(wanted);
    if (!result?.status) return createSettingsError(result?.error || createMessage('settings.error.mcp.unknownServer', { id: wanted }));
    return { ...createSettingsOk(), status: result.status, tools: result.tools || [] };
  });

  ipcMain.handle(REQ.SETTINGS_SET_WEB_SEARCH_API_KEY, async (_event, apiKey) => {
    if (!webSearchSettings) {
      return createSettingsError(createMessage('settings.error.webSearch.unavailable'));
    }
    const value = typeof apiKey === 'string' ? apiKey : '';
    const result = await webSearchSettings.setApiKey(value);
    if (!result?.ok) return createSettingsError(result?.error || createMessage('settings.webSearch.saveFailed'));
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
    if ('appLocale' in patch) onAppLocaleChanged?.(patch.appLocale);
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
  if (!provider) return createSettingsError(createMessage('settings.error.provider.unknown'));
  // Bei Verbindung je Eintrag (Issue #202) gehoert nichts davon unter
  // `providers`. Der Payload kommt aus dem Renderer und wird nicht geglaubt:
  // Ein Anbieter-Zugang hier wuerde beim naechsten Lesen ohnehin wegmigriert
  // und bis dahin eine zweite, konkurrierende Wahrheit sein.
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

  // Felder des Providers „OpenAI-kompatibel" (Issue #193).
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
      // Zusatz-Header koennen ein Gateway-Token tragen und werden deshalb wie
      // der API-Key behandelt: nur verschluesselt auf die Platte, sonst gar nicht.
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

/**
 * Fuehrt die gespeicherte Verbindung eines Eintrags mit dem Entwurf zusammen
 * (Issue #202). Geheimnisse werden hier verschluesselt; ein leerer Entwurf
 * laesst alles stehen, `remove*` loescht gezielt.
 */
function mergePresetConnection({ safeStorage }, { previous, patch, provider }) {
  const next = { ...(previous && typeof previous === 'object' ? previous : {}) };
  const draft = patch && typeof patch === 'object' ? patch : {};

  for (const key of PRESET_CONNECTION_PLAIN_FIELDS) {
    if (draft[key] === undefined) continue;
    if (key === 'displayName' && !String(draft[key]).trim()) delete next.displayName;
    else next[key] = draft[key];
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
 * Aktiven Eintrag setzen — der einzige Weg dorthin (Issue #202, #211).
 *
 * `makeDefault` schreibt zusaetzlich `defaultPresetId` fort, den Standard fuer
 * neue Chats. Das tut nur eine ausdrueckliche Wahl; wird ein Chat aus dem
 * Verlauf hergestellt, aendert sich der Standard nicht.
 */
async function applyActivePreset(
  { llmConfigStore, providerCatalog, safeStorage },
  rawPresetId,
  { makeDefault = false } = {}
) {
  if (typeof rawPresetId !== 'string' || !rawPresetId.trim()) {
    return createSettingsError(createMessage('settings.error.preset.none'));
  }
  const presetId = rawPresetId.trim();
  let validationError = null;
  await llmConfigStore.updateLLMConfig(async (config) => {
    const preset = Array.isArray(config.presets)
      ? config.presets.find((p) => p && p.id === presetId)
      : null;
    if (!preset || !providerCatalog.getProvider(preset.providerId)) {
      validationError = createSettingsError(createMessage('settings.error.preset.notFound'));
      return config;
    }
    const meta = providerCatalog.getProvider(preset.providerId);
    const entry = (config.providers && config.providers[preset.providerId]) || {};
    if (!isProviderConfigured({ safeStorage }, meta, entry, preset)) {
      validationError = createSettingsError(createMessage('settings.error.preset.notConfigured'));
      return config;
    }
    config.activePresetId = presetId;
    if (makeDefault) config.defaultPresetId = presetId;
    config.activeProvider = preset.providerId;
    config.providers = config.providers || {};
    // Bei Verbindung je Eintrag gibt es keinen Anbieter-Eintrag mehr, in den
    // das aktive Modell gespiegelt werden koennte — und er wuerde beim
    // naechsten Lesen ohnehin wieder wegmigriert (Issue #202).
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
 * Taugt der Eintrag noch als Modell dieses Chats (Issue #211)? Geloescht oder
 * unvollstaendig konfiguriert heisst nein — dann greift der Standard.
 */
async function isPresetUsable({ llmConfigStore, providerCatalog, safeStorage }, rawPresetId) {
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

/** Beschriftung einer unvollstaendigen Zeile: ihr Name, sonst der des Anbieters. */
function presetAccessLabel(meta, preset) {
  const name = preset?.connection?.displayName;
  return typeof name === 'string' && name.trim() ? name.trim() : meta.name;
}

/**
 * @param {object} [preset] Bei `connectionPerPreset` entscheidet die Verbindung
 *   des Eintrags, nicht die des Anbieters (Issue #202).
 */
function isProviderConfigured({ safeStorage }, meta, entry, preset) {
  if (hasPresetConnection(meta)) {
    const conn = preset?.connection || {};
    if (!String(conn.baseUrl || meta.defaultBaseUrl || '').trim()) return false;
    // Ein gespeicherter, aber nicht mehr lesbarer Schluessel ist schlimmer als
    // gar keiner: Die Anfrage ginge ohne Authentifizierung hinaus.
    if (conn.apiKeyEnc && !canDecryptApiKeyEnc(safeStorage, conn.apiKeyEnc)) return false;
    return true;
  }
  const baseUrlEff = meta.fields?.baseUrl
    ? (entry.baseUrl || meta.defaultBaseUrl || '')
    : '';
  // Ein Anbieter mit optionalem Key (Issue #193) gilt mit gesetzter Server-URL
  // als vollstaendig — ein lokaler Server ohne Key ist kein halber Zugang.
  const needsKey = meta.fields?.apiKey && meta.optionalApiKey !== true;
  return needsKey
    ? canDecryptApiKeyEnc(safeStorage, entry.apiKeyEnc)
    : meta.fields?.baseUrl
      ? !!String(baseUrlEff).trim()
      : true;
}

module.exports = {
  registerSettingsHandlers,
  applyActivePreset,
  isPresetUsable,
  mergeProviderPatchIntoConfigImpl,
  mergePresetConnection,
  canDecryptApiKeyEnc,
};
