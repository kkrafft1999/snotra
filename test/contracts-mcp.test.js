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
  stripSchemaTitles,
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
    knownTools: [],
  });
});

/**
 * Seit Issue #293 tragen die Fehler einen Katalogschluessel und die Werte
 * seiner Platzhalter statt eines fertigen Satzes. Fuer die Zusicherungen, die
 * an einem *Wert* haengen — dass ein Variablenname genannt und ein Geheimnis
 * nicht genannt wird —, reicht diese flache Sicht.
 */
const flat = (errors) => errors
  .map((error) => `${error.key} ${JSON.stringify(error.params || {})}`)
  .join(' ');

test('Kennung und Kommando sind Pflicht', () => {
  const ohneId = validateMcpServerConfig({ command: 'npx' });
  assert.equal(ohneId.ok, false);
  assert.equal(ohneId.value, null);
  assert.deepEqual(ohneId.errors.map((e) => e.key), ['mcp.error.idMissing']);

  const ohneCommand = validateMcpServerConfig({ id: 'files' });
  assert.equal(ohneCommand.ok, false);
  assert.deepEqual(ohneCommand.errors.map((e) => e.key), ['mcp.error.commandMissing']);
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

test('stdio and http are the transports; anything else is refused (#341)', () => {
  assert.equal(validateMcpServerConfig({ ...MINIMAL, transport: 'stdio' }).ok, true);
  assert.equal(validateMcpServerConfig({ id: 'r', transport: 'http', url: 'https://mcp.example.com/mcp' }).ok, true);
  const sse = validateMcpServerConfig({ ...MINIMAL, transport: 'sse' });
  assert.equal(sse.ok, false);
  assert.deepEqual(sse.errors.map((e) => e.key), ['mcp.error.transportUnsupported']);
});

test('a remote server has an address and headers instead of a process (#341)', () => {
  const { ok, value } = validateMcpServerConfig({
    id: 'remote',
    transport: 'http',
    url: ' https://mcp.example.com/mcp#frag ',
    headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k' },
    command: 'ignored',
    env: { IGNORED: '1' },
  });
  assert.equal(ok, true);
  assert.equal(value.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(value.headers, { Authorization: 'Bearer abc', 'X-Api-Key': 'k' });
  // The process fields stay, empty, so every reader finds the same shape.
  assert.equal(value.command, '');
  assert.deepEqual(value.args, []);
  assert.deepEqual(value.env, {});
  assert.equal(value.cwd, null);
});

test('a missing transport is stdio, unless there is only an address (#341)', () => {
  assert.equal(validateMcpServerConfig(MINIMAL).value.transport, 'stdio');
  assert.equal(validateMcpServerConfig({ id: 'r', url: 'https://x.example/mcp' }).value.transport, 'http');
  assert.equal(validateMcpServerConfig({ id: 'r', url: 'https://x.example/mcp', command: 'npx' }).value.transport, 'stdio');
  // A local server has no address or headers at all.
  assert.equal('url' in validateMcpServerConfig(MINIMAL).value, false);
});

test('the address needs https, except on loopback, and carries no credentials (#341)', () => {
  const keyOf = (url) => validateMcpServerConfig({ id: 'r', transport: 'http', url }).errors.map((e) => e.key);
  assert.deepEqual(keyOf(''), ['mcp.error.urlMissing']);
  assert.deepEqual(keyOf('not a url'), ['mcp.error.urlInvalid']);
  assert.deepEqual(keyOf('ftp://x.example/mcp'), ['mcp.error.urlScheme']);
  assert.deepEqual(keyOf('http://mcp.example.com/mcp'), ['mcp.error.urlNeedsHttps']);
  assert.deepEqual(keyOf('http://192.168.1.10:8080/mcp'), ['mcp.error.urlNeedsHttps']);
  assert.deepEqual(keyOf('https://user:pw@x.example/mcp'), ['mcp.error.urlCredentials']);
  assert.deepEqual(keyOf(`https://x.example/${'a'.repeat(MCP_LIMITS.URL_MAX_CHARS)}`), ['mcp.error.urlTooLong']);
  for (const url of ['http://localhost:3000/mcp', 'http://127.0.0.1/mcp', 'http://[::1]:8000/mcp', 'http://app.localhost/mcp']) {
    assert.deepEqual(keyOf(url), [], url);
  }
  // Private addresses are fine over https: the user typed them, not the model.
  assert.deepEqual(keyOf('https://10.0.0.5/mcp'), []);
});

test('headers the transport sets itself, duplicates and line breaks are refused (#341)', () => {
  const keysOf = (headers) => validateMcpServerConfig({ id: 'r', transport: 'http', url: 'https://x.example/mcp', headers })
    .errors.map((e) => e.key);
  assert.deepEqual(keysOf({ 'Mcp-Session-Id': 'x' }), ['mcp.error.headerReserved']);
  assert.deepEqual(keysOf({ accept: 'x' }), ['mcp.error.headerReserved']);
  assert.deepEqual(keysOf({ 'X-Key': 'a', 'x-key': 'b' }), ['mcp.error.headerDuplicate']);
  assert.deepEqual(keysOf({ 'X-Key': 'a\r\nInjected: 1' }), ['mcp.error.headerValueInvalid']);
  assert.deepEqual(keysOf({ 'Bad Name': 'a' }), ['mcp.error.headerNameInvalid']);
  assert.deepEqual(keysOf({ 'X-Key': 42 }), ['mcp.error.headerValueNotString']);
  assert.deepEqual(keysOf([]), ['mcp.error.headersNotObject']);
  // An error names the header, never its value.
  const leak = validateMcpServerConfig({ id: 'r', transport: 'http', url: 'https://x.example/mcp', headers: { 'X-Key': 'geheim\n' } });
  assert.doesNotMatch(JSON.stringify(leak.errors), /geheim/);
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
  assert.deepEqual(errors, [{ key: 'mcp.error.tooManyArgs', params: { max: MCP_LIMITS.MAX_ARGS } }]);
});

test('Umgebungsvariablen: gültige Namen bleiben, ungültige werden gemeldet', () => {
  const { ok, errors } = validateMcpServerConfig({
    ...MINIMAL,
    env: { API_KEY: 'geheim', '2FALSCH': 'x', OK_2: 'y', LEER: 7 },
  });
  assert.equal(ok, false);
  assert.match(flat(errors), /2FALSCH/);
  assert.match(flat(errors), /LEER/);

  const value = normalizeMcpServerConfig({ ...MINIMAL, env: { API_KEY: 'geheim', OK_2: 'y' } });
  assert.deepEqual(value.env, { API_KEY: 'geheim', OK_2: 'y' });
});

test('eine Fehlermeldung zu env verrät den Wert nicht', () => {
  const { errors } = validateMcpServerConfig({ ...MINIMAL, env: { '2FALSCH': 'sk-streng-geheim' } });
  assert.equal(flat(errors).includes('sk-streng-geheim'), false);
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

test('das inputSchema wird bis auf die title-Annotationen durchgereicht', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
  const [tool] = normalizeMcpToolCatalog([{ name: 'read', inputSchema: schema }], 'files');
  assert.deepEqual(tool.inputSchema, schema);
});

// Issue #185: Pydantic-Server haengen an jede Eigenschaft ein `title`, das nur
// den Feldnamen wiederholt. Das kostet in jeder Runde Token und sagt dem
// Modell nichts.
test('redundante title-Annotationen fallen aus dem Schema', () => {
  const [tool] = normalizeMcpToolCatalog(
    [{
      name: 'post_my_time',
      inputSchema: {
        type: 'object',
        title: 'post_my_timeArguments',
        properties: {
          session_id: { type: 'string', title: 'Session Id', description: 'Die Sitzung' },
          minutes: { type: 'integer', title: 'Minutes' },
        },
        required: ['session_id'],
      },
    }],
    'heimat',
  );
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      session_id: { type: 'string', description: 'Die Sitzung' },
      minutes: { type: 'integer' },
    },
    required: ['session_id'],
  });
});

// Der eigentliche Fallstrick: vier Atlassian-Tools haben einen Parameter, der
// tatsaechlich `title` heisst — darunter `confluence_get_page`. Ein naiver
// Walk ueber alle Objekte wuerde ihn loeschen und das Tool brechen.
test('ein Parameter namens „title" ueberlebt', () => {
  const stripped = stripSchemaTitles({
    type: 'object',
    title: 'confluence_get_pageArguments',
    properties: {
      title: { type: 'string', title: 'Title', description: 'Titel der Seite' },
      space_key: { type: 'string', title: 'Space Key' },
    },
    required: ['title'],
  });
  assert.deepEqual(stripped, {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Titel der Seite' },
      space_key: { type: 'string' },
    },
    required: ['title'],
  });
});

