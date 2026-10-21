'use strict';

/**
 * The MCP servers as Settings › MCP sees them (#106–#108), and the take-over
 * of the saved list into the running service.
 *
 * Decrypting the saved servers happens here and only here: `reload` hands the
 * result to the service, and nothing of it leaves the main process. What goes
 * to the window — a status, a test result — is masked against the own secrets
 * first (CR-B14-01), because a server that fails at start-up likes to print
 * its environment.
 */

const { maskMcpStatuses } = require('./mcp-status-masking');
const { migrateMcpDisabledTools } = require('./mcp-disabled-tools-migration');
const { qualifiedMcpToolName, validateMcpServerInput } = require('../../shared/contracts/mcp');
const {
  launchBeforeFromListed,
  mcpLaunchNeedsConfirmation,
  mcpLaunchSubject,
} = require('./mcp-launch-confirmation');
const { createMessage } = require('../../shared/contracts/message');

/** @typedef {import('../../shared/contracts/mcp').McpServerView} McpServerView */
/** @typedef {import('../../shared/contracts/message').Message} Message */

/**
 * The saved servers, as the settings read and write them (`storage-service`):
 * without any secret on the way out.
 *
 * @typedef {Object} McpConfigStore
 * @property {() => Promise<McpServerView[]>} readMcpServers
 * @property {(input: Record<string, unknown>, options?: { confirmation?: object|null }) => Promise<{ ok: boolean, errors: Message[], endpointChanged?: boolean, notConfirmed?: boolean }>} saveMcpServer
 * @property {(id: string) => Promise<{ ok: boolean, errors: Message[] }>} deleteMcpServer
 * @property {() => Promise<unknown>} clearMcpServerDisabledTools
 */

/**
 * @param {Object} deps
 * @param {import('./mcp-service').McpService} deps.mcpService
 * @param {{ describeSkippedTools: () => Array<{ serverId: string, name: string, reason: Message }> }} deps.mcpAdapter
 * @param {McpConfigStore} deps.mcpConfigStore   the saved servers, without their secrets
 * @param {{ getMcpServersForRuntime: () => Promise<import('../../shared/contracts/mcp').McpServerConfig[]> }} deps.mcpSecrets
 * @param {{ readMcpSecrets: () => Promise<string[]> }} deps.ownSecrets
 * @param {import('../ports/ui-prefs-store-port').UiPrefsStorePort} deps.uiPrefsStore  for the one-time move of deselected tools (#449)
 * @param {Pick<Console, 'warn'>} [deps.log]
 */
function createMcpSettings({ mcpService, mcpAdapter, mcpConfigStore, mcpSecrets, ownSecrets, uiPrefsStore, log = console }) {
  let loadFailed = false;

  /** Takes the saved server list over into the running service (#108). */
  async function reload() {
    try {
      mcpService.setServers(await mcpSecrets.getMcpServersForRuntime());
      loadFailed = false;
    } catch (error) {
      // The service keeps the servers it had — at start-up none. The MCP
      // section says so until a reload gets through (#1002).
      loadFailed = true;
      throw error;
    }
  }

  return {
    listServers: () => mcpConfigStore.readMcpServers(),
    // The snapshot itself stays synchronous so the display never waits for a
    // hanging server; only reading the secrets is awaited.
    async describeConnections() {
      return maskMcpStatuses(mcpService.describeConnections(), await ownSecrets.readMcpSecrets());
    },
    describeSkippedTools: () => mcpAdapter.describeSkippedTools(),
    /** Whether the last take-over of the saved servers failed (#1002). */
    hasLoadFailed: () => loadFailed,
    /**
     * What saving `input` would start that nobody confirmed (#1104): null,
     * or the subject to confirm and what the prompt names. Decided from the
     * stored list; the store decides again under its lock.
     */
    /** @param {Record<string, unknown>} input */
    async launchConfirmation(input) {
      if (!input || typeof input !== 'object') return null;
      const servers = await mcpConfigStore.readMcpServers();
      const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
      const stored = servers.find((server) => server.id === id) || null;
      // A taken identifier is refused by the store anyway — no prompt first.
      if (input.create === true && stored) return null;
      const listed = input.create === true ? null : stored;
      // An input without a transport keeps the stored one, as the store does.
      const withTransport = input.transport === undefined || input.transport === null
        ? { ...input, transport: listed?.transport }
        : input;
      const { ok, value, env } = validateMcpServerInput(withTransport);
      if (!ok || !value || !mcpLaunchNeedsConfirmation(value, env, launchBeforeFromListed(listed))) return null;
      return {
        subject: mcpLaunchSubject(value, env),
        server: {
          label: value.label || value.id,
          command: value.command,
          args: value.args,
          cwd: value.cwd || '',
          envKeys: env.map((entry) => entry.key).sort(),
        },
      };
    },
    /**
     * @param {Record<string, unknown>} input
     * @param {{ confirmation?: object|null }} [options]
     */
    save: (input, options) => mcpConfigStore.saveMcpServer(input, options),
    /** @param {string} id */
    remove: (id) => mcpConfigStore.deleteMcpServer(id),
    reload,
    /** @param {string} id */
    async test(id) {
      // The *saved* server is tested, not a configuration sent along with the
      // request: otherwise the window would have to send secrets.
      await reload();
      const status = await mcpService.connect(id);
      if (!status) return { status: null, error: createMessage('settings.error.mcp.unknownServer', { id }) };
      const [masked] = maskMcpStatuses([status], await ownSecrets.readMcpSecrets());
      // The tested server's tools come with its status. `listTools()` would
      // connect every enabled server and wait for the slowest (CR-B16-07).
      return { status: masked, tools: status.toolNames };
    },
    /**
     * At start-up: a tool deselected per server moves to the one switch it
     * has since #449, then the saved servers are taken over. Starts no
     * process — the service connects lazily. A failed move does not hold up
     * the take-over.
     */
    start: () =>
      migrateMcpDisabledTools({ mcpConfigStore, uiPrefsStore, qualify: qualifiedMcpToolName, log })
        .catch(() => {})
        .then(() => reload()),
  };
}

module.exports = {
  createMcpSettings,
};
