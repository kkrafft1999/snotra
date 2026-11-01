'use strict';

/**
 * Modell und Freigabemodus gehören zum Chat (Issue #211).
 *
 * Vorher waren beides App-weite Einstellungen: Ein Eintrag aus dem Verlauf kam
 * mit seinen Nachrichten zurück, lief aber mit dem gerade eingestellten Modell
 * und Modus weiter — ohne Hinweis. Dieser Dienst merkt sich beides je Chat und
 * wendet es beim Wechsel wieder an.
 *
 * Zwei bewusst verschiedene Regeln für einen **neuen** Chat:
 *
 *  - **Modell**: Der zuletzt gesetzte Eintrag gilt weiter. Er liegt als
 *    `defaultPresetId` in der LLM-Konfiguration und wird nur durch eine
 *    ausdrückliche Wahl (Pille, Einstellungen) fortgeschrieben, nicht durch das
 *    Öffnen eines alten Chats.
 *  - **Freigabemodus**: immer wieder `smart`. „Auto“ ist eine Entscheidung für
 *    einen Chat, nicht für die App.
 *
 * `auto` überlebt außerdem keinen Programmstart: Ein automatisch
 * wiederhergestellter Chat (App-Start, Ordnerwechsel) fällt von `auto` auf
 * `smart` zurück. Nur der ausdrückliche Wechsel im Verlauf stellt `auto` her —
 * dort kann der Wert ausschließlich stehen, weil der Main-Prozess ihn zuvor im
 * nativen Dialog bestätigen ließ (Konzept §5). Der Renderer liefert diese Werte
 * nie, er löst nur den Wechsel aus.
 *
 * A workspace can carry a default mode of its own (#413). It takes the place
 * of `smart` in both rules above: a new chat starts with it, and a chat
 * restored automatically from `auto` falls back to it — so a workspace whose
 * default is `auto` keeps `auto` across a restart. The default can only be
 * `auto` after main's own native confirmation for that workspace. Since #1337
 * every explicit pick in the mode pill writes that default as well (main's
 * `setMode`), so a new chat starts where the user last left the workspace,
 * and only a workspace that never had a pick starts at `smart`.
 *
 * The reasoning level is the chat's third value (#725), with a rule of its
 * own: a new chat has none and runs with the provider's default, `medium`. It
 * is not applied anywhere when a chat comes on screen — a round asks for it
 * (`reasoningEffortFor`) when it starts.
 *
 * Entries carry no level since #726. A chat from before points at an entry
 * the migration may have merged into another; `getPresetAlias` says which
 * entry it stands for now and which level it ran with. The first time such a
 * chat comes on screen it is pointed at that entry and given that level,
 * unless it has one of its own — a new chat is always saved with one.
 */

const {
  TOOL_PERMISSION_MODES,
  DEFAULT_TOOL_PERMISSION_MODE,
} = require('../../shared/contracts/tool-permissions');
const {
  chatModelPresetIdForStore,
  chatToolPermissionModeForStore,
  chatReasoningEffortForStore,
} = require('../../shared/contracts/chat-session-fields');
const { CHAT_ACTIVATION } = require('../../shared/contracts/chat');
const {
  normalizeChatConfigOverrides,
  applyConfigProposal,
  declineConfigProposal,
} = require('../../shared/contracts/chat-configuration');

/**
 * What this service remembers of a chat on top of the history (#211, #725, #774).
 *
 * @typedef {Object} RememberedSettings
 * @property {string} [modelPresetId]
 * @property {string} [toolPermissionMode]
 * @property {string} [reasoningEffort]
 * @property {import('../../shared/contracts/chat-configuration').ChatConfigOverrides|null} [configOverrides]
 */

/**
 * Drops the oldest entries of a map once it holds more than `limit`.
 *
 * @param {Map<string, unknown>} map
 * @param {number} limit
 */