test('auch verschachtelte Schemas werden erreicht — und ihre title-Parameter verschont', () => {
  const stripped = stripSchemaTitles({
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        title: 'Pages',
        items: { type: 'object', title: 'Page', properties: { title: { type: 'string', title: 'Title' } } },
      },
      mode: { anyOf: [{ type: 'string', title: 'Modus' }, { type: 'null' }], title: 'Mode', default: null },
      ref: { $ref: '#/$defs/Filter' },
    },
    $defs: { Filter: { type: 'object', title: 'Filter', properties: { title: { const: 'x', title: 'Title' } } } },
  });
  assert.deepEqual(stripped, {
    type: 'object',
    properties: {
      pages: {
        type: 'array',
        items: { type: 'object', properties: { title: { type: 'string' } } },
      },
      mode: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
      ref: { $ref: '#/$defs/Filter' },
    },
    $defs: { Filter: { type: 'object', properties: { title: { const: 'x' } } } },
  });
});

test('stripSchemaTitles fasst die Vorlage nicht an und lässt Daten in Ruhe', () => {
  const schema = {
    type: 'object',
    title: 'Args',
    properties: { kind: { type: 'string', title: 'Kind', enum: ['title', 'body'], default: 'title' } },
  };
  const before = JSON.stringify(schema);
  const stripped = stripSchemaTitles(schema);
  assert.equal(JSON.stringify(schema), before, 'das Eingabeobjekt gehört dem Aufrufer');
  // `enum` und `default` sind Daten, kein Schema — dort wird nichts gesucht.
  assert.deepEqual(stripped.properties.kind, { type: 'string', enum: ['title', 'body'], default: 'title' });
});

