const { createRequestLifecycle } = require('./request-lifecycle');
const {
  createSettingsOk,
  createSettingsError,
  normalizeListModelsRequest,
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
const { createTranslator } = require('../../shared/i18n');
const { CONFIRMATION_ACTIONS, createRefusingConfirmation } = require('../../application/permissions/user-confirmation');
const { mcpLaunchDialog } = require('../services/settings-confirmation-dialogs');

/**
 * What the handlers use of each collaborator the composition root hands in.
 * The model settings and the interface preferences are decided in
 * `services/settings-service.js` (#1006); these handlers parse and delegate.
 *
 * @typedef {Pick<ReturnType<typeof import('../services/settings-service').createSettingsService>,
 *   'describeLlmState' | 'setReasoningEffort' | 'setActivePreset' | 'setUiPrefs' | 'commitSettings'>} SettingsService
 * @typedef {Pick<ReturnType<typeof import('../services/workspace-activation').createWorkspaceActivation>,
 *   'activateKnownFolder'>} SettingsWorkspaceActivation
 * @typedef {Pick<ReturnType<typeof import('../services/skills-service').createSkillsService>,
 *   'listCatalog' | 'reload'>} SettingsSkillCatalog
 * @typedef {{ listCatalog: (options: { locale?: string }) => unknown }} SettingsToolCatalog
 * @typedef {import('../../shared/contracts/message').Message} Message
 * @typedef {{ refresh: () => Promise<boolean>,
 *   setApiKey: (plaintext: string) => Promise<{ ok: boolean, error?: Message|string, hasApiKey?: boolean }> }} SettingsWebSearch
 * @typedef {Pick<ReturnType<typeof import('../services/image-generation-settings').createImageGenerationSettings>,
 *   'refresh' | 'listModels'>} SettingsImageGeneration
 * @typedef {Pick<ReturnType<typeof import('../services/mcp-settings').createMcpSettings>,
 *   'listServers' | 'describeConnections' | 'describeSkippedTools' | 'hasLoadFailed' | 'launchConfirmation'
 *   | 'save' | 'remove' | 'reload' | 'test'>} SettingsMcp
 * @typedef {{ refresh: () => Promise<object> }} SettingsExecutionTool  python or shell: what was found, re-detected
 */

/**
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {SettingsService} deps.settings
 * @param {import('../ports/ui-prefs-store-port').UiPrefsStorePort} deps.uiPrefsStore
 * @param {import('../ports/workspace-folder-store-port').WorkspaceFolderStorePort} deps.workspaceFolderStore
 * @param {import('../ports/provider-model-listing-port').ProviderModelListingPort} deps.providerModels
 * @param {Record<string, string>} deps.REQ
 * @param {SettingsWorkspaceActivation|null} [deps.workspaceActivation]
 * @param {() => string|null} [deps.getActiveWorkspaceRoot]
 * @param {ReturnType<typeof import('../services/settings-presentation-service').createSettingsPresentationService>} deps.presentation
 * @param {SettingsToolCatalog} deps.toolCatalog
 * @param {SettingsSkillCatalog|null} [deps.skillCatalog]
 * @param {import('../../application/ports/memory-port').MemoryPort|null} [deps.memory]
 * @param {SettingsWebSearch|null} [deps.webSearchSettings]
 * @param {SettingsImageGeneration|null} [deps.imageGenerationSettings]
 * @param {SettingsMcp|null} [deps.mcpSettings]
 * @param {SettingsExecutionTool|null} [deps.pythonSettings]
 * @param {SettingsExecutionTool|null} [deps.shellSettings]
 * @param {import('../../application/ports/user-confirmation-port').UserConfirmationPort} [deps.confirmations]
 * @param {() => Promise<Map<string, number>>} [deps.describeMcpContextCosts]  server id → estimated tokens (#1219)
 */
function registerSettingsHandlers({
  ipcMain,
  settings,
  uiPrefsStore,
  workspaceFolderStore,
  providerModels,
  REQ,
  workspaceActivation = null,
  getActiveWorkspaceRoot = () => null,
  presentation,
  toolCatalog,
  skillCatalog = null,
  memory = null,
  webSearchSettings = null,
  imageGenerationSettings = null,
  mcpSettings = null,
  pythonSettings = null,
  shellSettings = null,
  /**
   * The user-confirmation port (#980). A local MCP command stored is asked
   * through it (#1104); without a person at the machine it does not go
   * through — the store takes none without its receipt.
   */
  confirmations = createRefusingConfirmation(),
  describeMcpContextCosts = async () => new Map(),
}) {
  if (!presentation || typeof presentation.buildLlmStateDto !== 'function') {
    throw new Error('registerSettingsHandlers requires an injected settings presentation service.');
  }
  if (!settings || typeof settings.commitSettings !== 'function') {
    throw new Error('registerSettingsHandlers requires an injected settings service.');
  }
  const presentationService = presentation;

  ipcMain.handle(REQ.SETTINGS_GET_LLM_STATE, async () =>
    presentationService.buildLlmStateDto(await settings.describeLlmState()));

  ipcMain.handle(REQ.SETTINGS_SET_REASONING_EFFORT, async (_event, rawLevel) => settings.setReasoningEffort(rawLevel));

  ipcMain.handle(REQ.SETTINGS_SET_ACTIVE_PRESET, async (_event, presetId) => settings.setActivePreset(presetId));

  ipcMain.handle(REQ.SETTINGS_COMMIT_SETTINGS, async (_event, payload) => settings.commitSettings(payload));

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
      activeWorkspaceSkills: prefs.activeWorkspaceSkills || null,
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
    // The entry's text names it; the line alone may point at another one by
    // now (#577). An entry is capped far below this.
    const text = typeof payload?.text === 'string' ? payload.text.slice(0, MAX_MEMORY_CHARS) : '';
    if (!isMemoryScope(scope) || !Number.isInteger(line) || !text.trim()) {
      return createSettingsError(createMessage('settings.error.memory.invalidRequest'));
    }
    try {
      const result = await memory.forget({ scope, line, text, workspaceRoot: getActiveWorkspaceRoot() });
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
  }));

  // Image generation (#85). The key never leaves main — the renderer learns
  // whether there is one, which model draws, and what else the key reaches.
  ipcMain.handle(REQ.SETTINGS_GET_IMAGE_GENERATION_STATE, async () => {
    if (!imageGenerationSettings) return { available: false, hasApiKey: false, model: '', chosenModel: '', defaultModel: '' };
    return { available: true, ...(await imageGenerationSettings.refresh()) };
  });
  const imageModelRequests = createRequestLifecycle();
  ipcMain.handle(REQ.SETTINGS_CANCEL_IMAGE_MODELS, (event) => imageModelRequests.cancel(event.sender));
  ipcMain.handle(REQ.SETTINGS_LIST_IMAGE_MODELS, async (event) => {
    if (!imageGenerationSettings) return { error: createMessage('settings.imageGeneration.error.noKey') };
    return imageModelRequests.run(event.sender, (signal) => imageGenerationSettings.listModels({ signal }));
  });

  // MCP-Server (Issue #108).
  //
  // Diese Handler sehen **nie** einen entschluesselten env-Wert: was sie
  // zurueckgeben, hat der Store schon maskiert, und das Testen laeuft ueber
  // die Kennung des gespeicherten Servers statt ueber mitgeschickte Werte.
  // Die Grenze ist in test/infrastructure-boundaries.test.js festgenagelt.

  // The catalogue also answers save, delete and reload. Its connections come
  // masked from the composition, never raw from the service (CR-B14-01).
  async function buildMcpCatalog() {
    if (!mcpSettings) return { servers: [], connections: [], skippedTools: [], loadFailed: false };
    const costs = await describeMcpContextCosts().catch(() => new Map() /* without the figures the servers are listed as before */);
    return {
      servers: await mcpSettings.listServers(),
      // What a connected server's tools add to every request (#1219); null
      // while its schemas are not known.
      connections: (await mcpSettings.describeConnections()).map((connection) => ({
        ...connection,
        contextTokens: costs.has(connection.serverId) ? costs.get(connection.serverId) : null,
      })),
      skippedTools: mcpSettings.describeSkippedTools(),
      // The saved servers never reached the service — at start-up, say (#1002).
      loadFailed: mcpSettings.hasLoadFailed?.() === true,
    };
  }

  ipcMain.handle(REQ.SETTINGS_GET_MCP_CATALOG, async () => buildMcpCatalog());

  /**
   * A local command that is new or changed is asked through the port before
   * it is stored (#1104). Null: nothing to ask; `declined`: the person said
   * no, or nobody could be asked.
   *
   * @param {Record<string, unknown>} input
   */
  async function confirmMcpLaunch(input) {
    const needed = await mcpSettings?.launchConfirmation?.(input);
    if (!needed) return { receipt: null };
    const t = createTranslator((await uiPrefsStore.readUIPrefs()).appLocale);
    const outcome = await confirmations.confirm({
      action: CONFIRMATION_ACTIONS.MCP_LAUNCH,
      subject: needed.subject,
      prompt: mcpLaunchDialog(needed.server, t),
    });
    if (outcome?.confirmed === true && outcome.receipt) return { receipt: outcome.receipt };
    return { declined: true };
  }

  ipcMain.handle(REQ.SETTINGS_SAVE_MCP_SERVER, async (_event, input) => {
    if (!mcpSettings) return createSettingsError(createMessage('settings.error.mcp.unavailable'));
    const launch = await confirmMcpLaunch(input);
    if (launch.declined) {
      const error = createMessage('mcp.error.launchNotConfirmed');
      return { ...createSettingsError(error), errors: [error], notConfirmed: true };
    }
    const result = await mcpSettings.save(input, { confirmation: launch.receipt });
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

  ipcMain.handle(REQ.SETTINGS_SET_UI_PREFS, async (_event, partial) => settings.setUiPrefs(partial));
}

module.exports = { registerSettingsHandlers };
