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
  /**
   * Bytes eines Bildes aus dem Arbeitsordner als `{ mime, base64 }` (Issue
   * #244). Braucht einen eigenen Kanal, weil `FS_READ_FILE` Text vorschaut und
   * hier Typ, Groesse und Symlink-Ausbruch anders geprueft werden.
   */
  FS_READ_WORKSPACE_IMAGE: 'fs:readWorkspaceImage',
  /**
   * Bytes of a PDF from the open folder for the file preview (#346), checked
   * like an image, returned as a Uint8Array. `PDF_READ_ASSET` hands pdf.js
   * the CMaps, fonts and decoders it ships with, from fixed folders only.
   */
  FS_READ_WORKSPACE_PDF: 'fs:readWorkspacePdf',
  PDF_READ_ASSET: 'pdf:readAsset',
  /**
   * An HTML file as a live page (#479), in a view of its own that main lays
   * over the preview column. The renderer names the file and says where the
   * view goes; what the page may load, and where its links lead, main
   * decides. `HTML_PREVIEW_OPEN_IN_BROWSER` hands the file to the system.
   */
  HTML_PREVIEW_OPEN: 'htmlPreview:open',
  HTML_PREVIEW_SET_BOUNDS: 'htmlPreview:setBounds',
  HTML_PREVIEW_RELOAD: 'htmlPreview:reload',
  HTML_PREVIEW_CHECK: 'htmlPreview:check',
  HTML_PREVIEW_FOCUS: 'htmlPreview:focus',
  HTML_PREVIEW_CLOSE: 'htmlPreview:close',
  HTML_PREVIEW_OPEN_IN_BROWSER: 'htmlPreview:openInBrowser',
  FS_MOVE_ITEM: 'fs:moveItem',
  /** New file or folder, and rename, from the tree (#349); main checks path and name. */
  FS_CREATE_ITEM: 'fs:createItem',
  FS_RENAME_ITEM: 'fs:renameItem',
  /** Flache Pfadliste des Workspace für die @-Vervollständigung im Chat. */
  FS_LIST_WORKSPACE_PATHS: 'fs:listWorkspacePaths',
  /** Natives Kontextmenü für Datei oder Ordner im Dateibaum (Issues #58, #120). */
  FS_SHOW_FILE_CONTEXT_MENU: 'fs:showFileContextMenu',
  /** "Reveal" from the information dialog (#849); main checks the path against the workspace. */
  FS_REVEAL_ITEM: 'fs:revealItem',
  /** The entries behind ‹ or › in the preview header, as a native menu (#822). */
  UI_SHOW_PREVIEW_HISTORY_MENU: 'ui:showPreviewHistoryMenu',
  /**
   * Import von außen (Issue #101): Drop aus Finder/Explorer in den Dateibaum.
   * Eigene Kanäle, weil hier bewusst nur das **Ziel** gegen den Workspace
   * geprüft wird — die Quelle liegt per Definition außerhalb. `inspectImport`
   * zählt nur (beratend für den Renderer), `importItems` bestätigt nativ und
   * kopiert.
   */
  FS_INSPECT_IMPORT: 'fs:inspectImport',
  FS_IMPORT_ITEMS: 'fs:importItems',

  SETTINGS_GET_LLM_STATE: 'settings:getLLMState',
  SETTINGS_SET_ACTIVE_PRESET: 'settings:setActivePreset',
  SETTINGS_SET_REASONING_EFFORT: 'settings:setReasoningEffort',
  SETTINGS_COMMIT_SETTINGS: 'settings:commitSettings',
  SETTINGS_CANCEL_MODELS: 'settings:cancelModels',
  SETTINGS_LIST_MODELS: 'settings:listModels',

  SETTINGS_GET_LAST_FOLDER: 'settings:getLastFolder',
  /**
   * Bereits bekannten Ordner (Verlauf oder letzter Ordner) zum aktiven
   * Workspace machen. Nimmt bewusst KEINEN freien Pfad an — der Main-Prozess
   * prüft gegen den gespeicherten Verlauf (Issue #68). Neue Ordner kommen
   * ausschließlich über DIALOG_OPEN_FOLDER herein.
   */
  SETTINGS_ACTIVATE_FOLDER: 'settings:activateFolder',
  SETTINGS_GET_FOLDER_HISTORY: 'settings:getFolderHistory',
  /** Einzelnen Eintrag aus „Zuletzt geöffnete Ordner“ entfernen (Issue #57). */
  SETTINGS_REMOVE_FOLDER_FROM_HISTORY: 'settings:removeFolderFromHistory',
  SETTINGS_GET_UI_PREFS: 'settings:getUIPrefs',
  SETTINGS_SET_UI_PREFS: 'settings:setUIPrefs',
  SETTINGS_GET_TOOL_CATALOG: 'settings:getToolCatalog',
  /**
   * Websuche (Issue #63): Ob ein Schluessel des Suchdienstes hinterlegt ist,
   * und das Setzen bzw. Loeschen. Der Schluessel selbst geht nie an den
   * Renderer zurueck — nur die Ja/Nein-Auskunft.
   */
  /**
   * MCP-Server (Issue #108). Der Katalog liefert die Serverliste in
   * Anzeigeform — env-Werte, die als geheim abgelegt sind, kommen nur als
   * „vorhanden“ zurueck, nie als Wert. Gespeichert wird je Server; „neu
   * laden“ uebernimmt die Datei in den laufenden Dienst, ohne App-Neustart.
   * „Testen“ startet den Server einmal und meldet Status und Tool-Liste.
   */
  SETTINGS_GET_MCP_CATALOG: 'settings:getMcpCatalog',
  SETTINGS_SAVE_MCP_SERVER: 'settings:saveMcpServer',
  SETTINGS_DELETE_MCP_SERVER: 'settings:deleteMcpServer',
  SETTINGS_RELOAD_MCP_SERVERS: 'settings:reloadMcpServers',
  SETTINGS_TEST_MCP_SERVER: 'settings:testMcpServer',
  SETTINGS_GET_WEB_SEARCH_STATE: 'settings:getWebSearchState',
  SETTINGS_SET_WEB_SEARCH_API_KEY: 'settings:setWebSearchApiKey',
  /**
   * Image generation (#85): whether an OpenAI key is there and which model
   * draws, and the image models the key can reach. The model is chosen
   * through the UI prefs (`imageModel`).
   */
  SETTINGS_GET_IMAGE_GENERATION_STATE: 'settings:getImageGenerationState',
  SETTINGS_LIST_IMAGE_MODELS: 'settings:listImageModels',
  SETTINGS_CANCEL_IMAGE_MODELS: 'settings:cancelImageModels',
  /**
   * Python-Ausfuehrung (Issue #86): gefundener Interpreter, dessen Version und
   * ob die Einstellung eingeschaltet ist. Nur Auskunft — geschaltet wird ueber
   * die UI-Prefs.
   */
  SETTINGS_GET_PYTHON_STATE: 'settings:getPythonState',
  SETTINGS_GET_SHELL_STATE: 'settings:getShellState',
  /** Skill-Katalog (System-Skills + gefundene Ordner-Skills), Issue #18. */
  SETTINGS_GET_SKILL_CATALOG: 'settings:getSkillCatalog',
  /** Skill-Verzeichnisse sofort erneut scannen — Ausweg neben dem Watcher (#126). */
  SETTINGS_RELOAD_SKILLS: 'settings:reloadSkills',
  /** Passenden Skill zur Eingabe vom Modell vorschlagen lassen (Issue #125). */
  SKILLS_SUGGEST: 'skills:suggest',
  /** Gedaechtnis beider Ebenen samt Eintraegen und Pfaden lesen (Issue #166). */
  SETTINGS_GET_MEMORY: 'settings:getMemory',
  /** Einen einzelnen Gedaechtnis-Eintrag vergessen (Issue #166). */
  SETTINGS_FORGET_MEMORY: 'settings:forgetMemory',

  /**
   * Link im Standardbrowser öffnen (Issue #64). Muss über den Main laufen:
   * das Fenster ist sandboxed, dort gibt es im Preload kein `shell`.
   */
  SHELL_OPEN_EXTERNAL: 'shell:openExternal',
  /** Text in die Zwischenablage legen — aus demselben Grund über den Main. */
  SHELL_WRITE_CLIPBOARD_TEXT: 'shell:writeClipboardText',

  /**
   * Tool-Berechtigungen (Issue #66). Modus, Regeln und sensible Pfadmuster
   * liegen in einer signierten Policy-Datei im Main; der Renderer liest den
   * Stand und stoesst Aenderungen an. Schutzlockernde Aktionen (Auto,
   * dauerhafte Erlaubnis, Sperre loeschen) bestaetigt Main nativ.
   */
  TOOL_PERMISSIONS_GET_STATE: 'toolPermissions:getState',
  /** The effective state of the open workspace per risk class (#448). */
  TOOL_PERMISSIONS_GET_SECURITY_OVERVIEW: 'toolPermissions:getSecurityOverview',
  TOOL_PERMISSIONS_SET_MODE: 'toolPermissions:setMode',
  TOOL_PERMISSIONS_ADD_RULE: 'toolPermissions:addRule',
  TOOL_PERMISSIONS_REMOVE_RULE: 'toolPermissions:removeRule',
  TOOL_PERMISSIONS_SET_SENSITIVE_PATHS: 'toolPermissions:setSensitivePaths',
  TOOL_PERMISSIONS_CLEAR_SESSION_GRANTS: 'toolPermissions:clearSessionGrants',
  TOOL_PERMISSIONS_REVOKE_SESSION_GRANT: 'toolPermissions:revokeSessionGrant',
  TOOL_PERMISSIONS_RESET_WORKSPACE_RULES: 'toolPermissions:resetWorkspaceRules',
  TOOL_PERMISSIONS_RESET_ALL: 'toolPermissions:resetAll',
  TOOL_PERMISSIONS_SET_WORKSPACE_SANDBOX: 'toolPermissions:setWorkspaceSandbox',
  TOOL_PERMISSIONS_SET_WORKSPACE_MODE: 'toolPermissions:setWorkspaceMode',
  /** Program allowances (#408): widening is confirmed natively by main. */
  TOOL_PERMISSIONS_SET_PROGRAM_ALLOWANCE: 'toolPermissions:setProgramAllowance',
  TOOL_PERMISSIONS_REMOVE_PROGRAM_ALLOWANCE: 'toolPermissions:removeProgramAllowance',
  TOOL_PERMISSIONS_RESOLVE_PROGRAM: 'toolPermissions:resolveProgram',
  TOOL_PERMISSIONS_CHOOSE_ALLOWANCE_FOLDER: 'toolPermissions:chooseAllowanceFolder',
  /** Renderer meldet sich als freigabefaehig an (Karten koennen angezeigt werden). */
  TOOL_APPROVAL_SUBSCRIBE: 'toolApproval:subscribe',
  /** Antwort auf eine Freigabe-Karte: nur requestId + Entscheidung. */
  TOOL_APPROVAL_RESPOND: 'toolApproval:respond',
  /** Offene Anfragen dieses Fensters (z. B. nach Reload). */
  TOOL_APPROVAL_LIST_PENDING: 'toolApproval:listPending',
  /**
   * A card waits while Snotra is in the background or in another chat
   * (#792, step 5): a system notification, and closing it once decided.
   */
  APPROVAL_NOTIFICATION_SHOW: 'approvalNotification:show',
  APPROVAL_NOTIFICATION_CLOSE: 'approvalNotification:close',

  UPDATE_CHECK: 'update:check',
  UPDATE_GET_VERSION: 'update:getVersion',
  UPDATE_IGNORE_VERSION: 'update:ignoreVersion',
  /**
   * Selbst-Update (Issue #232). Bewusst drei getrennte Schritte statt eines
   * „update jetzt": Der Nutzer bestaetigt Laden und Installieren einzeln und
   * kann dazwischen aussteigen. Die Download-Adresse nennt immer der Main —
   * der Renderer stoesst nur an.
   */
  UPDATE_DOWNLOAD: 'update:download',
  UPDATE_CANCEL_DOWNLOAD: 'update:cancelDownload',
  UPDATE_DISCARD_DOWNLOAD: 'update:discardDownload',
  UPDATE_INSTALL: 'update:install',

  CHAT_HISTORY_GET: 'chatHistory:get',
  CHAT_HISTORY_UPSERT: 'chatHistory:upsert',
  CHAT_HISTORY_DELETE: 'chatHistory:delete',
  CHAT_HISTORY_SET_ACTIVE: 'chatHistory:setActive',
  /**
   * Chat wird zum aktiven (Issue #211): Der Main stellt Modell und
   * Freigabemodus dieses Chats her. Der Renderer nennt nur die Kennung und ob
   * der Wechsel ausdruecklich war — die Werte selbst liegen im Main.
   */
  CHAT_HISTORY_ACTIVATE: 'chatHistory:activate',
  /**
   * Bilddaten eines gespeicherten Anhangs (Issue #94). Der Verlauf traegt nur
   * die Datei-Referenz; der Renderer holt das Bild erst beim Anzeigen nach.
   */
  CHAT_ATTACHMENT_READ: 'chatHistory:readAttachment',

  CHAT_SEND: 'chat:send',
  /** Laesst das aktive Modell eine Ueberschrift fuer die Konversation bilden. */
  CHAT_TITLE: 'chat:title',
  /** Renderer → Main (ipcRenderer.send), bricht laufenden CHAT_SEND ab. */
  CHAT_ABORT: 'chat:abort',
  /** What one or more writing calls changed in a file (#348). */
  CHAT_FILE_CHANGES: 'chat:file-changes',

  WHISPER_CANCEL: 'whisper:cancel',
  WHISPER_TRANSCRIBE: 'whisper:transcribe',
});

