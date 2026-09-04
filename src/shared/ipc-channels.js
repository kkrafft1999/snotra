/**
 * Zentrale Definition aller IPC-Kanaele zwischen Main und Renderer.
 *
 * Single Source of Truth fuer die Kanalnamen: muss exakt dem entsprechen, was
 * main/index.js (bzw. IPC-Handler) registriert und preload.js verbindet —
 * beim Refactoring nicht stillschweigend umbenennen.
 *
 * CommonJS, damit main.js und preload.js die Datei direkt per require nutzen
 * koennen, solange das Projekt kein "type": "module" gesetzt hat.
 */

// Request/Response (ipcMain.handle <-> ipcRenderer.invoke)
const REQUEST_CHANNELS = Object.freeze({
  DIALOG_OPEN_FOLDER: 'dialog:openFolder',

  FS_READ_DIRECTORY: 'fs:readDirectory',
  FS_READ_FILE: 'fs:readFile',
  FS_MOVE_ITEM: 'fs:moveItem',
  /** Flache Pfadliste des Workspace für die @-Vervollständigung im Chat. */
  FS_LIST_WORKSPACE_PATHS: 'fs:listWorkspacePaths',
  /** Natives Kontextmenü (Öffnen / Im Finder anzeigen) für eine Datei im Dateibaum (Issue #58). */
  FS_SHOW_FILE_CONTEXT_MENU: 'fs:showFileContextMenu',

  SETTINGS_GET_LLM_STATE: 'settings:getLLMState',
  SETTINGS_SET_ACTIVE_PRESET: 'settings:setActivePreset',
  SETTINGS_COMMIT_SETTINGS: 'settings:commitSettings',
  SETTINGS_LIST_MODELS: 'settings:listModels',

  SETTINGS_GET_LAST_FOLDER: 'settings:getLastFolder',
  SETTINGS_SET_LAST_FOLDER: 'settings:setLastFolder',
  SETTINGS_GET_FOLDER_HISTORY: 'settings:getFolderHistory',
  /** Einzelnen Eintrag aus „Zuletzt geöffnete Ordner“ entfernen (Issue #57). */
  SETTINGS_REMOVE_FOLDER_FROM_HISTORY: 'settings:removeFolderFromHistory',
  SETTINGS_GET_UI_PREFS: 'settings:getUIPrefs',
  SETTINGS_SET_UI_PREFS: 'settings:setUIPrefs',
  SETTINGS_GET_TOOL_CATALOG: 'settings:getToolCatalog',
  /** Skill-Katalog (System-Skills + gefundene Ordner-Skills), Issue #18. */
  SETTINGS_GET_SKILL_CATALOG: 'settings:getSkillCatalog',
  /** Skill-Verzeichnisse erneut scannen (kein Datei-Watcher im MVP). */
  SETTINGS_RELOAD_SKILLS: 'settings:reloadSkills',

  /**
   * Link im Standardbrowser öffnen (Issue #64). Muss über den Main laufen:
   * das Fenster ist sandboxed, dort gibt es im Preload kein `shell`.
   */
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  /** Text in die Zwischenablage legen — aus demselben Grund über den Main. */
  SHELL_WRITE_CLIPBOARD_TEXT: 'shell:writeClipboardText',

  UPDATE_CHECK: 'update:check',
  UPDATE_GET_VERSION: 'update:getVersion',
  UPDATE_IGNORE_VERSION: 'update:ignoreVersion',

  CHAT_HISTORY_GET: 'chatHistory:get',
  CHAT_HISTORY_UPSERT: 'chatHistory:upsert',
  CHAT_HISTORY_DELETE: 'chatHistory:delete',
  CHAT_HISTORY_SET_ACTIVE: 'chatHistory:setActive',

  CHAT_SEND: 'chat:send',
  /** Renderer → Main (ipcRenderer.send), bricht laufenden CHAT_SEND ab. */
  CHAT_ABORT: 'chat:abort',

  WHISPER_TRANSCRIBE: 'whisper:transcribe',
});

// Push-Kanaele (webContents.send -> ipcRenderer.on).
// Werden vom Main aktiv an den Renderer gepusht und sind kein invoke().
const PUSH_CHANNELS = Object.freeze({
  CHAT_DELTA: 'chat:delta',
  CHAT_TOOL_LINE: 'chat:tool-line',
  CHAT_PROGRESS: 'chat:progress',
  UPDATE_AVAILABLE: 'update:available',
  /** Main hat eine Datei aus dem Workspace gelöscht (Kontextmenü, Issue #59); Renderer aktualisiert den Baum. */
  FS_ITEM_DELETED: 'fs:item-deleted',
});

module.exports = {
  REQUEST_CHANNELS,
  PUSH_CHANNELS,
};