function dropOldest(map, limit) {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** So viele Chats behält der Speicher — deutlich mehr als der Verlauf hält. */
const MAX_REMEMBERED_CHATS = 500;

/**
 * What the session settings keep in the chat history (#982): one chat's index
 * entry, and a patch of its own settings under the history's lock. On the
 * desktop the history store of `src/main/services/storage-service.js`.
 *
 * @typedef {Object} ChatSettingsStore
 * @property {(fn: () => Promise<unknown>) => Promise<unknown>} withChatHistoryLock
 * @property {(id: string, patch: Record<string, unknown>) => Promise<boolean>} patchSession
 * @property {(id: string) => Promise<{ modelPresetId?: unknown, toolPermissionMode?: unknown,
 *   reasoningEffort?: unknown, configOverrides?: unknown } | null>} getSessionMeta
 */

/**
 * @param {object} deps
 * @param {ChatSettingsStore} deps.chatHistoryStore
 * @param {(presetId: string) => unknown} deps.applyPreset
 * @param {() => Promise<string|null|undefined>} deps.getDefaultPresetId
 * @param {(presetId: string) => boolean|Promise<boolean>} [deps.isPresetUsable]
 * @param {(mode: string, options: { chatId: string|null }) => Promise<{ ok?: boolean }|void>} deps.applyMode
 * @param {() => Promise<string|null>} [deps.getActivePresetId]
 * @param {() => Promise<string|null>} [deps.getActiveMode]
 * @param {() => Promise<unknown>} [deps.getWorkspaceMode]
 * @param {(presetId: string) => Promise<{ presetId?: unknown, reasoningEffort?: unknown }|null>} [deps.getPresetAlias]
 * @param {(chatId: string) => void} [deps.onChatModeChanged]
 * @param {(chatId: string|null) => void} [deps.onActivated]
 * @param {{ warn?: (message: string) => void }|null} [deps.log]
 */
function createChatSessionSettings({
  chatHistoryStore,
  applyPreset,
  getDefaultPresetId,
  isPresetUsable = () => true,
  // Writes the mode of the chat coming on screen into the policy store, as
  // `(mode, { chatId })`. A result with `ok: false` means the store refused
  // it — "Auto" without encrypted storage (#419), or never confirmed for this
  // chat or its workspace (#980).
  applyMode,
  // Womit der Chat gerade liefe. Ohne die beiden wird stur angewandt — das ist
  // richtig, nur teurer.
  getActivePresetId = async () => null,
  getActiveMode = async () => null,
  // The default mode of the workspace on screen (#413); `null` means `smart`.
  getWorkspaceMode = async () => null,
  // What an entry from before #726 stands for: `{ presetId, reasoningEffort }`.
  getPresetAlias = async () => null,
  // A chat's own mode changed while it was being activated — its open cards
  // and session approvals were given under the old one (concept §7, #320).
  onChatModeChanged = () => {},
  // Another chat is on screen now; main drops what only the left chat needed.
  onActivated = () => {},
  log = console,
}) {
  /** @type {string|null} */
  let currentChatId = null;
  /** @type {Map<string, RememberedSettings>} */
  const remembered = new Map();
  /**
   * The mode a chat had when it left the screen (#320). The store only ever
   * holds the visible chat's mode; a run that goes on in the background keeps
   * the one it was started under instead of borrowing the next chat's.
   * `null` after "Reset all permissions": that chat follows the store again.
   * @type {Map<string, string|null>}
   */
  const backgroundModes = new Map();
  /**
   * The level each chat has in the history, as far as it was read (#725).
   * Every round asks for it; without this each one would read the whole
   * history file. Only this service writes the level, so the copy stays true.
   * @type {Map<string, string|null>}
   */
  const storedLevels = new Map();
  /**
   * What each chat switched beyond the settings (#774), as far as it was
   * read. Every run asks for it; only this service writes it.
   * @type {Map<string, import('../../shared/contracts/chat-configuration').ChatConfigOverrides|null>}
   */
  const storedOverrides = new Map();
  /**
   * The switch still in progress; the next one waits for it (#559).
   *
   * @type {Promise<unknown>}
   */
  let activationQueue = Promise.resolve();

  /**
   * @param {unknown} raw
   * @returns {string|null}
   */
  function normalizeChatId(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed ? trimmed.slice(0, 128) : null;
  }

  /**
   * @param {string} chatId
   * @param {string} mode
   */
  function rememberBackgroundMode(chatId, mode) {
    backgroundModes.delete(chatId);
    backgroundModes.set(chatId, mode);
    dropOldest(backgroundModes, MAX_REMEMBERED_CHATS);
  }

  /**
   * @param {string} chatId
   * @param {Partial<RememberedSettings>} patch
   */
  function rememberLocal(chatId, patch) {
    const previous = remembered.get(chatId) || {};
    remembered.delete(chatId);
    remembered.set(chatId, { ...previous, ...patch });
    dropOldest(remembered, MAX_REMEMBERED_CHATS);
  }

  /**
   * Wert auch in die Verlaufsdatei schreiben, sofern der Chat dort schon steht.
   * Ein Chat ohne erste Nachricht hat noch keine Zeile — dessen Wert reist über
   * `valuesFor` mit, wenn der Verlauf ihn zum ersten Mal speichert. Since #985
   * it goes into the history's index alone; the chat's file stays as it is.
   *
   * @param {string} chatId
   * @param {Record<string, unknown>} patch
   */
  async function persist(chatId, patch) {
    try {
      await chatHistoryStore.withChatHistoryLock(() => chatHistoryStore.patchSession(chatId, patch));
    } catch (error) {
      // Ein nicht gespeicherter Merkwert darf den Wechsel nicht abbrechen:
      // Im Lauf gilt er trotzdem, nur der nächste Start kennt ihn dann nicht.
      log?.warn?.(`[chat-session-settings] Konnte Chat-Einstellung nicht sichern: ${error?.message || error}`);
    }
  }

  /**
   * What the chat has stored, with this session's changes on top (#558). The
   * local copy only holds what was changed here — on its own it would drop a
   * stored mode the moment the model changed, and the other way round.
   *
   * @param {string} chatId
   * @returns {Promise<RememberedSettings>}
   */
  async function storedValuesFor(chatId) {
    const local = remembered.get(chatId) || {};
    if (local.modelPresetId && local.toolPermissionMode && local.reasoningEffort) return { ...local };
    return { ...(await readStoredValues(chatId)), ...local };
  }

  /**
   * @param {string} chatId
   * @returns {Promise<RememberedSettings>}
   */
  async function readStoredValues(chatId) {
    try {
      const session = await chatHistoryStore.getSessionMeta(chatId);
      if (!session) return {};
      /** @type {RememberedSettings} */
      const out = {};
      const presetId = chatModelPresetIdForStore(session.modelPresetId);
      if (presetId) out.modelPresetId = presetId;
      const mode = chatToolPermissionModeForStore(session.toolPermissionMode);
      if (mode) out.toolPermissionMode = mode;
      const level = chatReasoningEffortForStore(session.reasoningEffort);
      if (level) out.reasoningEffort = level;
      return out;
    } catch {
      return {};
    }
  }

  /**
   * @param {RememberedSettings} values
   */
  async function resolvePresetFor(values) {
    const wanted = values.modelPresetId;
    if (wanted && (await isPresetUsable(wanted))) return wanted;
    // Eintrag gelöscht oder nicht mehr konfiguriert: lieber sichtbar auf den
    // Standard zurück als den Chat mit einem toten Modell öffnen.
    return (await getDefaultPresetId()) || null;
  }

  async function readWorkspaceMode() {
    try {
      return chatToolPermissionModeForStore(await getWorkspaceMode()) || DEFAULT_TOOL_PERMISSION_MODE;
    } catch {
      return DEFAULT_TOOL_PERMISSION_MODE;
    }
  }

  /**
   * @param {RememberedSettings} values
   * @param {string} activation
   * @param {string} workspaceMode
   */
  function resolveModeFor(values, activation, workspaceMode) {
    const stored = values.toolPermissionMode;
    if (!stored) return workspaceMode;
    // Only an explicit switch brings a stored "Auto" back (#567).
    if (activation !== CHAT_ACTIVATION.EXPLICIT && stored === TOOL_PERMISSION_MODES.AUTO) {
      return workspaceMode;
    }
    return stored;
  }

  /**
   * A chat stored at "Auto" on a system that lost its encrypted storage
   * (#419): the store refuses "Auto", and the chat runs at the default mode
   * rather than at what the last chat left.
   *
   * @param {string} mode
   * @param {string|null} chatId
   */
  async function applyModeOrDefault(mode, chatId) {
    const result = await applyMode(mode, { chatId });
    if (result?.ok === false && mode !== DEFAULT_TOOL_PERMISSION_MODE) {
      await applyMode(DEFAULT_TOOL_PERMISSION_MODE, { chatId });
    }
  }

  /**
   * Chat wird zum aktiven: gespeichertes Modell und gespeicherten Modus
   * anwenden. Liefert, was danach gilt — die Oberfläche liest ihren Stand
   * anschließend ohnehin neu, der Rückgabewert macht es für Tests prüfbar.
   *
   * @param {unknown} rawChatId
   * @param {{ activation?: string }} [options]
   */
  function activate(rawChatId, options) {
    // One switch at a time (#559): each one reads the mode the previous one
    // left. Side by side, the chat that ends up on screen could keep the mode
    // of the one clicked just before it.
    const run = activationQueue.then(() => activateNow(rawChatId, options));
    activationQueue = run.catch(() => {});
    return run;
  }

  /**
   * @param {unknown} rawChatId
   * @param {{ activation?: string }} [options]
   */
  async function activateNow(rawChatId, { activation = CHAT_ACTIVATION.EXPLICIT } = {}) {
    const chatId = normalizeChatId(rawChatId);
    const previousChatId = currentChatId;
    const activeMode = await getActiveMode();
    // The chat leaving the screen keeps its mode for a run that may still be
    // going (#320); the one coming on screen reads the store again.
    if (previousChatId && previousChatId !== chatId && activeMode) {
      rememberBackgroundMode(previousChatId, activeMode);
    }
    const modeBefore = chatId === previousChatId ? activeMode : (chatId ? backgroundModes.get(chatId) : undefined) ?? null;
    if (chatId) backgroundModes.delete(chatId);
    currentChatId = chatId;
    const values = chatId ? await storedValuesFor(chatId) : {};
    if (chatId) await adoptAlias(chatId, values);
    const presetId = await resolvePresetFor(values);
    const mode = resolveModeFor(values, activation, await readWorkspaceMode());
    // Nur anfassen, was sich wirklich ändert — dasselbe gilt für die
    // Konfigurationsdatei des Modells. Writing the mode here only mirrors the
    // chat on screen into the store; it discards nothing on its own (#320).
    // The mode goes first (#559): a model switch that fails must not leave
    // this chat running under the mode of the one before it.
    if (mode !== activeMode) await applyModeOrDefault(mode, chatId);
    if (presetId && presetId !== (await getActivePresetId())) await applyPreset(presetId);
    // Only the chat's *own* mode changing voids its cards and approvals — a
    // chat restored from "auto" to "smart", say (concept §7).
    if (chatId && modeBefore && modeBefore !== mode) notify(onChatModeChanged, chatId);
    notify(onActivated, chatId);
    return {
      chatId,
      modelPresetId: presetId,
      toolPermissionMode: mode,
      reasoningEffort: values.reasoningEffort ?? null,
    };
  }

  /**
   * A chat from before #726: point it at the entry its old one became, and
   * give it the level that entry had — once, written into its row (#726).
   *
   * @param {string} chatId
   * @param {RememberedSettings} values
   */
  async function adoptAlias(chatId, values) {
    const alias = await readAlias(values.modelPresetId);
    if (!alias) return;
    /** @type {RememberedSettings} */
    const patch = {};
    const presetId = chatModelPresetIdForStore(alias.presetId);
    if (presetId && presetId !== values.modelPresetId) patch.modelPresetId = presetId;
    const level = chatReasoningEffortForStore(alias.reasoningEffort);
    if (level && !values.reasoningEffort) patch.reasoningEffort = level;
    if (Object.keys(patch).length === 0) return;
    Object.assign(values, patch);
    rememberLocal(chatId, patch);
    if (patch.reasoningEffort) rememberStoredLevel(chatId, patch.reasoningEffort);
    await persist(chatId, patch);
  }

  /**
   * @param {string|undefined} presetId
   */
  async function readAlias(presetId) {
    if (!presetId) return null;
    try {
      const alias = await getPresetAlias(presetId);
      return alias && typeof alias === 'object' ? alias : null;
    } catch {
      return null;
    }
  }

  /**
   * @param {(chatId: any) => void} hook
   * @param {string|null} chatId
   */
  function notify(hook, chatId) {
    try {
      hook(chatId);
    } catch (error) {
      log?.warn?.(`[chat-session-settings] Hook failed: ${error?.message || error}`);
    }
  }

  /**
   * The mode a run of this chat works under (#320). `null` for the chat on
   * screen — its mode is the one in the store, as it always was.
   *
   * @param {unknown} rawChatId
   */
  function modeFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId || chatId === currentChatId) return null;
    return backgroundModes.get(chatId) ?? null;
  }

  /**
   * The mode a run of this chat works under, also for a chat that has not
   * been on screen since the app started — one a phone writes in (#1194,
   * `docs/remote/remote-interface.md` §7.3). `null` for the chat on screen and for
   * one reset to the store, as in `modeFor`. Any other chat runs with its
   * stored mode as an automatic restore would give it: a stored "Auto"
   * counts only after an explicit switch at the desktop (#567), so it falls
   * back to the workspace's default here (decided 2026-10-20).
   *
   * @param {unknown} rawChatId
   * @returns {Promise<string|null>}
   */
  async function runModeFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId || chatId === currentChatId) return null;
    if (backgroundModes.has(chatId)) return backgroundModes.get(chatId) ?? null;
    return resolveModeFor(await storedValuesFor(chatId), CHAT_ACTIVATION.AUTO, await readWorkspaceMode());
  }

  /**
   * The model entry a run of this chat works with (#1194, §7.3): the chat's
   * own for any chat but the one on screen — whose entry is the active one —
   * so that a chat left while its turn runs, or written in from a phone,
   * does not borrow the screen's model. `null` for the chat on screen. A chat
   * whose entry is gone or no longer set up gets the default, as on screen.
   *
   * @param {unknown} rawChatId
   * @returns {Promise<string|null>}
   */
  async function presetFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId || chatId === currentChatId) return null;
    return resolvePresetFor(await storedValuesFor(chatId));
  }

  /** "Reset all permissions" puts every chat back to the store's mode. */
  function forgetBackgroundModes() {
    for (const chatId of backgroundModes.keys()) backgroundModes.set(chatId, null);
  }

  /**
   * Ausdrückliche Wahl in der Chat-Leiste oder in den Einstellungen.
   *
   * @param {unknown} rawPresetId
   */
  async function rememberPreset(rawPresetId) {
    const presetId = chatModelPresetIdForStore(rawPresetId);
    if (!currentChatId || !presetId) return;
    rememberLocal(currentChatId, { modelPresetId: presetId });
    await persist(currentChatId, { modelPresetId: presetId });
  }

  /**
   * The level chosen for the chat on screen (#725). Main has checked it
   * against the model before; here it is only kept.
   *
   * @param {unknown} rawLevel
   */
  async function rememberReasoningEffort(rawLevel) {
    return currentChatId ? rememberReasoningEffortFor(currentChatId, rawLevel) : false;
  }

  /**
   * The level a phone chose for a chat (#1304) — any chat, on screen or not,
   * one not saved yet included: its first save takes the level along. The
   * caller has checked it against the chat's model; here it is only kept.
   *
   * @param {unknown} rawChatId
   * @param {unknown} rawLevel
   */
  async function rememberReasoningEffortFor(rawChatId, rawLevel) {
    const chatId = normalizeChatId(rawChatId);
    const level = chatReasoningEffortForStore(rawLevel);
    if (!chatId || !level) return false;
    rememberLocal(chatId, { reasoningEffort: level });
    rememberStoredLevel(chatId, level);
    await persist(chatId, { reasoningEffort: level });
    return true;
  }

  /**
   * @param {string} chatId
   * @param {string|null} level
   */
  function rememberStoredLevel(chatId, level) {
    storedLevels.delete(chatId);
    storedLevels.set(chatId, level);
    dropOldest(storedLevels, MAX_REMEMBERED_CHATS);
  }

  /**
   * The chat's own level, or `null` when it has none; without `chatId`, the
   * chat on screen's. A chat in the background answers with its own as well.
   *
   * @param {unknown} [rawChatId]
   * @returns {Promise<string|null>}
   */
  async function reasoningEffortFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId) || currentChatId;
    if (!chatId) return null;
    const local = remembered.get(chatId)?.reasoningEffort;
    if (local) return local;
    const known = storedLevels.get(chatId);
    if (known !== undefined) return known;
    try {
      const session = await chatHistoryStore.getSessionMeta(chatId);
      // Not saved yet: nothing to remember, the first save may bring a level.
      if (!session) return null;
      // A chat from before #726 that has not been on screen since: the level
      // its entry had.
      const level = chatReasoningEffortForStore(session.reasoningEffort)
        ?? chatReasoningEffortForStore((await readAlias(chatModelPresetIdForStore(session.modelPresetId)))?.reasoningEffort)
        ?? null;
      rememberStoredLevel(chatId, level);
      return level;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} chatId
   * @param {import('../../shared/contracts/chat-configuration').ChatConfigOverrides|null} overrides
   */
  function rememberStoredOverrides(chatId, overrides) {
    storedOverrides.delete(chatId);
    storedOverrides.set(chatId, overrides);
    dropOldest(storedOverrides, MAX_REMEMBERED_CHATS);
  }

  /**
   * The skills and tools a chat switched for itself (#774), or `null`. Unlike
   * the level, it is a chat's own and never the screen's: without a chat
   * there is nothing to look up.
   *
   * @param {unknown} rawChatId
   * @returns {Promise<import('../../shared/contracts/chat-configuration').ChatConfigOverrides|null>}
   */
  async function configOverridesFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId) return null;
    const own = remembered.get(chatId);
    if (own && Object.hasOwn(own, 'configOverrides')) return own.configOverrides ?? null;
    const known = storedOverrides.get(chatId);
    if (known !== undefined) return known;
    try {
      const session = await chatHistoryStore.getSessionMeta(chatId);
      const overrides = normalizeChatConfigOverrides(session?.configOverrides);
      // Not saved yet: nothing to remember — the first save brings what the
      // card set through `valuesFor`.
      if (session) rememberStoredOverrides(chatId, overrides);
      return overrides;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} chatId
   * @param {import('../../shared/contracts/chat-configuration').ChatConfigOverrides|null} overrides
   */
  async function writeOverrides(chatId, overrides) {
    rememberLocal(chatId, { configOverrides: overrides });
    rememberStoredOverrides(chatId, overrides);
    await persist(chatId, { configOverrides: overrides ?? undefined });
    return overrides;
  }

  /**
   * A proposal the user accepted on its card (#774), for that chat only.
   *
   * @param {unknown} rawChatId
   * @param {import('../../shared/contracts/chat-configuration').ConfigProposalChange} proposal
   */
  async function acceptConfigProposal(rawChatId, proposal) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId) return null;
    return writeOverrides(chatId, applyConfigProposal(await configOverridesFor(chatId), proposal));
  }

  /**
   * A proposal the user declined: the same one is not asked again in this chat.
   *
   * @param {unknown} rawChatId
   * @param {import('../../shared/contracts/chat-configuration').ConfigProposalChange} proposal
   */
  async function declineConfigProposalFor(rawChatId, proposal) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId) return null;
    return writeOverrides(chatId, declineConfigProposal(await configOverridesFor(chatId), proposal));
  }

  /**
   * @param {unknown} rawMode
   */
  async function rememberMode(rawMode) {
    const mode = chatToolPermissionModeForStore(rawMode);
    if (!currentChatId || !mode) return;
    rememberLocal(currentChatId, { toolPermissionMode: mode });
    await persist(currentChatId, { toolPermissionMode: mode });
  }

  /**
   * Werte, die der Verlauf beim Speichern übernehmen soll. Quelle ist immer
   * dieser Dienst, nie die Nutzlast des Renderers.
   *
   * @param {unknown} rawChatId
   * @returns {RememberedSettings}
   */
  function valuesFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId) return {};
    return { ...(remembered.get(chatId) || {}) };
  }

  /**
   * @param {unknown} rawChatId
   */
  function forget(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId) return;
    remembered.delete(chatId);
    backgroundModes.delete(chatId);
    storedLevels.delete(chatId);
    storedOverrides.delete(chatId);
    if (currentChatId === chatId) currentChatId = null;
  }

  return {
    activate,
    rememberPreset,
    rememberMode,
    rememberReasoningEffort,
    rememberReasoningEffortFor,
    reasoningEffortFor,
    configOverridesFor,
    acceptConfigProposal,
    declineConfigProposal: declineConfigProposalFor,
    valuesFor,
    forget,
    modeFor,
    runModeFor,
    presetFor,
    forgetBackgroundModes,
    getCurrentChatId: () => currentChatId,
  };
}

module.exports = {
  createChatSessionSettings,
  CHAT_ACTIVATION,
  MAX_REMEMBERED_CHATS,
};