test('createMcpConnectionStatus füllt Lücken und prüft den Zustand', () => {
  assert.deepEqual(createMcpConnectionStatus(), {
    serverId: '',
    label: '',
    state: MCP_CONNECTION_STATES.IDLE,
    toolCount: 0,
    toolNames: [],
    serverName: '',
    serverVersion: '',
    protocolVersion: '',
    error: '',
    stderr: '',
  });
  assert.equal(createMcpConnectionStatus({ state: 'irgendwas' }).state, MCP_CONNECTION_STATES.IDLE);
  assert.equal(createMcpConnectionStatus({ toolCount: -3 }).toolCount, 0);
  assert.equal(createMcpConnectionStatus({ state: MCP_CONNECTION_STATES.READY }).state, 'ready');
  // Tool-Namen fuer den Settings-Dialog (#109); Nicht-Strings fallen weg.
  assert.deepEqual(createMcpConnectionStatus({ toolNames: ['echo', 2, 'add'] }).toolNames, ['echo', 'add']);
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
  assert.deepEqual(errors.map((e) => e.key), ['mcp.error.idDoubleUnderscore']);
});

test('an identifier ending in an underscore is refused — it would blur the namespace (CR-B16-07)', () => {
  // `mcp__a___x` would be server `a_` with tool `x` and server `a` with `_x`.
  assert.equal(isValidMcpServerId('a_'), false);
  const { ok, errors } = validateMcpServerConfig({ id: 'files_', command: 'npx' });
  assert.equal(ok, false);
  assert.deepEqual(errors.map((e) => e.key), ['mcp.error.idDoubleUnderscore']);
  // Inside the identifier a single underscore stays allowed, and so does a tool
  // name that starts with one.
  assert.equal(isValidMcpServerId('my_server'), true);
  assert.deepEqual(parseQualifiedMcpToolName('mcp__srv___private'), { serverId: 'srv', name: '_private' });
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
  maskStoredMcpHeaders,
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
  assert.deepEqual(errors, [{ key: 'mcp.error.envValueNotString', params: { name: 'TOKEN' } }]);
});

test('ungültige Variablennamen werden gemeldet, ohne den Wert zu nennen', () => {
  const { errors } = normalizeMcpEnvInput({ '2FALSCH': { value: 'sk-streng-geheim' } });
  assert.match(flat(errors), /2FALSCH/);
  assert.equal(flat(errors).includes('sk-streng-geheim'), false);
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
  assert.ok(schlecht.errors.some((e) => e.key === 'mcp.error.commandMissing'));
  assert.match(flat(schlecht.errors), /2X/);
});

test('validateMcpServerInput carries the create flag beside the stored value (CR-B14-03)', () => {
  assert.equal(validateMcpServerInput({ id: 'gh', command: 'npx', create: true }).create, true);
  assert.equal(validateMcpServerInput({ id: 'gh', command: 'npx', create: 'yes' }).create, false, 'only a real true');
  assert.equal(validateMcpServerInput({ id: 'gh', command: 'npx' }).create, false);
  assert.equal('create' in validateMcpServerInput({ id: 'gh', command: 'npx', create: true }).value, false,
    'not part of the configuration');
});

test('validateMcpServerInput reads headers for a remote server and env for a local one (#341)', () => {
  const remote = validateMcpServerInput({
    id: 'r',
    transport: 'http',
    url: 'https://x.example/mcp',
    headers: { Authorization: { value: 'Bearer abc' }, 'X-Team': { secret: false, value: 'core' }, 'X-Kept': { keep: true } },
    env: { IGNORED: { value: 'x' } },
  });
  assert.equal(remote.ok, true);
  assert.deepEqual(remote.env, []);
  assert.deepEqual(remote.headers, [
    { key: 'Authorization', secret: true, value: 'Bearer abc', keep: false },
    { key: 'X-Team', secret: false, value: 'core', keep: false },
    { key: 'X-Kept', secret: true, value: null, keep: true },
  ]);
  const local = validateMcpServerInput({ id: 'l', command: 'npx', headers: { Authorization: { value: 'x' } } });
  assert.equal(local.ok, true);
  assert.deepEqual(local.headers, []);
  const reserved = validateMcpServerInput({
    id: 'r', transport: 'http', url: 'https://x.example/mcp', headers: { Host: { value: 'x' } },
  });
  assert.deepEqual(reserved.errors.map((e) => e.key), ['mcp.error.headerReserved']);
});

test('stored headers are shown like env: plain text, never a secret (#341)', () => {
  assert.deepEqual(maskStoredMcpHeaders({ Authorization: { enc: 'xyz' }, 'X-Team': { value: 'core' }, 'bad name': { value: 'x' } }), [
    { key: 'Authorization', secret: true, hasValue: true },
    { key: 'X-Team', secret: false, hasValue: true, value: 'core' },
  ]);
});
