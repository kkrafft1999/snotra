'use strict';

const { describeRememberedMcpTools } = require('./mcp-remembered-tools');

/**
 * What main reads for Settings › Security (#447, #448) and for the mode pill
 * (#357). Only reading and shaping: the verdicts come from
 * `application/permissions/security-overview.js`, and the IPC handlers in
 * `ipc/tool-permission-handlers.js` put the two together.
 */
function createSecurityPageData({
  chatHistoryStore,
  uiPrefsStore,
  toolRegistry,
  mcpConfigStore,
  pythonRunner,
  shellRunner,
  sandboxService,
  /** The recent folders (#1119); optional. */
  workspaceFolderStore = null,
  /** fs/promises, to see whether a listed workspace is still there (#1119). */
  fs = null,
  /** Called once a sandbox detection started from here is done. */
  onSandboxDetected = () => {},
}) {
  /** Titles of the given chats, for the list of session approvals (#447). */
  async function describeChats(chatIds) {
    const wanted = new Set(chatIds);
    const titles = new Map();
    if (wanted.size === 0) return titles;
    for (const session of await chatHistoryStore.listSessions()) {
      if (session && wanted.has(session.id) && typeof session.title === 'string' && session.title.trim()) {
        titles.set(session.id, session.title.trim());
      }
    }
    return titles;
  }

  /**
   * Every tool the settings list, with its classes and whether it is offered
   * (#448). A tick in Settings › Tools and the availability (the execution
   * switches, a search key, a server) both count.
   */
  async function describeTools() {
    const prefs = await uiPrefsStore.readUIPrefs();
    const disabled = new Set(Array.isArray(prefs.disabledTools) ? prefs.disabledTools : []);
    const catalog = toolRegistry.listRiskCatalog({ locale: prefs.appLocale });
    // MCP tools the registry does not have yet — no run since the start —
    // come from what each server reported last time (#464), so they can be
    // switched off before the first run offers them.
    let servers = [];
    try {
      servers = await mcpConfigStore.readMcpServers();
    } catch {
      servers = [];
    }
    return [...catalog, ...describeRememberedMcpTools({ servers, present: catalog, locale: prefs.appLocale })]
      .map((tool) => ({ ...tool, disabled: disabled.has(tool.name) }));
  }

  /**
   * The chats of a workspace with the mode stored for each (#448); `null`
   * where a chat has none and starts on the workspace default.
   */
  async function describeWorkspaceChats(root) {
    const wsRoot = chatHistoryStore.normalizeWorkspaceRoot(root);
    return (await chatHistoryStore.listSessions())
      .filter((session) => session && typeof session.id === 'string' && chatHistoryStore.sessionMatchesWorkspace(session, wsRoot))
      .map((session) => ({
        id: session.id,
        title: typeof session.title === 'string' ? session.title.trim() : '',
        mode: typeof session.toolPermissionMode === 'string' ? session.toolPermissionMode : null,
      }));
  }

  /**
   * Which execution tools the model is offered, and what the sandbox can do
   * (#357). The mode pill turns amber when "Auto" would run them unisolated.
   * Detection only runs when one of them is on — as for the settings — and
   * is not waited for: the self-test can take seconds, and the pill should
   * not hang on it. Once it is known, `onSandboxDetected` says so.
   */
  async function describeExecutionTools() {
    let disabledTools = [];
    try {
      const prefs = await uiPrefsStore.readUIPrefs();
      disabledTools = Array.isArray(prefs.disabledTools) ? prefs.disabledTools : [];
    } catch {
      disabledTools = [];
    }
    const active = [];
    if (pythonRunner.isAvailable() && !disabledTools.includes('run_python')) active.push('run_python');
    if (shellRunner.isAvailable() && !disabledTools.includes('shell_execute')) active.push('shell_execute');
    const sandbox = sandboxService.describe();
    if (active.length > 0 && (sandbox.status === 'unknown' || sandbox.status === 'testing')) {
      void sandboxService.detect().then(() => onSandboxDetected(), () => {});
    }
    return { active, sandbox };
  }

  /**
   * Every folder Snotra has worked in (#1119): the recent folders, the last
   * one, and the folders of the stored chats. They keep their sandbox setting
   * when new workspaces start without the sandbox.
   */
  async function listKnownWorkspaces() {
    const roots = new Set();
    const add = (value) => {
      if (typeof value === 'string' && value) roots.add(value);
    };
    try {
      for (const entry of (await workspaceFolderStore?.getValidatedFolderHistory?.()) || []) add(entry);
      add(await workspaceFolderStore?.getValidatedLastFolder?.());
    } catch {
      /* the chats below still count */
    }
    try {
      for (const session of (await chatHistoryStore.listSessions()) || []) add(session?.workspaceRoot);
    } catch {
      /* what was found so far counts */
    }
    return [...roots];
  }

  /** Whether a workspace listed on Tools › Security is still a folder (#1119). */
  async function folderExists(root) {
    if (!fs || typeof root !== 'string' || !root) return true;
    try {
      return (await fs.stat(root)).isDirectory();
    } catch {
      // Gone, or no longer a folder: the page lists it as missing.
      return false;
    }
  }

  return { describeChats, describeTools, describeWorkspaceChats, describeExecutionTools, listKnownWorkspaces, folderExists };
}

module.exports = { createSecurityPageData };
