'use strict';

/**
 * One switch per MCP tool (#449). Until then an MCP tool could be deselected
 * in two places: per server in the MCP dialog (stored with the server) and in
 * Settings › Tools (`uiPrefs.disabledTools`). A tool deselected per server
 * never reaches the tool catalog (mcp-service.js `listTools`), so the
 * Security page could neither show it nor switch it back on.
 *
 * At start the per-server lists move into `uiPrefs.disabledTools` under the
 * qualified name the catalog uses, and the server lists are emptied. The
 * preferences are written first: a start that stops in between leaves a tool
 * deselected twice, never switched on by accident.
 */
async function migrateMcpDisabledTools({ mcpConfigStore, uiPrefsStore, qualify, log = null }) {
  let servers;
  try {
    servers = await mcpConfigStore.readMcpServers();
  } catch (error) {
    log?.warn?.(`[mcp] Could not read the servers to move deselected tools: ${error?.message || error}`);
    return { moved: [] };
  }
  const moved = [];
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server || typeof server.id !== 'string') continue;
    for (const name of Array.isArray(server.disabledTools) ? server.disabledTools : []) {
      if (typeof name === 'string' && name) moved.push(qualify(server.id, name));
    }
  }
  if (moved.length === 0) return { moved };
  await uiPrefsStore.updateUIPrefs((prefs) => {
    const current = Array.isArray(prefs.disabledTools) ? prefs.disabledTools : [];
    return { ...prefs, disabledTools: [...new Set([...current, ...moved])] };
  });
  await mcpConfigStore.clearMcpServerDisabledTools();
  return { moved };
}

module.exports = { migrateMcpDisabledTools };
