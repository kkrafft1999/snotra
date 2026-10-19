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
  presetIdentityKey,
  isMaxOutputTokens,
} = require('../../shared/contracts/settings');
const { normalizeReasoningLevel } = require('../../shared/contracts/reasoning');
const { APP_LOCALES } = require('../../shared/contracts/enums');
const { localeFromSystem } = require('../../shared/i18n');
const {
  MCP_TRANSPORTS,
  maskStoredMcpEnv,
  maskStoredMcpHeaders,
  normalizeKnownTools,
  normalizeStoredMcpEnv,
  normalizeStoredMcpHeaders,
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
  normalizeSessionMetaForList,
  storedChatMessagesChanged,
} = require('./chat-history-normalization');
const { renameWithRetry, readFileWithRetry } = require('./rename-with-retry');
const { writeFileAtomic } = require('./atomic-write');
const { createChatHistoryStore } = require('./chat-history-store');
const { NOTICE_STORES } = require('../../shared/contracts/notices');
const { KEY_ALWAYS_DURABLE } = require('./safe-storage-key-durability');
const { CONFIRMATION_ACTIONS, NO_RECEIPTS } = require('../../application/permissions/user-confirmation');
const {
  launchBeforeFromStored,
  mcpLaunchNeedsConfirmation,
  mcpLaunchSubject,
} = require('./mcp-launch-confirmation');

/**
 * The preferences that switch an execution tool on, and what switching each
 * on has to be confirmed as (#1104). Switching one off needs nothing.
 */
const EXECUTION_SWITCHES = Object.freeze({
  shellExecutionEnabled: CONFIRMATION_ACTIONS.SHELL_EXECUTION,
  pythonExecutionEnabled: CONFIRMATION_ACTIONS.PYTHON_EXECUTION,
});

