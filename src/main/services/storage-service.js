const { randomUUID } = require('crypto');
const {
  clampHistoryCharLimit,
  clampSidebarWidth,
  clampChatPanelWidth,
  normalizePresetWire,
  normalizeUiPrefs,
  extractPresetOptions,
  hasPresetConnection,
  normalizeStoredPresetConnection,
  LLM_CONFIG_VERSION,
} = require('../../shared/contracts/settings');
const { APP_LOCALES } = require('../../shared/contracts/enums');
const {
  maskStoredMcpEnv,
  normalizeKnownTools,
  normalizeStoredMcpEnv,
  validateMcpServerConfig,
  validateMcpServerInput,
} = require('../../shared/contracts/mcp');
const { createMessage } = require('../../shared/contracts/message');
const {
  inferChatTitle,
  sanitizeChatMessagesForStore,
  normalizeTokenUsageForStore,
  normalizeLoadedMessages,
  normalizeSessionForStore: buildNormalizedSessionForStore,
  normalizeSessionForLoad,
} = require('./chat-history-normalization');
const { renameWithRetry, readFileWithRetry } = require('./rename-with-retry');
const { CHAT_HISTORY_UNREADABLE } = require('../ports/chat-history-store-port');

function createStorageService({
  app,
  safeStorage,
  fs,
  path,
  providerCatalog,
  maxChatSessions,
  maxFolderHistory,
  defaultProviderId,
  log = console,
  platform = process.platform,
}) {
  const LLM_CONFIG_FILENAME = 'llm-config.json';
  const LEGACY_OPENAI_CONFIG_FILENAME = 'openai-config.json';
  const LAST_FOLDER_FILENAME = 'last-folder.json';
  const FOLDER_HISTORY_FILENAME = 'folder-history.json';
  const UI_PREFS_FILENAME = 'ui-preferences.json';
  const CHAT_HISTORY_FILENAME = 'chat-history.json';
  const WEB_SEARCH_CONFIG_FILENAME = 'web-search-config.json';
  const MCP_CONFIG_FILENAME = 'mcp-servers.json';

  const MAX_CHAT_SESSIONS = maxChatSessions;
  const MAX_FOLDER_HISTORY = maxFolderHistory;
  const DEFAULT_PROVIDER = defaultProviderId;

  const NO_WORKSPACE_KEY = '__none__';

  // Only the v4 -> v5 migration may still name the retired provider (#194).
  const RETIRED_MLX_LM_ID = 'mlx-lm';
  const MLX_LM_DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1';
  const OPENAI_COMPATIBLE_ID = 'openai-compatible';
  const KNOWN_LLM_CONFIG_VERSIONS = Object.freeze([2, 3, 4, LLM_CONFIG_VERSION]);
  const MCP_CONFIG_VERSION = 1;

  const fileLocks = new Map();

  async function writeJsonAtomic(targetPath, data) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const tmp = `${targetPath}.tmp-${randomUUID()}`;
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
    try {
      // These files are read all the time (every preferences read, every
      // chat run), and on Windows a reader, the indexer or a virus scanner
      // can hold the target for a moment (#472, as for the policy in #419).
      await renameWithRetry(fs, tmp, targetPath, { platform });
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  /**
   * Reads a file that is about to be written back (#473). Only a missing file
   * means "start from the defaults". Any other error — after the retry for
   * Windows' transient locks — is thrown, so the caller writes nothing and the
   * file on disk stays as it was. A read for display may still fall back; the
   * harm is only in writing the defaults over what is there.
   */
  async function readForUpdate(filePath) {
    try {
      return await readFileWithRetry(fs, filePath, { platform });
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  function parseJson(raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  function isJsonObject(data) {
    return !!data && typeof data === 'object' && !Array.isArray(data);
  }

  /**
   * Moves a file that is there but cannot be understood out of the way
   * before anything is written to its path (#557) — broken JSON, a stray
   * edit, or a version newer than this build knows (an older release
   * installed over a newer one). The copy keeps every byte; the caller then
   * starts from its defaults as before. A move that fails throws, so the
   * caller writes nothing.
   */
  async function setAsideUnreadable(filePath) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${filePath}.unreadable-${stamp}`;
    try {
      await renameWithRetry(fs, filePath, target, { platform });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      log?.warn?.(`[storage] ${path.basename(filePath)} could not be understood and could not be moved aside, left it as it is: ${error?.message || error}`);
      throw error;
    }
    log?.warn?.(`[storage] ${path.basename(filePath)} could not be understood; kept it as ${target}`);
  }

  /**
   * Reads a JSON file that is about to be written back, under its file lock
   * (#473, #557). `null` means "start from the defaults": the file is
   * missing, or it was not understood and has just been moved aside.
   */
  async function readJsonForUpdate(filePath, isUnderstood) {
    const raw = await readForUpdate(filePath);
    if (raw === null) return null;
    const data = parseJson(raw);
    if (isUnderstood(data)) return data;
    await setAsideUnreadable(filePath);
    return null;
  }

  function withFileLock(targetPath, fn) {
    const prev = fileLocks.get(targetPath) || Promise.resolve();
    const task = prev.then(fn, fn);
    fileLocks.set(targetPath, task.catch(() => {}));
    return task;
  }

  function withChatHistoryLock(fn) {
    return withFileLock(getChatHistoryPath(), fn);
  }

  function getLLMConfigPath() {
    return path.join(app.getPath('userData'), LLM_CONFIG_FILENAME);
  }

  function getLegacyOpenAIConfigPath() {
    return path.join(app.getPath('userData'), LEGACY_OPENAI_CONFIG_FILENAME);
  }

  function defaultLLMConfig() {
    return {
      version: LLM_CONFIG_VERSION,
      activeProvider: DEFAULT_PROVIDER,
      activePresetId: null,
      // Standard fuer neue Chats (Issue #211). Fehlt der Wert — etwa in einer
      // Konfiguration von vor der Aenderung —, gilt `activePresetId`.
      defaultPresetId: null,
      presets: [],
      providers: {},
    };
  }

  function normalizePresetEntry(raw) {
    return normalizePresetWire(raw, (id) => providerCatalog.getProvider(id));
  }

  function buildProviderOptionsFromPreset(preset, provider) {
    const opts = extractPresetOptions(preset, provider);
    return Object.keys(opts).length > 0 ? opts : undefined;
  }

  function withLegacyReasoningEffort(target, providerOptions) {
    if (providerOptions?.reasoningEffort) {
      target.reasoningEffort = providerOptions.reasoningEffort;
    } else {
      target.reasoningEffort = null;
    }
    return target;
  }

  /** Chat-Ziel aus LLM-Konfiguration (Preset-first, Fallback aktiv/Provider-Modell). */
  function resolveChatModelTarget(llmConfig) {
    const list = Array.isArray(llmConfig.presets) ? llmConfig.presets : [];
    const preset = list.find((p) => p && p.id === llmConfig.activePresetId);
    if (preset && providerCatalog.getProvider(preset.providerId)) {
      const pMeta = providerCatalog.getProvider(preset.providerId);
      const providerOptions = buildProviderOptionsFromPreset(preset, pMeta);
      const target = {
        providerId: preset.providerId,
        // Ohne die Eintrags-Kennung laesst sich bei `connectionPerPreset` die
        // Verbindung nicht mehr aufloesen (Issue #202).
        presetId: preset.id,
        model: typeof preset.model === 'string' && preset.model.trim()
          ? preset.model.trim()
          : pMeta.defaultModel,
      };
      if (providerOptions) target.providerOptions = providerOptions;
      return withLegacyReasoningEffort(target, providerOptions);
    }
    const ap = llmConfig.activeProvider || DEFAULT_PROVIDER;
    const pMeta = providerCatalog.getProvider(ap);
    const entry = (llmConfig.providers && llmConfig.providers[ap]) || {};
    return withLegacyReasoningEffort({
      providerId: ap,
      model:
        typeof entry.model === 'string' && entry.model.trim()
          ? entry.model.trim()
          : (pMeta && pMeta.defaultModel) || '',
    }, undefined);
  }

  async function migrateLLMConfigToV3(existing, { persist = true } = {}) {
    const out = { ...existing };
    out.version = 3;
    if (!Array.isArray(out.presets)) out.presets = [];
    if (
      (!out.presets || out.presets.length === 0)
      && typeof out.activeProvider === 'string'
      && providerCatalog.getProvider(out.activeProvider)
    ) {
      const ap = out.activeProvider;
      const pMeta = providerCatalog.getProvider(ap);
      const entry = (out.providers && out.providers[ap]) || {};
      const model =
        typeof entry.model === 'string' && entry.model.trim()
          ? entry.model.trim()
          : pMeta.defaultModel;
      const id = randomUUID();
      out.presets = [
        {
          id,
          providerId: ap,
          model,
          reasoningEffort: null,
          menuVisible: true,
        },
      ];
      out.activePresetId = id;
    }
    if (out.presets.length > 0) {
      if (!out.activePresetId || !out.presets.some((p) => p && p.id === out.activePresetId)) {
        out.activePresetId = out.presets[0].id;
      }
      const cur = resolveChatModelTarget(out);
      out.activeProvider = cur.providerId;
    }
    if (persist) {
      await writeLLMConfig(out);
    }
    return out;
  }

  /**
   * v3 -> v4 (Issue #202): Die Verbindung wandert vom Anbieter in den Eintrag.
   *
   * `providers['openai-compatible']` wird in **jeden** Eintrag dieses Anbieters
   * kopiert und danach aus `providers` entfernt. Idempotent: Eine Datei, die
   * schon auf v4 steht, wird nicht angefasst, und ein Eintrag, der bereits eine
   * Verbindung hat, behaelt seine eigene.
   *
   * Ohne diesen Schritt verlieren bestehende Eintraege ihre Server-URL und
   * fallen beim naechsten Start auf den Standard zurueck — der Chat ginge
   * stillschweigend an die falsche Adresse.
   */
  async function migrateLLMConfigToV4(existing, { persist = true } = {}) {
    const out = { ...existing };
    const presets = Array.isArray(out.presets) ? out.presets : [];
    const providers = (out.providers && typeof out.providers === 'object') ? { ...out.providers } : {};
    let changed = false;

    for (const providerId of Object.keys(providers)) {
      const provider = providerCatalog.getProvider(providerId);
      if (!provider || !hasPresetConnection(provider)) continue;
      const alt = providers[providerId] || {};
      for (const preset of presets) {
        if (!preset || preset.providerId !== providerId) continue;
        if (preset.connection && typeof preset.connection === 'object') continue;
        const connection = normalizeStoredPresetConnection(alt, provider);
        // Ohne Server-URL im Altbestand greift der Standard des Anbieters —
        // genau das, was der Eintrag vorher zur Laufzeit auch bekam.
        if (!connection.baseUrl && provider.defaultBaseUrl) {
          connection.baseUrl = provider.defaultBaseUrl;
        }
        preset.connection = connection;
        changed = true;
      }
      // Der Anbieter-Eintrag hat ausgedient; `model` daran war ohnehin nur ein
      // Abbild des aktiven Presets.
      delete providers[providerId];
      changed = true;
    }

    out.providers = providers;
    out.presets = presets;
    out.version = 4;
    if (persist && (changed || existing.version !== 4)) {
      await writeLLMConfig(out);
    }
    return out;
  }

  /**
   * v4 -> v5 (issue #194): the dedicated `mlx-lm` provider is gone. Every entry
   * that pointed at it becomes an `openai-compatible` entry with its own
   * connection — display name "MLX-LM", the server URL it used so far, Chat
   * Completions, no API key. Entry ids stay, so `activePresetId` and
   * `defaultPresetId` keep pointing at the same row.
   *
   * Without this step those entries would vanish from the picker without a
   * word: the catalog no longer knows `mlx-lm`, and `normalizePresetWire`
   * drops every entry whose provider it cannot resolve.
   *
   * Works on the raw id on purpose — the catalog cannot answer for `mlx-lm`
   * any more. Idempotent: once nothing refers to `mlx-lm`, nothing changes.
   */
  async function migrateLLMConfigToV5(existing, { persist = true } = {}) {
    const out = { ...existing };
    const providers = (out.providers && typeof out.providers === 'object') ? { ...out.providers } : {};
    let presets = Array.isArray(out.presets) ? out.presets : [];
    const compat = providerCatalog.getProvider(OPENAI_COMPATIBLE_ID);
    const legacy = providers[RETIRED_MLX_LM_ID];
    let changed = false;

    const refersToMlx = presets.some((p) => p && p.providerId === RETIRED_MLX_LM_ID)
      || out.activeProvider === RETIRED_MLX_LM_ID
      || legacy !== undefined;
    if (compat && refersToMlx) {
      const alt = (legacy && typeof legacy === 'object') ? legacy : {};
      const baseUrl = typeof alt.baseUrl === 'string' && alt.baseUrl.trim()
        ? alt.baseUrl.trim()
        : MLX_LM_DEFAULT_BASE_URL;
      const connectionFor = () => normalizeStoredPresetConnection(
        { displayName: 'MLX-LM', baseUrl, apiStyle: 'chat' },
        compat
      );

      presets = presets.map((p) => (
        p && p.providerId === RETIRED_MLX_LM_ID
          ? { ...p, providerId: OPENAI_COMPATIBLE_ID, connection: connectionFor() }
          : p
      ));
      // A config from before presets existed only knows `activeProvider`; the
      // v3 step could not turn that into an entry because the catalog no
      // longer resolves `mlx-lm`. Do it here, or the model would be lost.
      if (out.activeProvider === RETIRED_MLX_LM_ID && presets.length === 0) {
        const id = randomUUID();
        presets = [...presets, {
          id,
          providerId: OPENAI_COMPATIBLE_ID,
          model: typeof alt.model === 'string' ? alt.model.trim() : '',
          reasoningEffort: null,
          menuVisible: true,
          connection: connectionFor(),
        }];
        out.activePresetId = id;
      }
      if (out.activeProvider === RETIRED_MLX_LM_ID) out.activeProvider = OPENAI_COMPATIBLE_ID;
      delete providers[RETIRED_MLX_LM_ID];
      changed = true;
    }

    out.providers = providers;
    out.presets = presets;
    out.version = 5;
    if (persist && (changed || existing.version !== 5)) {
      await writeLLMConfig(out);
    }
    return out;
  }

  /** v3 file -> current version, persisting only at the end. */
  async function migrateFromV3(existing, { persist }) {
    const v4 = await migrateLLMConfigToV4(existing, { persist: false });
    return migrateLLMConfigToV5(v4, { persist });
  }

  /**
   * `unreadable`: the file is there but could not be read (#473). That is not
   * a missing file, and the migrations below must not write their defaults
   * over it. With `forUpdate` such a read throws instead.
   */
  async function readLLMConfigRaw({ forUpdate = false } = {}) {
    if (forUpdate) {
      return { data: await readJsonForUpdate(getLLMConfigPath(), isKnownLLMConfig), unreadable: false };
    }
    let raw;
    try {
      raw = await fs.readFile(getLLMConfigPath(), 'utf8');
    } catch (error) {
      return { data: null, unreadable: error?.code !== 'ENOENT' };
    }
    // A file that is there but not understood counts as unreadable too
    // (#557): shown as defaults, and moved aside before the next save.
    const data = parseJson(raw);
    return isKnownLLMConfig(data) ? { data, unreadable: false } : { data: null, unreadable: true };
  }

  /** A version `readLLMConfig` can read or migrate — nothing newer (#557). */
  function isKnownLLMConfig(data) {
    return isJsonObject(data)
      && KNOWN_LLM_CONFIG_VERSIONS.includes(data.version)
      && !!data.providers;
  }

  async function readLegacyOpenAIConfig() {
    try {
      const raw = await fs.readFile(getLegacyOpenAIConfigPath(), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Standard fuer neue Chats (Issue #211). Eine Konfiguration von vorher kennt
   * das Feld nicht — dann gilt einmalig der aktive Eintrag. Ohne diesen Schritt
   * wanderte der Standard mit: Das Herstellen eines alten Chats setzt
   * `activePresetId`, und der naechste neue Chat haette dessen Modell geerbt.
   */
  function withDefaultPresetId(config) {
    if (!config || typeof config !== 'object') return config;
    if (!config.defaultPresetId) config.defaultPresetId = config.activePresetId || null;
    return config;
  }

  async function readLLMConfig({ persistMigration = true, forUpdate = false } = {}) {
    const { data: existing, unreadable } = await readLLMConfigRaw({ forUpdate });
    // Shown as defaults, but never written over the file that is there (#473).
    const persist = persistMigration && !unreadable;
    if (existing && existing.version === LLM_CONFIG_VERSION && existing.providers) {
      if (!existing.providers || typeof existing.providers !== 'object') {
        existing.providers = {};
      }
      if (!existing.activeProvider) existing.activeProvider = DEFAULT_PROVIDER;
      if (!Array.isArray(existing.presets)) existing.presets = [];
      return withDefaultPresetId(existing);
    }
    if (existing && existing.version === 4 && existing.providers) {
      if (!existing.activeProvider) existing.activeProvider = DEFAULT_PROVIDER;
      if (!Array.isArray(existing.presets)) existing.presets = [];
      return withDefaultPresetId(await migrateLLMConfigToV5(existing, { persist }));
    }
    if (existing && existing.version === 3 && existing.providers) {
      if (!existing.providers || typeof existing.providers !== 'object') {
        existing.providers = {};
      }
      if (!existing.activeProvider) existing.activeProvider = DEFAULT_PROVIDER;
      if (!Array.isArray(existing.presets)) existing.presets = [];
      return withDefaultPresetId(await migrateFromV3(existing, { persist }));
    }
    if (existing && existing.version === 2 && existing.providers) {
      if (!existing.providers || typeof existing.providers !== 'object') {
        existing.providers = {};
      }
      if (!existing.activeProvider) existing.activeProvider = DEFAULT_PROVIDER;
      const v3 = await migrateLLMConfigToV3(existing, { persist: false });
      return withDefaultPresetId(await migrateFromV3(v3, { persist }));
    }
    // Migrate from legacy openai-config.json (if present)
    const legacy = await readLegacyOpenAIConfig();
    const migrated = defaultLLMConfig();
    if (legacy && legacy.apiKeyEnc) {
      migrated.providers.openai = {
        apiKeyEnc: legacy.apiKeyEnc,
        model: legacy.model || providerCatalog.getProvider('openai').defaultModel,
      };
      migrated.activeProvider = 'openai';
    }
    const withV3 = await migrateLLMConfigToV3(migrated, { persist: false });
    return withDefaultPresetId(await migrateFromV3(withV3, { persist }));
  }

  async function writeLLMConfig(config) {
    await withFileLock(getLLMConfigPath(), () => writeJsonAtomic(getLLMConfigPath(), config));
  }

  async function updateLLMConfig(updater) {
    return withFileLock(getLLMConfigPath(), async () => {
      const config = await readLLMConfig({ persistMigration: false, forUpdate: true });
      const updated = await updater(config);
      await writeJsonAtomic(getLLMConfigPath(), updated);
      return updated;
    });
  }

  function decryptIfPossible(b64) {
    if (!b64) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.decryptString(Buffer.from(b64, 'base64'));
    } catch {
      return null;
    }
  }

  function encryptIfPossible(plaintext) {
    if (!plaintext || !safeStorage.isEncryptionAvailable()) return null;
    try {
      return safeStorage.encryptString(plaintext).toString('base64');
    } catch {
      return null;
    }
  }

  /**
   * Verbindung eines Eintrags (Issue #202). Klartext-Geheimnisse entstehen hier
   * und bleiben im Main-Prozess.
   */
  function connectionConfigFromPreset(provider, preset) {
    const conn = (preset && typeof preset.connection === 'object' && preset.connection) || {};
    const out = { model: preset?.model || provider.defaultModel };
    out.baseUrl = conn.baseUrl || provider.defaultBaseUrl || '';
    out.displayName = typeof conn.displayName === 'string' ? conn.displayName : '';
    out.apiStyle = typeof conn.apiStyle === 'string' && conn.apiStyle
      ? conn.apiStyle
      : (provider.defaultApiStyle || 'chat');
    out.insecureTls = typeof conn.insecureTls === 'boolean'
      ? conn.insecureTls
      : provider.defaultInsecureTls === true;
    out.supportsImages = typeof conn.supportsImages === 'boolean'
      ? conn.supportsImages
      : provider.defaultSupportsImages === true;
    out.sendTools = typeof conn.sendTools === 'boolean'
      ? conn.sendTools
      : provider.defaultSendTools !== false;
    const apiKey = decryptIfPossible(conn.apiKeyEnc);
    if (apiKey) out.apiKey = apiKey;
    const extraHeaders = decryptIfPossible(conn.extraHeadersEnc);
    if (extraHeaders) out.extraHeaders = extraHeaders;
    return out;
  }

  /**
   * @param {string} providerId
   * @param {{presetId?: string}} [scope] Bei `connectionPerPreset` Pflicht —
   *   ohne den Eintrag ist die Verbindung nicht bestimmbar.
   */
  async function getEffectiveProviderConfig(providerId, { presetId } = {}) {
    const provider = providerCatalog.getProvider(providerId);
    if (!provider) return null;
    const config = await readLLMConfig();
    if (hasPresetConnection(provider)) {
      const presets = Array.isArray(config.presets) ? config.presets : [];
      const preset = presets.find((p) => p && p.id === presetId && p.providerId === providerId);
      // Ohne passenden Eintrag bleibt nur der nackte Standard des Anbieters —
      // besser als eine fremde Verbindung zu erraten.
      return connectionConfigFromPreset(provider, preset || null);
    }
    const entry = (config.providers && config.providers[providerId]) || {};
    const out = { model: entry.model || provider.defaultModel };
    if (provider.fields?.apiKey && entry.apiKeyEnc) {
      const k = decryptIfPossible(entry.apiKeyEnc);
      if (k) out.apiKey = k;
    }
    if (provider.fields?.baseUrl) {
      out.baseUrl = entry.baseUrl || provider.defaultBaseUrl || '';
    }
    if (provider.fields?.insecureTls) {
      // typeof check, damit ein bewusst gesetztes "false" nicht still auf
      // den Default zurueckfaellt.
      out.insecureTls = typeof entry.insecureTls === 'boolean'
        ? entry.insecureTls
        : (provider.defaultInsecureTls === true);
    }
    // Felder des Providers „OpenAI-kompatibel" (Issue #193). Sie beschreiben
    // die Verbindung, nicht die Modellwahl, und liegen deshalb hier statt im
    // Preset.
    if (provider.fields?.displayName) {
      out.displayName = typeof entry.displayName === 'string' ? entry.displayName.trim() : '';
    }
    if (provider.fields?.apiStyle) {
      out.apiStyle = typeof entry.apiStyle === 'string' && entry.apiStyle.trim()
        ? entry.apiStyle.trim()
        : (provider.defaultApiStyle || 'chat');
    }
    if (provider.fields?.extraHeaders && entry.extraHeadersEnc) {
      // Wie der API-Key ein Geheimnis: verschluesselt auf der Platte, und wenn
      // der Schluessel nicht mehr passt, lieber gar nichts als Datenmuell.
      const headers = decryptIfPossible(entry.extraHeadersEnc);
      if (headers) out.extraHeaders = headers;
    }
    if (provider.fields?.supportsImages) {
      out.supportsImages = typeof entry.supportsImages === 'boolean'
        ? entry.supportsImages
        : (provider.defaultSupportsImages === true);
    }
    if (provider.fields?.sendTools) {
      out.sendTools = typeof entry.sendTools === 'boolean'
        ? entry.sendTools
        : (provider.defaultSendTools !== false);
    }
    return out;
  }

  // --- Websuche (Issue #63) ------------------------------------------------
  //
  // Eigene Datei statt eines Eintrags in llm-config.json: der Suchdienst ist
  // kein LLM-Anbieter und soll nicht in der Provider-Liste auftauchen. Der
  // Schluessel liegt wie die Provider-Keys verschluesselt (safeStorage).

  function getWebSearchConfigPath() {
    return path.join(app.getPath('userData'), WEB_SEARCH_CONFIG_FILENAME);
  }

  async function readWebSearchConfig() {
    try {
      const raw = await fs.readFile(getWebSearchConfigPath(), 'utf8');
      const data = JSON.parse(raw);
      return data && typeof data === 'object' ? data : {};
    } catch {
      return {};
    }
  }

  /** true, sobald ueberhaupt ein Schluessel abgelegt ist — ohne ihn zu entschluesseln. */
  async function hasWebSearchApiKey() {
    const config = await readWebSearchConfig();
    return typeof config.apiKeyEnc === 'string' && config.apiKeyEnc.length > 0;
  }

  async function getWebSearchApiKey() {
    const config = await readWebSearchConfig();
    return decryptIfPossible(config.apiKeyEnc) || null;
  }

  /**
   * Legt den Schluessel ab oder loescht ihn (leerer String). Ohne verfuegbare
   * Verschluesselung wird nichts geschrieben — ein Klartext-Key auf der Platte
   * waere schlechter als kein Key.
   */
  async function setWebSearchApiKey(plaintext) {
    const value = typeof plaintext === 'string' ? plaintext.trim() : '';
    return withFileLock(getWebSearchConfigPath(), async () => {
      // Read only to move a broken file aside before it is replaced (#557).
      try {
        await readJsonForUpdate(getWebSearchConfigPath(), isJsonObject);
      } catch {
        return { ok: false, hasApiKey: await hasWebSearchApiKey() };
      }
      if (!value) {
        await writeJsonAtomic(getWebSearchConfigPath(), {});
        return { ok: true, hasApiKey: false };
      }
      const enc = encryptIfPossible(value);
      if (!enc) {
        return {
          ok: false,
          error: createMessage('settings.error.encryptionUnavailable'),
          hasApiKey: await hasWebSearchApiKey(),
        };
      }
      await writeJsonAtomic(getWebSearchConfigPath(), { apiKeyEnc: enc });
      return { ok: true, hasApiKey: true };
    });
  }


  // --- MCP-Server (Issue #108) ---------------------------------------------
  //
  // Eigene Datei wie bei der Websuche: MCP-Server sind kein LLM-Anbieter. Die
  // env-Werte liegen je Schluessel entweder verschluesselt (`enc`) oder im
  // Klartext (`value`) — verschluesselt ist die Vorgabe, Klartext die bewusste
  // Ausnahme (Entscheidung zu #108).
  //
  // Zwei Lesewege, absichtlich getrennt: `readMcpServers` liefert die
  // Anzeigeform ohne Geheimnisse und ist das, was an den Renderer geht;
  // `getMcpServersForRuntime` entschluesselt und ist nur fuer den Dienst
  // gedacht, der die Prozesse startet.

  function getMcpConfigPath() {
    return path.join(app.getPath('userData'), MCP_CONFIG_FILENAME);
  }

  /** With `forUpdate`, a file that cannot be read throws instead of looking empty (#473). */
  async function readMcpConfigRaw({ forUpdate = false } = {}) {
    if (forUpdate) {
      return (await readJsonForUpdate(getMcpConfigPath(), isKnownMcpConfig)) || { servers: [] };
    }
    let raw;
    try {
      raw = await fs.readFile(getMcpConfigPath(), 'utf8');
    } catch {
      return { servers: [] };
    }
    const data = parseJson(raw);
    return isKnownMcpConfig(data) ? data : { servers: [] };
  }

  function isKnownMcpConfig(data) {
    return isJsonObject(data)
      && Array.isArray(data.servers)
      && !(typeof data.version === 'number' && data.version > MCP_CONFIG_VERSION);
  }

  /** Gespeicherte Eintraege in geprueftem Zustand, env in gespeicherter Form. */
  async function readMcpStoredServers({ forUpdate = false } = {}) {
    const data = await readMcpConfigRaw({ forUpdate });
    const out = [];
    const seen = new Set();
    for (const entry of data.servers) {
      const { ok, value } = validateMcpServerConfig({ ...entry, env: {} });
      if (!ok || seen.has(value.id)) continue;
      seen.add(value.id);
      out.push({ ...value, env: normalizeStoredMcpEnv(entry?.env) });
    }
    return out;
  }

  /** Anzeigeform fuer die Oberflaeche — ohne jedes Geheimnis. */
  async function readMcpServers() {
    return (await readMcpStoredServers()).map((server) => ({
      ...server,
      env: maskStoredMcpEnv(server.env),
    }));
  }

  /**
   * Laufzeitform fuer den MCP-Dienst: env flach und entschluesselt. Ein Wert,
   * der sich nicht entschluesseln laesst (fremder safeStorage-Schluessel nach
   * Nutzerwechsel), faellt weg statt den ganzen Server zu verhindern — der
   * Server startet dann ohne ihn und scheitert sichtbar am eigenen Fehler.
   */
  async function getMcpServersForRuntime() {
    return (await readMcpStoredServers()).map((server) => {
      const env = {};
      for (const [key, entry] of Object.entries(server.env)) {
        if (typeof entry.value === 'string') env[key] = entry.value;
        else {
          const plain = decryptIfPossible(entry.enc);
          if (plain !== null) env[key] = plain;
        }
      }
      return { ...server, env };
    });
  }

  /**
   * Alle entschluesselten Geheimnisse als flache Liste. Nur zum Vergleich —
   * damit ein MCP-Token weder ueber ein Tool-Ergebnis hinausgeht (Konzept §5)
   * noch in einem stderr-Auszug auftaucht. Wird nie protokolliert.
   */
  async function getMcpSecretValues() {
    const out = [];
    for (const server of await readMcpStoredServers()) {
      for (const entry of Object.values(server.env)) {
        if (typeof entry.enc !== 'string') continue;
        const plain = decryptIfPossible(entry.enc);
        if (plain) out.push(plain);
      }
    }
    return out;
  }

  /**
   * Legt einen Server an oder ersetzt ihn. Ein Geheimnis mit `keep` behaelt
   * seinen gespeicherten Wert — sonst loeschte das Umbenennen eines Servers
   * dessen Token, weil die Oberflaeche ihn gar nicht kennt und nicht
   * zuruecksenden kann.
   */
  async function saveMcpServer(input) {
    const { ok, value, env, errors } = validateMcpServerInput(input);
    if (!ok) return { ok: false, errors };

    return withFileLock(getMcpConfigPath(), async () => {
      const servers = await readMcpStoredServers({ forUpdate: true });
      const previous = servers.find((server) => server.id === value.id);
      const storedEnv = {};
      const unencryptable = [];

      for (const entry of env) {
        if (entry.keep) {
          const before = previous?.env?.[entry.key];
          if (before) storedEnv[entry.key] = before;
          continue;
        }
        if (!entry.secret) {
          storedEnv[entry.key] = { value: entry.value };
          continue;
        }
        const enc = encryptIfPossible(entry.value);
        if (!enc) {
          unencryptable.push(entry.key);
          continue;
        }
        storedEnv[entry.key] = { enc };
      }

      if (unencryptable.length > 0) {
        // Lieber gar nicht speichern als ein Token im Klartext ablegen. Die
        // Meldung nennt die Schluessel, niemals die Werte.
        return {
          ok: false,
          errors: [createMessage('mcp.error.noSecureStorage', { names: unencryptable.join(', ') })],
        };
      }

      // Der Tool-Katalog gehoert dem Server, nicht dem Formular: schickt die
      // Oberflaeche keinen mit (sie kennt ihn nur bei laufender Verbindung),
      // bleibt der gespeicherte stehen.
      const knownTools = value.knownTools.length > 0 ? value.knownTools : previous?.knownTools || [];
      const next = servers.filter((server) => server.id !== value.id);
      next.push({ ...value, knownTools, env: storedEnv });
      next.sort((a, b) => a.id.localeCompare(b.id));
      await writeJsonAtomic(getMcpConfigPath(), { version: MCP_CONFIG_VERSION, servers: next });
      return { ok: true, errors: [] };
    });
  }

  /**
   * Schreibt den zuletzt gemeldeten Tool-Katalog eines Servers fort. Bewusst
   * getrennt von saveMcpServer: hier kommt kein Formular her, sondern eine
   * geglueckte Verbindung — env und alle uebrigen Felder bleiben unberuehrt.
   */
  async function updateMcpServerKnownTools(id, toolNames) {
    const wanted = typeof id === 'string' ? id.trim().toLowerCase() : '';
    const names = normalizeKnownTools(toolNames);
    if (!wanted || names.length === 0) return { ok: false };
    return withFileLock(getMcpConfigPath(), async () => {
      const servers = await readMcpStoredServers({ forUpdate: true });
      const current = servers.find((server) => server.id === wanted);
      if (!current) return { ok: false };
      const before = current.knownTools || [];
      if (before.length === names.length && before.every((name, i) => name === names[i])) {
        return { ok: true, changed: false };
      }
      const next = servers.map((server) => (
        server.id === wanted ? { ...server, knownTools: names } : server
      ));
      await writeJsonAtomic(getMcpConfigPath(), { version: MCP_CONFIG_VERSION, servers: next });
      return { ok: true, changed: true };
    });
  }

  /**
   * Empties the per-server tool deselection (#449). Since the Security page
   * the switch of an MCP tool is `uiPrefs.disabledTools`; a list left here
   * would hide a tool from that page for good. Returns what was cleared.
   */
  async function clearMcpServerDisabledTools() {
    return withFileLock(getMcpConfigPath(), async () => {
      const servers = await readMcpStoredServers({ forUpdate: true });
      const cleared = servers
        .filter((server) => Array.isArray(server.disabledTools) && server.disabledTools.length > 0)
        .map((server) => ({ id: server.id, disabledTools: [...server.disabledTools] }));
      if (cleared.length === 0) return cleared;
      const next = servers.map((server) => ({ ...server, disabledTools: [] }));
      await writeJsonAtomic(getMcpConfigPath(), { version: MCP_CONFIG_VERSION, servers: next });
      return cleared;
    });
  }

  async function deleteMcpServer(id) {
    const wanted = typeof id === 'string' ? id.trim().toLowerCase() : '';
    if (!wanted) return { ok: false, errors: [createMessage('mcp.error.idMissingForDelete')] };
    return withFileLock(getMcpConfigPath(), async () => {
      const servers = await readMcpStoredServers({ forUpdate: true });
      const next = servers.filter((server) => server.id !== wanted);
      if (next.length === servers.length) {
        return { ok: false, errors: [createMessage('mcp.error.unknownServer', { id: wanted })] };
      }
      await writeJsonAtomic(getMcpConfigPath(), { version: MCP_CONFIG_VERSION, servers: next });
      return { ok: true, errors: [] };
    });
  }

  function getLastFolderConfigPath() {
    return path.join(app.getPath('userData'), LAST_FOLDER_FILENAME);
  }

  async function readLastFolderRaw() {
    try {
      const raw = await fs.readFile(getLastFolderConfigPath(), 'utf8');
      const data = JSON.parse(raw);
      return typeof data.path === 'string' ? data.path : null;
    } catch {
      return null;
    }
  }

  async function clearLastFolderFile() {
    try {
      await fs.unlink(getLastFolderConfigPath());
    } catch {
      /* ignore */
    }
  }

  async function getValidatedLastFolder() {
    const p = await readLastFolderRaw();
    if (!p || !p.trim()) return null;
    const resolved = path.resolve(p.trim());
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) {
        await clearLastFolderFile();
        return null;
      }
      return resolved;
    } catch {
      await clearLastFolderFile();
      return null;
    }
  }

  const SIDEBAR_WIDTH_MIN = 150;
  const SIDEBAR_WIDTH_MAX = 600;
  const CHAT_PANEL_WIDTH_MIN = 260;
  const CHAT_PANEL_WIDTH_MAX = 2000;

  function clampSidebarWidthLocal(raw) {
    return clampSidebarWidth(raw);
  }

  function clampChatPanelWidthLocal(raw) {
    return clampChatPanelWidth(raw);
  }

  function getUIPrefsPath() {
    return path.join(app.getPath('userData'), UI_PREFS_FILENAME);
  }

  /**
   * Existing installations stay on German (epic #277).
   *
   * The contract's default has been English since the language switch landed.
   * An already existing preferences file without `appLocale`, however, comes
   * from a time when there was only German — quietly turning it to English
   * would be a language change nobody asked for. A missing *file*, in contrast,
   * means a new installation and therefore English.
   *
   * Deliberately without writing: the addition happens on every read and holds
   * even if the migration never gets around to saving. The next
   * `updateUIPrefs` persists it anyway.
   */
  async function readUIPrefs() {
    let raw;
    try {
      raw = await fs.readFile(getUIPrefsPath(), 'utf8');
    } catch {
      return normalizeUiPrefs({});
    }
    return uiPrefsFromFile(raw);
  }

  function uiPrefsFromFile(raw) {
    const data = parseJson(raw);
    return isJsonObject(data) ? uiPrefsFromData(data) : normalizeUiPrefs({});
  }

  function uiPrefsFromData(data) {
    if (!('appLocale' in data)) return normalizeUiPrefs({ ...data, appLocale: APP_LOCALES.DE });
    return normalizeUiPrefs(data);
  }

  async function writeUIPrefs(data) {
    await withFileLock(getUIPrefsPath(), () => writeJsonAtomic(getUIPrefsPath(), data));
  }

  async function updateUIPrefs(updater) {
    return withFileLock(getUIPrefsPath(), async () => {
      // Not `readUIPrefs`: its defaults for an unreadable file would be
      // written back, and every other preference with them (#473). A file
      // that does not parse is moved aside first (#557).
      const data = await readJsonForUpdate(getUIPrefsPath(), isJsonObject);
      const current = data === null ? normalizeUiPrefs({}) : uiPrefsFromData(data);
      const updated = await updater({ ...current });
      const normalized = normalizeUiPrefs(updated);
      await writeJsonAtomic(getUIPrefsPath(), normalized);
      return normalized;
    });
  }

  function getChatHistoryPath() {
    return path.join(app.getPath('userData'), CHAT_HISTORY_FILENAME);
  }

  function defaultChatHistoryStore() {
    return { version: 2, activeByWorkspace: {}, sessions: [] };
  }

  function normalizeWorkspaceRoot(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    return path.resolve(trimmed);
  }

  function workspaceBucketKey(workspaceRoot) {
    return workspaceRoot ? workspaceRoot : NO_WORKSPACE_KEY;
  }

  function sanitizeChatMessagesForStoreLocal(raw) {
    return sanitizeChatMessagesForStore(raw);
  }

  function normalizeTokenUsageForStoreLocal(raw) {
    return normalizeTokenUsageForStore(raw);
  }

  function normalizeSessionForStore(s, options = {}) {
    return buildNormalizedSessionForStore(s, { normalizeWorkspaceRoot, ...options });
  }

  function parseChatHistoryStoreData(data) {
    if (!data || typeof data !== 'object') return null;
    const sessionsIn = Array.isArray(data.sessions) ? data.sessions : [];
    const sessions = sessionsIn
      .map((x) => normalizeSessionForStore(x))
      .filter(Boolean);

    const activeByWorkspace = {};
    if (data.activeByWorkspace && typeof data.activeByWorkspace === 'object') {
      for (const [k, v] of Object.entries(data.activeByWorkspace)) {
        if (typeof k === 'string' && k && typeof v === 'string' && v) {
          activeByWorkspace[k] = v;
        }
      }
    } else if (typeof data.activeChatId === 'string' && data.activeChatId) {
      activeByWorkspace[NO_WORKSPACE_KEY] = data.activeChatId;
    }

    return {
      version: 2,
      activeByWorkspace,
      sessions,
    };
  }

  async function loadChatHistoryStoreFromDisk() {
    let raw;
    try {
      raw = await readFileWithRetry(fs, getChatHistoryPath(), { platform });
    } catch (error) {
      // Keine Datei (Erststart): leer starten, nichts zu retten.
      if (error?.code === 'ENOENT') {
        return { store: defaultChatHistoryStore(), wasEncrypted: false, unreadable: false };
      }
      // There is a file, it just could not be read (#473). Nothing to
      // quarantine, since its content may be fine — but nothing to write
      // back either.
      return { store: defaultChatHistoryStore(), wasEncrypted: false, unreadable: false, readFailed: true };
    }

    // Ab hier existiert eine Datei. Laesst sie sich nicht interpretieren
    // (kaputtes JSON, fremder safeStorage-Schluessel z. B. nach der
    // Umbenennung der App, Verschluesselung hier nicht verfuegbar), darf sie
    // NICHT stillschweigend ueberschrieben werden: unreadable = true, der
    // Aufrufer stellt sie in Quarantaene (quarantineUnreadableChatHistory).
    let wasEncrypted = false;
    try {
      let data = JSON.parse(raw);
      if (!data || typeof data !== 'object') {
        return { store: defaultChatHistoryStore(), wasEncrypted, unreadable: true };
      }
      if (data.encrypted === true && typeof data.payload === 'string') {
        wasEncrypted = true;
        const decrypted = decryptIfPossible(data.payload);
        if (!decrypted) return { store: defaultChatHistoryStore(), wasEncrypted, unreadable: true };
        data = JSON.parse(decrypted);
      }
      const store = parseChatHistoryStoreData(data);
      if (!store) return { store: defaultChatHistoryStore(), wasEncrypted, unreadable: true };
      return { store, wasEncrypted, unreadable: false };
    } catch {
      return { store: defaultChatHistoryStore(), wasEncrypted, unreadable: true };
    }
  }

  // Unlesbaren Verlauf beiseitelegen statt beim naechsten Write zu zerstoeren.
  // Bewusst ohne withChatHistoryLock: die Handler halten den Lock bereits,
  // wenn sie mit skipMigration lesen; ein verschachtelter Lock wuerde
  // deadlocken. rename ist atomar, ein parallel lesender Zweiter scheitert
  // harmlos mit ENOENT.
  /**
   * Returns false when the file is still where it was (#561) — the caller
   * must then not hand out a store that could be written over it.
   */
  async function quarantineUnreadableChatHistory() {
    const source = getChatHistoryPath();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${source}.undecryptable-${stamp}`;
    try {
      await renameWithRetry(fs, source, target, { platform });
      if (typeof log?.warn === 'function') {
        log.warn(`[chat-history] Verlauf nicht lesbar, gesichert als ${target}`);
      }
      return true;
    } catch (err) {
      if (err && err.code === 'ENOENT') return true;
      if (typeof log?.warn === 'function') {
        log.warn(`[chat-history] Verlauf nicht lesbar, Sicherung fehlgeschlagen: ${err?.message || err}`);
      }
      return false;
    }
  }

  /** An empty store for an unreadable file — writable only once it is moved aside. */
  async function storeAfterQuarantine() {
    return (await quarantineUnreadableChatHistory()) ? defaultChatHistoryStore() : storeFromFailedRead();
  }

  async function migrateChatHistoryToEncryptedIfNeeded(store, wasEncrypted) {
    if (safeStorage.isEncryptionAvailable() && !wasEncrypted) {
      await writeChatHistoryStore(store);
    }
  }

  /**
   * An empty store handed out because the file could not be read (#473).
   * Readers get it like any other, so the list simply shows nothing; only
   * `writeChatHistoryStore` refuses it. The handlers read, change and write
   * back the very same object, so this catches every write path at once —
   * including readers that only display and never write.
   */
  const storesFromFailedReads = new WeakSet();

  function storeFromFailedRead() {
    const store = defaultChatHistoryStore();
    storesFromFailedReads.add(store);
    return store;
  }

  async function readChatHistoryStore({ skipMigration = false } = {}) {
    const { store, wasEncrypted, unreadable, readFailed } = await loadChatHistoryStoreFromDisk();
    if (readFailed) return storeFromFailedRead();
    if (unreadable) return storeAfterQuarantine();
    if (skipMigration) return store;
    if (safeStorage.isEncryptionAvailable() && !wasEncrypted) {
      return withChatHistoryLock(async () => {
        const fresh = await loadChatHistoryStoreFromDisk();
        if (fresh.readFailed) return storeFromFailedRead();
        if (fresh.unreadable) return storeAfterQuarantine();
        await migrateChatHistoryToEncryptedIfNeeded(fresh.store, fresh.wasEncrypted);
        return fresh.store;
      });
    }
    return store;
  }

  async function writeChatHistoryStore(store) {
    if (storesFromFailedReads.has(store)) {
      log?.warn?.('[chat-history] The history file could not be read; this save is skipped rather than written over it.');
      throw Object.assign(
        new Error('The chat history could not be read; it is not overwritten with an empty one.'),
        { code: CHAT_HISTORY_UNREADABLE },
      );
    }
    if (safeStorage.isEncryptionAvailable()) {
      const payload = encryptIfPossible(JSON.stringify(store));
      if (payload) {
        await writeJsonAtomic(getChatHistoryPath(), { encrypted: true, payload });
        return;
      }
    }
    await writeJsonAtomic(getChatHistoryPath(), store);
  }

  async function persistLastFolder(folderPath) {
    const raw = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (!raw) return;
    const resolved = path.resolve(raw);
    try {
      const st = await fs.stat(resolved);
      if (!st.isDirectory()) return;
    } catch {
      return;
    }
    await writeJsonAtomic(getLastFolderConfigPath(), { path: resolved });
    await addFolderToHistory(resolved);
  }

  function getFolderHistoryPath() {
    return path.join(app.getPath('userData'), FOLDER_HISTORY_FILENAME);
  }

  /** With `forUpdate`, a file that cannot be read throws instead of looking empty (#473). */
  async function readFolderHistoryRaw({ forUpdate = false } = {}) {
    let data;
    if (forUpdate) {
      data = await readJsonForUpdate(getFolderHistoryPath(), isKnownFolderHistory);
    } else {
      try {
        data = parseJson(await fs.readFile(getFolderHistoryPath(), 'utf8'));
      } catch {
        return [];
      }
    }
    if (!isKnownFolderHistory(data)) return [];
    return data.paths.filter((p) => typeof p === 'string' && p.trim());
  }

  function isKnownFolderHistory(data) {
    return isJsonObject(data) && Array.isArray(data.paths);
  }

  async function writeFolderHistory(paths) {
    await writeJsonAtomic(getFolderHistoryPath(), { paths });
  }

  /**
   * Read, change and write the history under its file lock (#562): two
   * folders opened while the list is being validated must not cost an entry.
   * `change` returns the new list, or `null` to leave the file alone.
   */
  function updateFolderHistory(change) {
    return withFileLock(getFolderHistoryPath(), async () => {
      const next = change(await readFolderHistoryRaw({ forUpdate: true }));
      if (next) await writeFolderHistory(next);
      return next;
    });
  }

  async function addFolderToHistory(resolvedPath) {
    try {
      await updateFolderHistory((list) => {
        const filtered = list.filter((p) => p !== resolvedPath);
        filtered.unshift(resolvedPath);
        return filtered.slice(0, MAX_FOLDER_HISTORY);
      });
    } catch (error) {
      // Opening the folder goes on; the history just misses this one entry
      // rather than every other (#473).
      log?.warn?.(`[folder-history] Could not update the folder history, left it as it is: ${error?.message || error}`);
    }
  }

  /**
   * Entfernt einen Eintrag bewusst aus dem Verlauf (Issue #57). Fasst weder
   * den Ordner auf der Platte noch last-folder.json an. Liefert true, wenn
   * tatsächlich ein Eintrag entfernt wurde.
   */
  async function removeFolderFromHistory(folderPath) {
    const raw = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (!raw) return false;
    const resolved = path.resolve(raw);
    let removed = false;
    try {
      await updateFolderHistory((list) => {
        const filtered = list.filter((p) => p !== resolved && p !== raw);
        removed = filtered.length !== list.length;
        return removed ? filtered : null;
      });
    } catch {
      return false;
    }
    return removed;
  }

  async function getValidatedFolderHistory() {
    const list = await readFolderHistoryRaw();
    const out = [];
    const gone = new Set();
    for (const p of list) {
      try {
        const st = await fs.stat(p);
        if (st.isDirectory()) {
          out.push(p);
        } else {
          gone.add(p);
        }
      } catch {
        gone.add(p);
      }
    }
    // Drop only what was found gone, from the list as it is now — a folder
    // opened meanwhile stays (#562).
    if (gone.size > 0) {
      try {
        await updateFolderHistory((current) => current.filter((p) => !gone.has(p)));
      } catch (error) {
        log?.warn?.(`[folder-history] Could not drop missing folders, left the history as it is: ${error?.message || error}`);
      }
    }
    return out;
  }

  function sessionMatchesWorkspace(sessionRow, workspaceRoot) {
    const sessionWs = sessionRow.workspaceRoot || null;
    return sessionWs === (workspaceRoot || null);
  }

  return {
    MAX_CHAT_SESSIONS,
    getUIPrefsPath,
    readLLMConfig,
    writeLLMConfig,
    updateLLMConfig,
    resolveChatModelTarget,
    normalizePresetEntry,
    migrateLLMConfigToV3,
    getEffectiveProviderConfig,
    getValidatedLastFolder,
    clampSidebarWidth: clampSidebarWidthLocal,
    clampChatPanelWidth: clampChatPanelWidthLocal,
    clampHistoryCharLimit,
    readUIPrefs,
    writeUIPrefs,
    updateUIPrefs,
    hasWebSearchApiKey,
    getWebSearchApiKey,
    setWebSearchApiKey,
    readMcpServers,
    getMcpServersForRuntime,
    getMcpSecretValues,
    saveMcpServer,
  updateMcpServerKnownTools,
  clearMcpServerDisabledTools,
    deleteMcpServer,
    normalizeWorkspaceRoot,
    workspaceBucketKey,
    inferChatTitle,
    sanitizeChatMessagesForStore: sanitizeChatMessagesForStoreLocal,
    normalizeTokenUsageForStore: normalizeTokenUsageForStoreLocal,
    normalizeLoadedMessages,
    normalizeSessionForLoad,
    normalizeSessionForStore,
    readChatHistoryStore,
    writeChatHistoryStore,
    withChatHistoryLock,
    persistLastFolder,
    getValidatedFolderHistory,
    removeFolderFromHistory,
    sessionMatchesWorkspace,
  };
}

module.exports = {
  createStorageService,
};
