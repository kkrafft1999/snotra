'use strict';

const { fitsMcpToolNameLimit, mcpRiskClassesFor, qualifiedMcpToolName } = require('../../shared/contracts/mcp');
const { createTranslator } = require('../../shared/i18n');

/**
 * The MCP tools Settings › Security can show before a server is connected
 * (#464). MCP tools enter the registry only when a chat run starts, and a
 * server connects only when it is needed (#106) — so without this, the first
 * run of a session would always offer every tool of every enabled server,
 * with no chance to switch one off beforehand.
 *
 * Every connection remembers its tool names with the server (`knownTools`);
 * those names are enough for a switch, because the switch is the name in
 * `uiPrefs.disabledTools`. What a name alone cannot say is filled in the
 * strict way: the minimum classes of every MCP tool (execute and external),
 * as if the server had declared nothing. The real definition replaces the
 * entry as soon as the registry has it.
 *
 * A server that is switched off offers nothing, so its remembered tools are
 * listed as not available — the same as a tool without its key.
 */
function describeRememberedMcpTools({ servers, present, locale } = {}) {
  const t = createTranslator(locale);
  const known = new Set((Array.isArray(present) ? present : []).map((tool) => tool?.name));
  const out = [];
  for (const server of Array.isArray(servers) ? servers : []) {
    if (!server || typeof server.id !== 'string' || !server.id) continue;
    const label = server.label || server.id;
    for (const toolName of Array.isArray(server.knownTools) ? server.knownTools : []) {
      if (typeof toolName !== 'string' || !toolName) continue;
      const name = qualifiedMcpToolName(server.id, toolName);
      // A name over the limit never reaches the registry either.
      if (!fitsMcpToolNameLimit(name) || known.has(name)) continue;
      known.add(name);
      out.push({
        name,
        shortDescription: t('tools.mcp.short.remembered', { server: label }),
        riskClasses: mcpRiskClassesFor(null),
        available: server.enabled === true,
        mayOverwrite: false,
        mcpServer: label,
        mcpServerId: server.id,
      });
    }
  }
  return out;
}

module.exports = { describeRememberedMcpTools };
