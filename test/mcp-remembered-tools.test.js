// #464: the MCP tools Settings › Security shows before a server is connected,
// from the names each server reported last time.

const test = require('node:test');
const assert = require('node:assert/strict');
const { describeRememberedMcpTools } = require('../src/main/services/mcp-remembered-tools');

const SERVERS = [
  { id: 'github', label: 'GitHub', enabled: true, knownTools: ['issues', 'pulls'] },
  { id: 'jira', label: 'Jira', enabled: false, knownTools: ['search'] },
  { id: 'fresh', label: 'Fresh', enabled: true, knownTools: [] },
];

test('every remembered tool becomes an entry, named and classed like a live MCP tool', () => {
  const tools = describeRememberedMcpTools({ servers: SERVERS, present: [], locale: 'en' });
  assert.deepEqual(tools.map((tool) => tool.name), ['mcp__github__issues', 'mcp__github__pulls', 'mcp__jira__search']);
  const [issues] = tools;
  assert.deepEqual(issues.riskClasses, ['execute', 'external']);
  assert.equal(issues.mcpServer, 'GitHub');
  assert.equal(issues.mcpServerId, 'github');
  assert.equal(issues.available, true);
  assert.equal(issues.shortDescription, 'Known from the last connection to “GitHub”.');
});

test('a switched-off server offers nothing, so its tools are not available', () => {
  const [search] = describeRememberedMcpTools({ servers: SERVERS, present: [], locale: 'en' })
    .filter((tool) => tool.mcpServerId === 'jira');
  assert.equal(search.available, false);
});

test('a tool the registry already has keeps its real definition', () => {
  const present = [{ name: 'mcp__github__issues' }];
  const tools = describeRememberedMcpTools({ servers: SERVERS, present, locale: 'en' });
  assert.deepEqual(tools.map((tool) => tool.name), ['mcp__github__pulls', 'mcp__jira__search']);
});

test('a name over the limit is left out, as the registry leaves it out', () => {
  const servers = [{ id: 'github', label: 'GitHub', enabled: true, knownTools: ['x'.repeat(80), 'ok'] }];
  const tools = describeRememberedMcpTools({ servers, present: [], locale: 'en' });
  assert.deepEqual(tools.map((tool) => tool.name), ['mcp__github__ok']);
});

test('German, and broken input gives nothing instead of an error', () => {
  const [issues] = describeRememberedMcpTools({ servers: SERVERS, present: [], locale: 'de' });
  assert.equal(issues.shortDescription, 'Bekannt aus der letzten Verbindung mit „GitHub“.');
  assert.deepEqual(describeRememberedMcpTools({ servers: null }), []);
  assert.deepEqual(describeRememberedMcpTools({ servers: [null, { id: '' }, { id: 'a', knownTools: [42, ''] }] }), []);
});
