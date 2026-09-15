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

// --- Namensraum und Risikoklassen (Issue #107) ---

const {
  MCP_BASE_RISK_CLASSES,
  MCP_QUALIFIED_NAME_MAX_CHARS,
  fitsMcpToolNameLimit,
  isMcpToolName,
  mcpRiskClassesFor,
  parseQualifiedMcpToolName,
  qualifiedMcpToolName,
} = require('../src/shared/contracts/mcp');
const { TOOL_RISK_CLASSES } = require('../src/shared/contracts/tool-permissions');

test('der Tool-Name trägt Server und Tool', () => {
  assert.equal(qualifiedMcpToolName('github', 'search_repos'), 'mcp__github__search_repos');
  assert.equal(isMcpToolName('mcp__github__search_repos'), true);
  assert.equal(isMcpToolName('read_file'), false);
  assert.deepEqual(parseQualifiedMcpToolName('mcp__github__search_repos'), {
    serverId: 'github',
    name: 'search_repos',
  });
});

test('ein doppelter Unterstrich im Tool-Namen bleibt beim Tool', () => {
  // Getrennt wird am *ersten* Trenner hinter dem Präfix — der Servername darf
  // keinen doppelten Unterstrich enthalten, der Tool-Name schon.
  assert.deepEqual(parseQualifiedMcpToolName('mcp__srv__a__b'), { serverId: 'srv', name: 'a__b' });
});

test('eine Serverkennung mit doppeltem Unterstrich wird abgelehnt', () => {
  const { ok, errors } = validateMcpServerConfig({ id: 'my__srv', command: 'npx' });
  assert.equal(ok, false);
  assert.match(errors.join(' '), /doppelten Unterstrich/);
});

test('kaputte oder fremde Namen ergeben null statt halber Treffer', () => {
  for (const name of ['read_file', 'mcp__', 'mcp__srv', 'mcp__srv__', 'mcp____tool', '', null]) {
    assert.equal(parseQualifiedMcpToolName(name), null, `„${name}" darf nicht zerlegbar sein`);
  }
});

test('der zusammengesetzte Name bleibt in der Grenze der Berechtigungsregeln', () => {
  assert.equal(fitsMcpToolNameLimit(qualifiedMcpToolName('github', 'search')), true);
  const zuLang = qualifiedMcpToolName('server', 'x'.repeat(MCP_QUALIFIED_NAME_MAX_CHARS));
  assert.equal(fitsMcpToolNameLimit(zuLang), false);
});

test('MCP-Tools sind immer execute und external', () => {
  assert.deepEqual([...MCP_BASE_RISK_CLASSES], [TOOL_RISK_CLASSES.EXECUTE, TOOL_RISK_CLASSES.EXTERNAL]);
  assert.deepEqual(mcpRiskClassesFor(undefined), [TOOL_RISK_CLASSES.EXECUTE, TOOL_RISK_CLASSES.EXTERNAL]);
});

test('destructiveHint verschärft, readOnlyHint schwächt nicht ab', () => {
  assert.deepEqual(mcpRiskClassesFor({ destructiveHint: true }), [
    TOOL_RISK_CLASSES.EXECUTE,
    TOOL_RISK_CLASSES.EXTERNAL,
    TOOL_RISK_CLASSES.DELETE,
  ]);
  // Der fremde Server darf sich nicht selbst besserstellen — das ist der Kern
  // der Entscheidung zu #107.
  assert.deepEqual(mcpRiskClassesFor({ readOnlyHint: true, idempotentHint: true }), [
    TOOL_RISK_CLASSES.EXECUTE,
    TOOL_RISK_CLASSES.EXTERNAL,
  ]);
  assert.deepEqual(mcpRiskClassesFor({ readOnlyHint: true, destructiveHint: true }), [
    TOOL_RISK_CLASSES.EXECUTE,
    TOOL_RISK_CLASSES.EXTERNAL,
    TOOL_RISK_CLASSES.DELETE,
  ]);
});

test('nur destructiveHint wird aus den Annotations übernommen', () => {
  const [tool] = normalizeMcpToolCatalog(
    [{ name: 'rm', annotations: { destructiveHint: true, readOnlyHint: true, openWorldHint: true } }],
    'srv',
  );
  assert.deepEqual(tool.annotations, { destructiveHint: true });
});

// --- env-Formen: Eingabe, Speicher, Anzeige (Issue #108) ---

const {
  maskStoredMcpEnv,
  normalizeMcpEnvInput,
  normalizeStoredMcpEnv,
  validateMcpServerInput,
} = require('../src/shared/contracts/mcp');

test('ohne ausdrückliches secret: false gilt ein Wert als geheim', () => {
  const { entries, errors } = normalizeMcpEnvInput({
    TOKEN: { value: 'x' },
    AUCH_GEHEIM: { secret: true, value: 'y' },
    OFFEN: { secret: false, value: 'z' },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(entries.map((e) => [e.key, e.secret]), [
    ['TOKEN', true],
    ['AUCH_GEHEIM', true],
    ['OFFEN', false],
  ]);
});

test('keep merkt sich „unverändert" ohne Wert', () => {
  const { entries } = normalizeMcpEnvInput({ TOKEN: { keep: true } });
  assert.deepEqual(entries, [{ key: 'TOKEN', secret: true, value: null, keep: true }]);
});

test('ein Eintrag ohne Wert und ohne keep ist ein Fehler', () => {
  const { entries, errors } = normalizeMcpEnvInput({ TOKEN: { secret: true } });
  assert.deepEqual(entries, []);
  assert.match(errors.join(' '), /TOKEN/);
});

test('ungültige Variablennamen werden gemeldet, ohne den Wert zu nennen', () => {
  const { errors } = normalizeMcpEnvInput({ '2FALSCH': { value: 'sk-streng-geheim' } });
  assert.match(errors.join(' '), /2FALSCH/);
  assert.equal(errors.join(' ').includes('sk-streng-geheim'), false);
});

test('die gespeicherte Form nimmt nur enc oder value', () => {
  assert.deepEqual(
    normalizeStoredMcpEnv({ A: { enc: 'base64' }, B: { value: 'klar' }, C: { unsinn: 1 }, '2X': { value: 'x' }, D: null }),
    { A: { enc: 'base64' }, B: { value: 'klar' } },
  );
});

test('die Anzeigeform zeigt Klartext, aber nie ein Geheimnis', () => {
  assert.deepEqual(maskStoredMcpEnv({ TOKEN: { enc: 'AAA' }, LANG: { value: 'de_DE' }, LEER: { value: '' } }), [
    { key: 'LANG', secret: false, hasValue: true, value: 'de_DE' },
    { key: 'LEER', secret: false, hasValue: false, value: '' },
    { key: 'TOKEN', secret: true, hasValue: true },
  ]);
});

test('validateMcpServerInput prüft Server und env zusammen', () => {
  const gut = validateMcpServerInput({ id: 'gh', command: 'npx', env: { T: { value: 'x' } } });
  assert.equal(gut.ok, true);
  assert.deepEqual(gut.value.env, {}, 'die Laufzeitform bleibt hier leer — env kommt getrennt');
  assert.deepEqual(gut.env.map((e) => e.key), ['T']);

  const schlecht = validateMcpServerInput({ id: 'gh', env: { '2X': { value: 'y' } } });
  assert.equal(schlecht.ok, false);
  assert.equal(schlecht.value, null);
  assert.match(schlecht.errors.join(' '), /Kommando/);
  assert.match(schlecht.errors.join(' '), /2X/);
});
