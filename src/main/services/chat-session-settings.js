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
 * `auto` after main's own native confirmation for that workspace.
 *
 * The reasoning level is the chat's third value (#725), with a rule of its
 * own: a new chat has none and runs with the provider's default, `medium`. It
 * is not applied anywhere when a chat comes on screen — a round asks for it
 * (`reasoningEffortFor`) when it starts.
 */

const {
  TOOL_PERMISSION_MODES,
  DEFAULT_TOOL_PERMISSION_MODE,
} = require('../../shared/contracts/tool-permissions');
const {
  chatModelPresetIdForStore,
  chatToolPermissionModeForStore,
  chatReasoningEffortForStore,
} = require('./chat-history-normalization');
const { CHAT_ACTIVATION } = require('../../shared/contracts/chat');

/** So viele Chats behält der Speicher — deutlich mehr als der Verlauf hält. */
const MAX_REMEMBERED_CHATS = 500;

function createChatSessionSettings({
  chatHistoryStore,
  applyPreset,
  getDefaultPresetId,
  isPresetUsable = () => true,
  applyMode,
  // Womit der Chat gerade liefe. Ohne die beiden wird stur angewandt — das ist
  // richtig, nur teurer.
  getActivePresetId = async () => null,
  getActiveMode = async () => null,
  // The default mode of the workspace on screen (#413); `null` means `smart`.
  getWorkspaceMode = async () => null,
  // A chat's own mode changed while it was being activated — its open cards
  // and session approvals were given under the old one (concept §7, #320).
  onChatModeChanged = () => {},
  // Another chat is on screen now; main drops what only the left chat needed.
  onActivated = () => {},
  log = console,
}) {
  let currentChatId = null;
  /** @type {Map<string, {modelPresetId?: string, toolPermissionMode?: string, reasoningEffort?: string}>} */
  const remembered = new Map();
  /**
   * The mode a chat had when it left the screen (#320). The store only ever
   * holds the visible chat's mode; a run that goes on in the background keeps
   * the one it was started under instead of borrowing the next chat's.
   * @type {Map<string, string>}
   */
  const backgroundModes = new Map();
  /**
   * The level each chat has in the history, as far as it was read (#725).
   * Every round asks for it; without this each one would read the whole
   * history file. Only this service writes the level, so the copy stays true.
   * @type {Map<string, string|null>}
   */
  const storedLevels = new Map();
  /** The switch still in progress; the next one waits for it (#559). */
  let activationQueue = Promise.resolve();

  function normalizeChatId(raw) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed ? trimmed.slice(0, 128) : null;
  }

  function rememberBackgroundMode(chatId, mode) {
    backgroundModes.delete(chatId);
    backgroundModes.set(chatId, mode);
    while (backgroundModes.size > MAX_REMEMBERED_CHATS) {
      backgroundModes.delete(backgroundModes.keys().next().value);
    }
  }

  function rememberLocal(chatId, patch) {
    const previous = remembered.get(chatId) || {};
    remembered.delete(chatId);
    remembered.set(chatId, { ...previous, ...patch });
    while (remembered.size > MAX_REMEMBERED_CHATS) {
      const oldest = remembered.keys().next().value;
      remembered.delete(oldest);
    }
  }

  /**
   * Wert auch in die Verlaufsdatei schreiben, sofern der Chat dort schon steht.
   * Ein Chat ohne erste Nachricht hat noch keine Zeile — dessen Wert reist über
   * `valuesFor` mit, wenn der Verlauf ihn zum ersten Mal speichert.
   */
  async function persist(chatId, patch) {
    try {
      await chatHistoryStore.withChatHistoryLock(async () => {
        const store = await chatHistoryStore.readChatHistoryStore({ skipMigration: true });
        const session = store.sessions.find((s) => s && s.id === chatId);
        if (!session) return;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete session[key];
          else session[key] = value;
        }
        await chatHistoryStore.writeChatHistoryStore(store);
      });
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
   */
  async function storedValuesFor(chatId) {
    const local = remembered.get(chatId) || {};
    if (local.modelPresetId && local.toolPermissionMode && local.reasoningEffort) return { ...local };
    return { ...(await readStoredValues(chatId)), ...local };
  }

  async function readStoredValues(chatId) {
    try {
      const store = await chatHistoryStore.readChatHistoryStore({ skipMigration: true });
      const session = store.sessions.find((s) => s && s.id === chatId);
      if (!session) return {};
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
   * Chat wird zum aktiven: gespeichertes Modell und gespeicherten Modus
   * anwenden. Liefert, was danach gilt — die Oberfläche liest ihren Stand
   * anschließend ohnehin neu, der Rückgabewert macht es für Tests prüfbar.
   */
  function activate(rawChatId, options) {
    // One switch at a time (#559): each one reads the mode the previous one
    // left. Side by side, the chat that ends up on screen could keep the mode
    // of the one clicked just before it.
    const run = activationQueue.then(() => activateNow(rawChatId, options));
    activationQueue = run.catch(() => {});
    return run;
  }

  async function activateNow(rawChatId, { activation = CHAT_ACTIVATION.EXPLICIT } = {}) {
    const chatId = normalizeChatId(rawChatId);
    const previousChatId = currentChatId;
    const activeMode = await getActiveMode();
    // The chat leaving the screen keeps its mode for a run that may still be
    // going (#320); the one coming on screen reads the store again.
    if (previousChatId && previousChatId !== chatId && activeMode) {
      rememberBackgroundMode(previousChatId, activeMode);
    }
    const modeBefore = chatId === previousChatId ? activeMode : backgroundModes.get(chatId) ?? null;
    if (chatId) backgroundModes.delete(chatId);
    currentChatId = chatId;
    const values = chatId ? await storedValuesFor(chatId) : {};
    const presetId = await resolvePresetFor(values);
    const mode = resolveModeFor(values, activation, await readWorkspaceMode());
    // Nur anfassen, was sich wirklich ändert — dasselbe gilt für die
    // Konfigurationsdatei des Modells. Writing the mode here only mirrors the
    // chat on screen into the store; it discards nothing on its own (#320).
    // The mode goes first (#559): a model switch that fails must not leave
    // this chat running under the mode of the one before it.
    if (mode !== activeMode) await applyMode(mode);
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
   */
  function modeFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId || chatId === currentChatId) return null;
    return backgroundModes.get(chatId) ?? null;
  }

  /** "Reset all permissions" puts every chat back to the store's mode. */
  function forgetBackgroundModes() {
    backgroundModes.clear();
  }

  /** Ausdrückliche Wahl in der Chat-Leiste oder in den Einstellungen. */
  async function rememberPreset(rawPresetId) {
    const presetId = chatModelPresetIdForStore(rawPresetId);
    if (!currentChatId || !presetId) return;
    rememberLocal(currentChatId, { modelPresetId: presetId });
    await persist(currentChatId, { modelPresetId: presetId });
  }

  /**
   * The level chosen for the chat on screen (#725). Main has checked it
   * against the model before; here it is only kept.
   */
  async function rememberReasoningEffort(rawLevel) {
    const level = chatReasoningEffortForStore(rawLevel);
    if (!currentChatId || !level) return false;
    rememberLocal(currentChatId, { reasoningEffort: level });
    rememberStoredLevel(currentChatId, level);
    await persist(currentChatId, { reasoningEffort: level });
    return true;
  }

  function rememberStoredLevel(chatId, level) {
    storedLevels.delete(chatId);
    storedLevels.set(chatId, level);
    while (storedLevels.size > MAX_REMEMBERED_CHATS) {
      storedLevels.delete(storedLevels.keys().next().value);
    }
  }

  /**
   * The chat's own level, or `null` when it has none; without `chatId`, the
   * chat on screen's. A chat in the background answers with its own as well.
   */
  async function reasoningEffortFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId) || currentChatId;
    if (!chatId) return null;
    const local = remembered.get(chatId)?.reasoningEffort;
    if (local) return local;
    if (storedLevels.has(chatId)) return storedLevels.get(chatId);
    try {
      const store = await chatHistoryStore.readChatHistoryStore({ skipMigration: true });
      const session = store.sessions.find((s) => s && s.id === chatId);
      // Not saved yet: nothing to remember, the first save may bring a level.
      if (!session) return null;
      const level = chatReasoningEffortForStore(session.reasoningEffort) ?? null;
      rememberStoredLevel(chatId, level);
      return level;
    } catch {
      return null;
    }
  }

  async function rememberMode(rawMode) {
    const mode = chatToolPermissionModeForStore(rawMode);
    if (!currentChatId || !mode) return;
    rememberLocal(currentChatId, { toolPermissionMode: mode });
    await persist(currentChatId, { toolPermissionMode: mode });
  }

  /**
   * Werte, die der Verlauf beim Speichern übernehmen soll. Quelle ist immer
   * dieser Dienst, nie die Nutzlast des Renderers.
   */
  function valuesFor(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId) return {};
    return { ...(remembered.get(chatId) || {}) };
  }

  function forget(rawChatId) {
    const chatId = normalizeChatId(rawChatId);
    if (!chatId) return;
    remembered.delete(chatId);
    backgroundModes.delete(chatId);
    storedLevels.delete(chatId);
    if (currentChatId === chatId) currentChatId = null;
  }

  return {
    activate,
    rememberPreset,
    rememberMode,
    rememberReasoningEffort,
    reasoningEffortFor,
    valuesFor,
    forget,
    modeFor,
    forgetBackgroundModes,
    getCurrentChatId: () => currentChatId,
  };
}

module.exports = {
  createChatSessionSettings,
  CHAT_ACTIVATION,
  MAX_REMEMBERED_CHATS,
};
