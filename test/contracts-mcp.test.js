// Validierung der MCP-Serverkonfiguration und des Tool-Katalogs (Issue #106).
//
// Die Fehlertexte sind Teil des Vertrags: sie landen unveraendert im
// Settings-Dialog (#109) und im Import (#110), deshalb wird hier auch
// geprueft, dass ueberhaupt einer kommt und nicht nur `ok: false`.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MCP_CONNECTION_STATES,
  MCP_LIMITS,
  MCP_TRANSPORTS,
  createMcpConnectionStatus,
  isValidMcpServerId,
  normalizeMcpToolCatalog,
  normalizeMcpServerConfig,
  validateMcpServerConfig,
} = require('../src/shared/contracts/mcp');

const MINIMAL = { id: 'files', command: 'npx' };

test('eine minimale Konfiguration bekommt brauchbare Vorgaben', () => {
  const { ok, value, errors } = validateMcpServerConfig(MINIMAL);
  assert.equal(ok, true, errors.join(' | '));
  assert.deepEqual(value, {
    id: 'files',
    label: 'files',
    transport: MCP_TRANSPORTS.STDIO,
    command: 'npx',
    args: [],
    env: {},
    cwd: null,
    enabled: true,
    disabledTools: [],
  });
});

test('Kennung und Kommando sind Pflicht', () => {
  const ohneId = validateMcpServerConfig({ command: 'npx' });
  assert.equal(ohneId.ok, false);
  assert.equal(ohneId.value, null);
  assert.match(ohneId.errors.join(' '), /Kennung/);

  const ohneCommand = validateMcpServerConfig({ id: 'files' });
  assert.equal(ohneCommand.ok, false);
  assert.match(ohneCommand.errors.join(' '), /Kommando/);
});

test('ungültige Kennungen werden abgelehnt, gültige kleingeschrieben', () => {
  for (const id of ['-files', '.files', 'files/sub', 'files server', 'ä', 'x'.repeat(65)]) {
    assert.equal(validateMcpServerConfig({ id, command: 'npx' }).ok, false, `„${id}" darf nicht durchgehen`);
  }
  for (const id of ['files', 'my-server', 'my_server', 'srv.1', 'a1']) {
    assert.equal(isValidMcpServerId(id), true, `„${id}" sollte gültig sein`);
  }
  // Grossschreibung ist kein Fehler, sondern wird vereinheitlicht: die
  // Kennung taucht spaeter im Tool-Namensraum auf und soll dort eindeutig sein.
  assert.equal(validateMcpServerConfig({ id: 'Files', command: 'npx' }).value.id, 'files');
});

test('nur stdio wird angenommen', () => {
  assert.equal(validateMcpServerConfig({ ...MINIMAL, transport: 'stdio' }).ok, true);
  const http = validateMcpServerConfig({ ...MINIMAL, transport: 'http' });
  assert.equal(http.ok, false);
  assert.match(http.errors.join(' '), /stdio/);
});

test('Argumente werden gekappt, Nicht-Strings fallen still weg', () => {
  const value = normalizeMcpServerConfig({
    ...MINIMAL,
    args: ['-y', null, 42, ' mit Leerzeichen ', 'x'.repeat(MCP_LIMITS.ARG_MAX_CHARS + 10)],
  });
  assert.deepEqual(value.args.slice(0, 2), ['-y', ' mit Leerzeichen ']);
  assert.equal(value.args[2].length, MCP_LIMITS.ARG_MAX_CHARS);
});

test('zu viele Argumente werden gemeldet, nicht stillschweigend geschluckt', () => {
  const { ok, errors } = validateMcpServerConfig({
    ...MINIMAL,
    args: Array.from({ length: MCP_LIMITS.MAX_ARGS + 1 }, (_, i) => `a${i}`),
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), new RegExp(String(MCP_LIMITS.MAX_ARGS)));
});

test('Umgebungsvariablen: gültige Namen bleiben, ungültige werden gemeldet', () => {
  const { ok, errors } = validateMcpServerConfig({
    ...MINIMAL,
    env: { API_KEY: 'geheim', '2FALSCH': 'x', OK_2: 'y', LEER: 7 },
  });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /2FALSCH/);
  assert.match(errors.join(' '), /LEER/);

  const value = normalizeMcpServerConfig({ ...MINIMAL, env: { API_KEY: 'geheim', OK_2: 'y' } });
  assert.deepEqual(value.env, { API_KEY: 'geheim', OK_2: 'y' });
});

test('eine Fehlermeldung zu env verrät den Wert nicht', () => {
  const { errors } = validateMcpServerConfig({ ...MINIMAL, env: { '2FALSCH': 'sk-streng-geheim' } });
  assert.equal(errors.join(' ').includes('sk-streng-geheim'), false);
});

test('enabled: nur ein ausdrückliches false schaltet ab', () => {
  assert.equal(normalizeMcpServerConfig(MINIMAL).enabled, true);
  assert.equal(normalizeMcpServerConfig({ ...MINIMAL, enabled: false }).enabled, false);
  // Wackelige Wahrheitswerte aus einem Import gelten nicht als „an".
  assert.equal(normalizeMcpServerConfig({ ...MINIMAL, enabled: 'ja' }).enabled, false);
});

test('abgewählte Tools kommen sortiert und ohne Dopplungen', () => {
  const value = normalizeMcpServerConfig({ ...MINIMAL, disabledTools: ['b', 'a', 'b', '', 3, ' a '] });
  assert.deepEqual(value.disabledTools, ['a', 'b']);
});

test('nicht-objektartige Eingaben scheitern statt zu werfen', () => {
  for (const raw of [null, undefined, 'x', 42, []]) {
    const result = validateMcpServerConfig(raw);
    assert.equal(result.ok, false);
    assert.equal(result.value, null);
    assert.ok(result.errors.length > 0);
  }
});

test('Tool-Katalog: Einträge ohne Namen und Dopplungen fallen weg', () => {
  const tools = normalizeMcpToolCatalog(
    [
      { name: 'echo', description: 'Text zurück', inputSchema: { type: 'object' } },
      { name: 'echo', description: 'nochmal' },
      { description: 'ohne Namen' },
      null,
      { name: 'add' },
    ],
    'files',
  );
  assert.deepEqual(tools.map((t) => t.name), ['echo', 'add']);
  assert.equal(tools[0].serverId, 'files');
  // Fehlendes Schema wird ergaenzt, damit sich #107 auf das Feld verlassen kann.
  assert.deepEqual(tools[1].inputSchema, { type: 'object', properties: {} });
});

test('das inputSchema wird unverändert durchgereicht', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const [tool] = normalizeMcpToolCatalog([{ name: 'read', inputSchema: schema }], 'files');
  assert.deepEqual(tool.inputSchema, schema);
});

test('createMcpConnectionStatus füllt Lücken und prüft den Zustand', () => {
  assert.deepEqual(createMcpConnectionStatus(), {
    serverId: '',
    label: '',
    state: MCP_CONNECTION_STATES.IDLE,
    toolCount: 0,
    serverName: '',
    serverVersion: '',
    protocolVersion: '',
    error: '',
    stderr: '',
  });
  assert.equal(createMcpConnectionStatus({ state: 'irgendwas' }).state, MCP_CONNECTION_STATES.IDLE);
  assert.equal(createMcpConnectionStatus({ toolCount: -3 }).toolCount, 0);
  assert.equal(createMcpConnectionStatus({ state: MCP_CONNECTION_STATES.READY }).state, 'ready');
});