function createStorageService({
  app,
  safeStorage,
  /** When ciphertext may reach the disk (#1060); without it, at once. */
  safeStorageKey = KEY_ALWAYS_DURABLE,
  fs,
  path,
  providerCatalog,
  maxChatSessions,
  maxFolderHistory,
  defaultProviderId,
  log = console,
  platform = process.platform,
  onStoreFileEvent = null,
  /**
   * Redeems the receipts of the user-confirmation port (#980, #1104): an
   * execution tool switched on and a local MCP command stored need one.
   * Without it, neither is taken.
   */
  confirmationReceipts = NO_RECEIPTS,
}) {
  const LLM_CONFIG_FILENAME = 'llm-config.json';
  const LEGACY_OPENAI_CONFIG_FILENAME = 'openai-config.json';
  const LAST_FOLDER_FILENAME = 'last-folder.json';
  const FOLDER_HISTORY_FILENAME = 'folder-history.json';
  const UI_PREFS_FILENAME = 'ui-preferences.json';
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
  const KNOWN_LLM_CONFIG_VERSIONS = Object.freeze([2, 3, 4, 5, LLM_CONFIG_VERSION]);
  const MCP_CONFIG_VERSION = 1;

  const fileLocks = new Map();
  const pendingWrites = new Map();

  /**
   * Tells the user what happened to a store's file (#1001), instead of only
   * the console: `set-aside` with the copy's path in `keptAs`, `not-saved`
   * while a file that is there cannot be read or moved, and `saved-again`
   * once a write to such a file goes through. `path` is the store's file.
   * Files that are not a store are not reported. `store` is for a file whose
   * name says nothing — a chat's file in the history folder (#985).
   */
  const filesNotSaved = new Set();

  function reportStoreFile(type, filePath, keptAs = null, store = NOTICE_STORES[path.basename(filePath)]) {
    if (typeof onStoreFileEvent !== 'function') return;
    const file = path.basename(filePath);
    if (!store) return;
    if (type === 'not-saved') filesNotSaved.add(filePath);
    else filesNotSaved.delete(filePath);
    try {
      onStoreFileEvent({ type, store, file, path: filePath, keptAs });
    } catch (error) {
      log?.warn?.(`[storage] could not report ${file}: ${error?.message || error}`);
    }
  }

  /**
   * Writes to the same file run one after the other (#672). On Windows two
   * renames onto one target at the same moment fail with EPERM — the target
   * is held by the other rename, so retrying only shortens the odds. This is
   * deliberately a queue of its own rather than `withFileLock`: callers that
   * already hold the file lock for a read-modify-write write from inside it.
   */
  function writeJsonAtomic(targetPath, data) {
    const prev = pendingWrites.get(targetPath) || Promise.resolve();
    const task = prev.then(() => writeJsonAtomicNow(targetPath, data));
    const settled = task.catch(() => {});
    pendingWrites.set(targetPath, settled);
    settled.then(() => {
      if (pendingWrites.get(targetPath) === settled) pendingWrites.delete(targetPath);
    });
    return task;
  }

  async function writeJsonAtomicNow(targetPath, data) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    // Flushed before the rename (#1013), and the rename retries: these files
    // are read all the time (every preferences read, every chat run), and on
    // Windows a reader, the indexer or a virus scanner can hold the target
    // for a moment (#472, as for the policy in #419).
    await writeFileAtomic(fs, targetPath, JSON.stringify(data), { platform });
    if (filesNotSaved.has(targetPath)) reportStoreFile('saved-again', targetPath);
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
      reportStoreFile('not-saved', filePath);
      throw error;
    }
    log?.warn?.(`[storage] ${path.basename(filePath)} could not be understood; kept it as ${target}`);
    reportStoreFile('set-aside', filePath, target);
  }

  /**
   * Reads a JSON file that is about to be written back, under its file lock
   * (#473, #557). `null` means "start from the defaults": the file is
   * missing, or it was not understood and has just been moved aside.
   */
  async function readJsonForUpdate(filePath, isUnderstood) {
    let raw;
    try {
      raw = await readForUpdate(filePath);
    } catch (error) {
      reportStoreFile('not-saved', filePath);
      throw error;
    }
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

  /**
   * Resolves once no store is reading-to-write or writing any more — the quit
   * waits for it (#679). Work queued while waiting is waited for as well.
   */
  async function whenWritesSettled() {
    const inFlight = () => [...fileLocks.values(), ...pendingWrites.values(), ...chatHistory.pendingWork()];
    for (;;) {
      const pending = inFlight();
      await Promise.all(pending.map((p) => p.catch(() => {})));
      const now = inFlight();
      if (now.length === pending.length && now.every((p, i) => p === pending[i])) return;
    }
  }

  function withChatHistoryLock(fn) {
    return withFileLock(chatHistory.storeDir(), fn);
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
      return target;
    }
    const ap = llmConfig.activeProvider || DEFAULT_PROVIDER;
    const pMeta = providerCatalog.getProvider(ap);
    const entry = (llmConfig.providers && llmConfig.providers[ap]) || {};
    return {
      providerId: ap,
      model:
        typeof entry.model === 'string' && entry.model.trim()
          ? entry.model.trim()
          : (pMeta && pMeta.defaultModel) || '',
    };
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

  /**
   * v5 -> v6 (#726): the reasoning level belongs to the chat now (#725), so an
   * entry carries none. Entries that differed only in their level become one:
   * the first in the preference list stays, takes over the default and the
   * active role of the others, and is visible in the menu if any of them was.
   *
   * `presetAliases` keeps, for every entry that had a level, which entry it
   * stands for now and which level it ran with. A chat from before is pointed
   * at the surviving entry and given that level the first time it comes on
   * screen (chat-session-settings) — the history itself is not rewritten here.
   *
   * Only entries of providers that declare reasoning levels are merged; for
   * the others nothing changes. Idempotent: a second run finds nothing to do.
   */
  async function migrateLLMConfigToV6(existing, { persist = true } = {}) {
    const out = { ...existing };
    const aliases = isJsonObject(out.presetAliases) ? { ...out.presetAliases } : {};
    const survivors = new Map();
    const presets = [];
    let changed = false;

    for (const raw of Array.isArray(out.presets) ? out.presets : []) {
      const provider = raw ? providerCatalog.getProvider(raw.providerId) : null;
      if (!provider?.reasoning) {
        presets.push(raw);
        continue;
      }
      const level = normalizeReasoningLevel(raw.reasoningEffort ?? raw.options?.reasoningEffort);
      const preset = { ...raw };
      if ('reasoningEffort' in preset) {
        delete preset.reasoningEffort;
        changed = true;
      }
      if (preset.options && typeof preset.options === 'object' && 'reasoningEffort' in preset.options) {
        const { reasoningEffort: _dropped, ...rest } = preset.options;
        preset.options = rest;
        changed = true;
      }
      const key = presetIdentityKey(preset, provider);
      const survivor = survivors.get(key);
      if (survivor) {
        if (preset.menuVisible !== false) survivor.menuVisible = true;
        if (out.activePresetId === preset.id) out.activePresetId = survivor.id;
        if (out.defaultPresetId === preset.id) out.defaultPresetId = survivor.id;
        aliases[preset.id] = { presetId: survivor.id, ...(level ? { reasoningEffort: level } : {}) };
        changed = true;
        continue;
      }
      survivors.set(key, preset);
      presets.push(preset);
      if (level && preset.id) aliases[preset.id] = { presetId: preset.id, reasoningEffort: level };
    }

    out.presets = presets;
    if (Object.keys(aliases).length > 0) out.presetAliases = aliases;
    out.version = 6;
    if (persist && (changed || existing.version !== 6)) {
      await writeLLMConfig(out);
    }
    return out;
  }

  /** v3 file -> current version, persisting only at the end. */
  async function migrateFromV3(existing, { persist }) {
    const v4 = await migrateLLMConfigToV4(existing, { persist: false });
    return migrateFromV4(v4, { persist });
  }

  async function migrateFromV4(existing, { persist }) {
    const v5 = await migrateLLMConfigToV5(existing, { persist: false });
    return migrateLLMConfigToV6(v5, { persist });
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
    if (existing && existing.version === 5 && existing.providers) {
      if (!existing.activeProvider) existing.activeProvider = DEFAULT_PROVIDER;
      if (!Array.isArray(existing.presets)) existing.presets = [];
      // The default must be known before entries merge into another (#726).
      return await migrateLLMConfigToV6(withDefaultPresetId(existing), { persist });
    }
    if (existing && existing.version === 4 && existing.providers) {
      if (!existing.activeProvider) existing.activeProvider = DEFAULT_PROVIDER;
      if (!Array.isArray(existing.presets)) existing.presets = [];
      return withDefaultPresetId(await migrateFromV4(existing, { persist }));
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

  /**
   * Encrypts for a file. On a fresh Windows profile that waits until the key
   * behind safeStorage is on disk itself (#1060): ciphertext written before it
   * would outlive its key if the app died in between.
   */
  async function encryptForDisk(plaintext) {
    if (!plaintext || !safeStorage.isEncryptionAvailable()) return null;
    await safeStorageKey.whenDurable();
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
    if (provider.fields?.maxOutputTokens && isMaxOutputTokens(conn.maxOutputTokens)) {
      out.maxOutputTokens = conn.maxOutputTokens;
    }
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
      const enc = await encryptForDisk(value);
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
  // Ausnahme (Entscheidung zu #108). The headers of a remote server (#341)
  // are stored the same way: an `Authorization` header is a token like any
  // `GITHUB_TOKEN`.
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

  function isRemoteMcpServer(server) {
    return server.transport === MCP_TRANSPORTS.HTTP;
  }

  /** Gespeicherte Eintraege in geprueftem Zustand, env und headers in gespeicherter Form. */
  async function readMcpStoredServers({ forUpdate = false } = {}) {
    const data = await readMcpConfigRaw({ forUpdate });
    const out = [];
    const seen = new Set();
    for (const entry of data.servers) {
      const { ok, value } = validateMcpServerConfig({ ...entry, env: {}, headers: {} });
      if (!ok || seen.has(value.id)) continue;
      seen.add(value.id);
      out.push(isRemoteMcpServer(value)
        ? { ...value, headers: normalizeStoredMcpHeaders(entry?.headers) }
        : { ...value, env: normalizeStoredMcpEnv(entry?.env) });
    }
    return out;
  }

  /** Anzeigeform fuer die Oberflaeche — ohne jedes Geheimnis. */
  async function readMcpServers() {
    return (await readMcpStoredServers()).map((server) => ({
      ...server,
      env: maskStoredMcpEnv(server.env),
      ...(isRemoteMcpServer(server) ? { headers: maskStoredMcpHeaders(server.headers) } : {}),
    }));
  }

  /** A stored map in flat runtime form; a value that cannot be decrypted is left out. */
  function decryptStoredMap(stored) {
    const out = {};
    for (const [key, entry] of Object.entries(stored || {})) {
      if (typeof entry.value === 'string') out[key] = entry.value;
      else {
        const plain = decryptIfPossible(entry.enc);
        if (plain !== null) out[key] = plain;
      }
    }
    return out;
  }

  /**
   * Laufzeitform fuer den MCP-Dienst: env flach und entschluesselt. Ein Wert,
   * der sich nicht entschluesseln laesst (fremder safeStorage-Schluessel nach
   * Nutzerwechsel), faellt weg statt den ganzen Server zu verhindern — der
   * Server startet dann ohne ihn und scheitert sichtbar am eigenen Fehler.
   */
  async function getMcpServersForRuntime() {
    return (await readMcpStoredServers()).map((server) => ({
      ...server,
      env: decryptStoredMap(server.env),
      ...(isRemoteMcpServer(server) ? { headers: decryptStoredMap(server.headers) } : {}),
    }));
  }

  /**
   * Alle entschluesselten Geheimnisse als flache Liste. Nur zum Vergleich —
   * damit ein MCP-Token weder ueber ein Tool-Ergebnis hinausgeht (Konzept §5)
   * noch in einem stderr-Auszug auftaucht. Wird nie protokolliert.
   */
  async function getMcpSecretValues() {
    const out = [];
    for (const server of await readMcpStoredServers()) {
      for (const entry of [...Object.values(server.env), ...Object.values(server.headers || {})]) {
        if (typeof entry.enc !== 'string') continue;
        const plain = decryptIfPossible(entry.enc);
        if (plain) out.push(plain);
      }
    }
    return out;
  }

  /**
   * Stores the entries of one secret map — `env` or `headers` — against what
   * was stored before. Collects the refusals by kind instead of throwing, so
   * one save names every problem at once.
   */
  async function storeSecretEntries(entries, before, problems) {
    const stored = {};
    for (const entry of entries) {
      const previous = before?.[entry.key];
      const storedSecret = typeof previous?.enc === 'string';
      if (entry.keep) {
        if (!previous) problems.keepMissing.push(entry.key);
        else if (storedSecret !== entry.secret) problems.keepChanged.push(entry.key);
        else stored[entry.key] = previous;
        continue;
      }
      if (!entry.secret) {
        stored[entry.key] = { value: entry.value };
        continue;
      }
      if (!entry.value) {
        if (storedSecret) problems.emptySecrets.push(entry.key);
        else stored[entry.key] = { value: '' };
        continue;
      }
      const enc = await encryptForDisk(entry.value);
      if (!enc) {
        problems.unencryptable.push(entry.key);
        continue;
      }
      stored[entry.key] = { enc };
    }
    return stored;
  }

  function secretProblems() {
    return { keepMissing: [], keepChanged: [], emptySecrets: [], unencryptable: [] };
  }

  /** Where a server's messages go: a process, or one address (#341). */
  function mcpEndpointOf(server) {
    return isRemoteMcpServer(server) ? `${server.transport} ${server.url}` : server.transport;
  }

  /**
   * An input without a transport keeps the stored one (B16 review on #341):
   * a form that only knew stdio would otherwise save a remote server back as
   * a local one. Its address and headers stay with it when they are not sent
   * either.
   */
  function withStoredTransport(input, previous) {
    if (!previous || !input || typeof input !== 'object') return input;
    if (input.transport !== undefined && input.transport !== null) return input;
    const out = { ...input, transport: previous.transport };
    if (isRemoteMcpServer(previous)) {
      if (out.url === undefined) out.url = previous.url;
      if (out.headers === undefined) {
        out.headers = {};
        for (const [key, entry] of Object.entries(previous.headers || {})) {
          out.headers[key] = typeof entry.enc === 'string'
            ? { secret: true, keep: true }
            : { secret: false, value: entry.value };
        }
      }
    }
    return out;
  }

  /**
   * Legt einen Server an oder ersetzt ihn. Ein Geheimnis mit `keep` behaelt
   * seinen gespeicherten Wert — sonst loeschte das Umbenennen eines Servers
   * dessen Token, weil die Oberflaeche ihn gar nicht kennt und nicht
   * zuruecksenden kann.
   *
   * No entry disappears without a word (CR-B14-02): a `keep` with nothing
   * stored under its name, or one that would flip the stored value between
   * secret and plain text, is refused — the renderer cannot know the value,
   * so changing either takes a new one. An empty secret value has nothing to
   * encrypt and counts as "no value"; it is stored as an empty value, unless
   * it would replace a stored secret, which it never silently does.
   *
   * A changed endpoint — another address, or another transport — switches
   * the server off and forgets its tool catalogue (#341, concept §11): what
   * the user accepted from one endpoint never carries over to another. It
   * comes back on only after the user switched it on again.
   *
   * A local server whose command is new or changed — the command, its
   * arguments, its folder or its environment — is stored only with a
   * receipt of the user-confirmation port bound to exactly that launch
   * (#1104): it would run with the user's rights, outside the sandbox and
   * without a card, the moment it is switched on or tested.
   *
   * @param {object} input
   * @param {{ confirmation?: object }} [options]
   */
  async function saveMcpServer(input, { confirmation = null } = {}) {
    const precheck = validateMcpServerInput(input);
    // Only an input without a transport may still be completed from what is
    // stored under its identifier; anything else is refused as it is.
    const mayFallBack = (input?.transport === undefined || input?.transport === null)
      && typeof input?.id === 'string' && input.id.trim() !== '';
    if (!precheck.ok && !mayFallBack) return { ok: false, errors: precheck.errors };

    return withFileLock(getMcpConfigPath(), async () => {
      const servers = await readMcpStoredServers({ forUpdate: true });
      const wantedId = String(input.id).trim().toLowerCase();
      const stored = servers.find((server) => server.id === wantedId);
      const { ok, value, env, headers, create, errors } = validateMcpServerInput(
        input?.create === true ? input : withStoredTransport(input, stored),
      );
      if (!ok) return { ok: false, errors };
      const previous = servers.find((server) => server.id === value.id);
      // A new server must not take over an existing one — with its token and
      // its switch (CR-B14-03). Decided here, under the lock, not by the form.
      if (create && previous) {
        return { ok: false, errors: [createMessage('mcp.error.idExists', { id: value.id })] };
      }
      if (mcpLaunchNeedsConfirmation(value, env, launchBeforeFromStored(previous))
        && confirmationReceipts.redeem(confirmation, CONFIRMATION_ACTIONS.MCP_LAUNCH, mcpLaunchSubject(value, env)) !== true) {
        return { ok: false, notConfirmed: true, errors: [createMessage('mcp.error.launchNotConfirmed')] };
      }

      const envProblems = secretProblems();
      const headerProblems = secretProblems();
      const storedEnv = await storeSecretEntries(env, previous?.env, envProblems);
      const storedHeaders = await storeSecretEntries(headers, previous?.headers, headerProblems);

      // Die Meldungen nennen die Schluessel, niemals die Werte.
      const names = (list) => ({ names: list.join(', ') });
      const refusals = [];
      const refuse = (list, key) => { if (list.length > 0) refusals.push(createMessage(key, names(list))); };
      refuse(envProblems.keepMissing, 'mcp.error.envKeepMissing');
      refuse(headerProblems.keepMissing, 'mcp.error.headerKeepMissing');
      refuse(envProblems.keepChanged, 'mcp.error.envKeepChanged');
      refuse(headerProblems.keepChanged, 'mcp.error.headerKeepChanged');
      refuse(envProblems.emptySecrets, 'mcp.error.envSecretEmpty');
      refuse(headerProblems.emptySecrets, 'mcp.error.headerSecretEmpty');
      // Lieber gar nicht speichern als ein Token im Klartext ablegen.
      refuse([...envProblems.unencryptable, ...headerProblems.unencryptable], 'mcp.error.noSecureStorage');
      if (refusals.length > 0) return { ok: false, errors: refusals };

      const endpointChanged = Boolean(previous) && mcpEndpointOf(previous) !== mcpEndpointOf(value);
      // Der Tool-Katalog gehoert dem Server, nicht dem Formular: schickt die
      // Oberflaeche keinen mit (sie kennt ihn nur bei laufender Verbindung),
      // bleibt der gespeicherte stehen — unless it belongs to another endpoint.
      const knownTools = endpointChanged
        ? []
        : value.knownTools.length > 0 ? value.knownTools : previous?.knownTools || [];
      const entry = {
        ...value,
        enabled: endpointChanged ? false : value.enabled,
        knownTools,
        env: storedEnv,
        ...(isRemoteMcpServer(value) ? { headers: storedHeaders } : {}),
      };
      const next = servers.filter((server) => server.id !== value.id);
      next.push(entry);
      next.sort((a, b) => a.id.localeCompare(b.id));
      await writeJsonAtomic(getMcpConfigPath(), { version: MCP_CONFIG_VERSION, servers: next });
      return { ok: true, errors: [], endpointChanged };
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
   * means a new installation, which starts in the system's language when the
   * app speaks it and in English otherwise (#1013).
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
      return firstRunUiPrefs();
    }
    return uiPrefsFromFile(raw);
  }

  /** The preferences of an installation that has none yet. */
  function firstRunUiPrefs() {
    let systemLocale = '';
    try {
      systemLocale = app.getLocale?.() || '';
    } catch {
      // Before `ready` there is no locale to read; English it is.
    }
    return normalizeUiPrefs({ appLocale: localeFromSystem(systemLocale) });
  }

  function uiPrefsFromFile(raw) {
    const data = parseJson(raw);
    return isJsonObject(data) ? uiPrefsFromData(data) : firstRunUiPrefs();
  }

  function uiPrefsFromData(data) {
    if (!('appLocale' in data)) return normalizeUiPrefs({ ...data, appLocale: APP_LOCALES.DE });
    return normalizeUiPrefs(data);
  }

  async function writeUIPrefs(data) {
    await withFileLock(getUIPrefsPath(), () => writeJsonAtomic(getUIPrefsPath(), data));
  }

  /**
   * `confirmations` carries the receipts for execution tools switched on
   * (#1104), keyed by preference. One switched on without a receipt for it
   * stays off; the rest of the update is written.
   *
   * @param {(prefs: object) => object|Promise<object>} updater
   * @param {{ confirmations?: Partial<Record<keyof typeof EXECUTION_SWITCHES, object>> }} [options]
   */
  async function updateUIPrefs(updater, { confirmations = {} } = {}) {
    return withFileLock(getUIPrefsPath(), async () => {
      // Not `readUIPrefs`: its defaults for an unreadable file would be
      // written back, and every other preference with them (#473). A file
      // that does not parse is moved aside first (#557).
      const data = await readJsonForUpdate(getUIPrefsPath(), isJsonObject);
      const current = data === null ? firstRunUiPrefs() : uiPrefsFromData(data);
      const updated = await updater({ ...current });
      const normalized = normalizeUiPrefs(updated);
      for (const [key, action] of Object.entries(EXECUTION_SWITCHES)) {
        if (normalized[key] !== true || current[key] === true) continue;
        if (confirmationReceipts.redeem(confirmations?.[key], action, '') !== true) normalized[key] = false;
      }
      await writeJsonAtomic(getUIPrefsPath(), normalized);
      return normalized;
    });
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

  // One file per chat and an index, held in memory (#985).
  const chatHistory = createChatHistoryStore({
    fs,
    path,
    safeStorage,
    safeStorageKey,
    userDataPath: () => app.getPath('userData'),
    writeJsonAtomic,
    encryptForDisk,
    decryptIfPossible,
    reportStoreFile,
    normalizeWorkspaceRoot,
    noWorkspaceKey: NO_WORKSPACE_KEY,
    maxChatSessions: MAX_CHAT_SESSIONS,
    log,
    platform,
  });

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
    whenWritesSettled,
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
    normalizeSessionMetaForList,
    listChatSessions: chatHistory.listSessions,
    getChatSessionMeta: chatHistory.getSessionMeta,
    getChatSession: chatHistory.getSession,
    getActiveChatId: chatHistory.getActiveChatId,
    saveChatSession: chatHistory.saveSession,
    patchChatSession: chatHistory.patchSession,
    deleteChatSession: chatHistory.deleteSession,
    setActiveChatId: chatHistory.setActiveChatId,
    hasSetAsideChatHistory: chatHistory.hasSetAsideChatHistory,
    storedChatMessagesChanged,
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