// Push-Kanaele (webContents.send -> ipcRenderer.on).
// Werden vom Main aktiv an den Renderer gepusht und sind kein invoke().
const PUSH_CHANNELS = Object.freeze({
  CHAT_DELTA: 'chat:delta',
  CHAT_TOOL_LINE: 'chat:tool-line',
  CHAT_PROGRESS: 'chat:progress',
  UPDATE_AVAILABLE: 'update:available',
  /** Fortschritt des laufenden Update-Downloads (Issue #232). */
  UPDATE_PROGRESS: 'update:progress',
  /** Main hat eine Datei aus dem Workspace gelöscht (Kontextmenü, Issue #59); Renderer aktualisiert den Baum. */
  FS_ITEM_DELETED: 'fs:item-deleted',
  /** "Remove mark" in the tree's context menu (#347); payload { path }, the path the renderer asked for. */
  FS_CLEAR_AGENT_MARK: 'fs:clear-agent-mark',
  /** "Show changes" in the context menu of a file (#348). */
  FS_SHOW_CHANGES: 'fs:show-changes',
  /**
   * "Information" in the context menu (#849): `{ itemPath, name, path, kind,
   * type, summary, details, revealLabel }`, already worded in the interface
   * language; the renderer draws its own dialog from it.
   */
  FS_SHOW_INFO: 'fs:show-info',
  /**
   * What happened in an HTML page (#479): `{ id, type, … }` with type
   * `blocked` (the refused requests so far), `open-file` (a link to another
   * file, after a click), `focus-leave` (F6 inside the page), `loaded`,
   * `unresponsive`, `responsive` and `gone`.
   */
  HTML_PREVIEW_EVENT: 'htmlPreview:event',
  /**
   * "New File…" / "New Folder…" / "Rename…" in the context menu (#349): the
   * renderer opens the name field in the tree. Payloads { path, kind } — the
   * folder to create in — and { path }; nothing is written before the name
   * comes back over FS_CREATE_ITEM / FS_RENAME_ITEM.
   */
  FS_BEGIN_CREATE: 'fs:begin-create',
  FS_BEGIN_RENAME: 'fs:begin-rename',
  /**
   * Im Projektordner hat sich etwas geändert (Issue #158) — von wem auch
   * immer: KI, Terminal, Finder, anderer Editor. Nutzlast ist ein
   * WorkspaceTreeChanged-DTO ({ directories, complete }); der Renderer lädt
   * die betroffenen, gerade sichtbaren Ordner neu.
   */
  FS_TREE_CHANGED: 'fs:tree-changed',
  /** Freigabe-Karte anzeigen (Issue #66); Payload ist ein ToolApprovalRequest-DTO. */
  TOOL_APPROVAL_REQUEST: 'toolApproval:request',
  /** Anfrage beantwortet oder verfallen; Karte schliessen. */
  TOOL_APPROVAL_RESOLVED: 'toolApproval:resolved',
  /** The notification about a waiting card was clicked (#792, step 5): open its chat. */
  APPROVAL_NOTIFICATION_OPEN: 'approvalNotification:open',
  /** Modus, Regeln oder Muster haben sich geaendert; Anzeige aktualisieren. */
  TOOL_PERMISSIONS_CHANGED: 'toolPermissions:changed',
  /** Ein Skill-Verzeichnis hat sich geaendert (Issue #126); Katalog neu holen. */
  SKILLS_CHANGED: 'skills:changed',
  /** Menue "Ansicht > Seitenleiste ein-/ausblenden" bzw. Cmd/Ctrl+B (Issue #167). */
  UI_TOGGLE_SIDEBAR: 'ui:toggle-sidebar',
  /** Menueeintrag "Einstellungen…" bzw. Cmd/Ctrl+Komma. */
  UI_OPEN_SETTINGS: 'ui:open-settings',
  /** Menu "File > New Chat" or Cmd/Ctrl+N (issue #381). */
  UI_NEW_CHAT: 'ui:new-chat',
  /** Menu "View > Preview or Source" or Cmd/Ctrl+Shift+M (#344, #345). */
  UI_TOGGLE_MARKDOWN_SOURCE: 'ui:toggle-markdown-source',
  /** Menu "View > Show Hidden Files" or Cmd+Shift+. / Ctrl+Shift+. (#436). */
  UI_TOGGLE_HIDDEN_FILES: 'ui:toggle-hidden-files',
  /** Menu "View > Filter Files…" or Cmd/Ctrl+P (#350). */
  UI_FILTER_FILES: 'ui:filter-files',
  /** Menu "View > Back / Forward", Cmd+[ / Cmd+] or Alt+Left / Alt+Right (#822). */
  UI_PREVIEW_BACK: 'ui:preview-back',
  UI_PREVIEW_FORWARD: 'ui:preview-forward',
  /** The entry picked in the menu behind ‹ or ›: `{ token, index }` (#822). */
  UI_PREVIEW_HISTORY_CHOICE: 'ui:preview-history-choice',
});

module.exports = {
  REQUEST_CHANNELS,
  PUSH_CHANNELS,
};
