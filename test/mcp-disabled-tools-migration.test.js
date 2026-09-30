// One switch per MCP tool (#449): a tool deselected per server moves into
// uiPrefs.disabledTools under its qualified name, the server list empties,
// and the preferences are written before the server lists are touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrateMcpDisabledTools } = require('../src/main/services/mcp-disabled-tools-migration');
const { qualifiedMcpToolName } = require('../src/shared/contracts/mcp');

function stores({ servers, prefs = {} }) {
  const order = [];
  let current = { ...prefs };
  let serverList = servers.map((server) => ({ ...server }));
  return {
    order,
    prefs: () => current,
    servers: () => serverList,
    mcpConfigStore: {
      async readMcpServers() {
        return serverList;
      },
      async clearMcpServerDisabledTools() {
        order.push('clear');
        serverList = serverList.map((server) => ({ ...server, disabledTools: [] }));
        return [];
      },
    },
    uiPrefsStore: {
      async updateUIPrefs(updater) {
        order.push('prefs');
        current = await updater({ ...current });
        return current;
      },
    },
  };
}

test('deselected MCP tools move to the one switch, prefs first', async () => {
  const s = stores({
    servers: [
      { id: 'github', disabledTools: ['delete_repo', 'merge_pr'] },
      { id: 'jira', disabledTools: [] },
    ],
    prefs: { disabledTools: ['fetch_url', qualifiedMcpToolName('github', 'merge_pr')] },
  });
  const result = await migrateMcpDisabledTools({ ...s, qualify: qualifiedMcpToolName });
  assert.deepEqual(result.moved, [qualifiedMcpToolName('github', 'delete_repo'), qualifiedMcpToolName('github', 'merge_pr')]);
  assert.deepEqual(s.prefs().disabledTools, [
    'fetch_url',
    qualifiedMcpToolName('github', 'merge_pr'),
    qualifiedMcpToolName('github', 'delete_repo'),
  ]);
  assert.deepEqual(s.order, ['prefs', 'clear']);
  assert.ok(s.servers().every((server) => server.disabledTools.length === 0));
});

test('nothing deselected per server: nothing is written', async () => {
  const s = stores({ servers: [{ id: 'jira', disabledTools: [] }] });
  const result = await migrateMcpDisabledTools({ ...s, qualify: qualifiedMcpToolName });
  assert.deepEqual(result.moved, []);
  assert.deepEqual(s.order, []);
});

test('an unreadable server list is no reason to fail the start', async () => {
  const warnings = [];
  const result = await migrateMcpDisabledTools({
    mcpConfigStore: { readMcpServers: async () => { throw new Error('broken'); } },
    uiPrefsStore: { updateUIPrefs: async () => assert.fail('must not write') },
    qualify: qualifiedMcpToolName,
    log: { warn: (text) => warnings.push(text) },
  });
  assert.deepEqual(result.moved, []);
  assert.equal(warnings.length, 1);
});
