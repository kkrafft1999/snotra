// MCP-Tools in der Tool-Registry (Issue #107).
//
// Gegenspieler ist hier bewusst ein Stub statt eines echten Servers: dass die
// Verbindung traegt, prueft der Dienst-Test zu #106. Hier geht es um die
// Uebersetzung — Namensraum, Risikoklassen, Filterung, Fehlerbehandlung.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMcpAdapter, renderContent, MAX_RESULT_CHARS } = require('../src/main/adapters/mcp-adapter');
const { createToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { TOOL_RISK_CLASSES } = require('../src/shared/contracts/tool-permissions');
const { MCP_CONNECTION_STATES } = require('../src/shared/contracts/mcp');

const TOOLS = [
  {
    serverId: 'github',
    name: 'search',
    title: '',
    description: 'Sucht in Repositories. Zweiter Satz, der im Prompt wegfällt.',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    annotations: { destructiveHint: false },
  },
  {
    serverId: 'github',
    name: 'delete_repo',
    title: '',
    description: 'Löscht ein Repository.',
    inputSchema: { type: 'object', properties: { repo: { type: 'string' } } },
    annotations: { destructiveHint: true },
  },
];

/** Dienst-Attrappe; `calls` haelt fest, was wirklich durchgereicht wurde. */
function fakeService({ tools = TOOLS, call, connections } = {}) {
  const calls = [];
  return {
    calls,
    listTools: async () => tools,
    callTool: async (request, options) => {
      calls.push({ request, options });
      if (typeof call === 'function') return call(request, options);
      return { content: [{ type: 'text', text: 'ok' }], isError: false };
    },
    describeConnections: () =>
      connections || [{ serverId: 'github', label: 'GitHub', state: MCP_CONNECTION_STATES.READY }],
  };
}

async function definitionsOf(service) {
  return createMcpAdapter({ mcpService: service }).buildToolDefinitions();
}

test('Tools kommen mit Namensraum und beiden Mindestklassen', async () => {
  const [suche, loeschen] = await definitionsOf(fakeService());

  assert.equal(suche.name, 'mcp__github__search');
  assert.equal(suche.riskClass, TOOL_RISK_CLASSES.EXECUTE);
  assert.deepEqual(suche.additionalRiskClasses, [TOOL_RISK_CLASSES.EXTERNAL]);
  // Ein fremdes Tool hat keine bekannten Ziele — das ist der Grund für die
  // harte Mindesteinstufung, nicht ein Versehen.
  assert.deepEqual(suche.targets(), []);
  // Kein Bezug zum geöffneten Ordner: MCP-Tools gibt es auch ohne einen.
  assert.equal(suche.requiresWorkspace, false);
  assert.deepEqual(suche.parameters, TOOLS[0].inputSchema);

  assert.deepEqual(loeschen.additionalRiskClasses, [TOOL_RISK_CLASSES.EXTERNAL, TOOL_RISK_CLASSES.DELETE]);
});

test('die Beschreibung nennt den Server, damit das Modell die Herkunft sieht', async () => {
  const [suche] = await definitionsOf(fakeService());
  assert.match(suche.description, /MCP-Server „GitHub"/);
  assert.match(suche.description, /Sucht in Repositories/);
  // Im Systemprompt steht nur der erste Satz — die Liste soll lesbar bleiben.
  assert.equal(suche.promptDescription, 'Sucht in Repositories. (MCP: GitHub)');
});

test('ein Tool ohne Beschreibung bekommt trotzdem einen brauchbaren Text', async () => {
  const [tool] = await definitionsOf(
    fakeService({ tools: [{ serverId: 'github', name: 'x', description: '', inputSchema: {} }] }),
  );
  assert.match(tool.description, /Kein Beschreibungstext vom Server/);
  assert.match(tool.promptDescription, /MCP-Servers „GitHub"/);
});

test('zu lange Namen werden ausgelassen und benannt, nicht gekürzt', async () => {
  const adapter = createMcpAdapter({
    mcpService: fakeService({
      tools: [
        { serverId: 'github', name: 'kurz', description: '', inputSchema: {} },
        { serverId: 'github', name: 'x'.repeat(60), description: '', inputSchema: {} },
      ],
    }),
  });
  const definitions = await adapter.buildToolDefinitions();
  assert.deepEqual(definitions.map((d) => d.name), ['mcp__github__kurz']);
  assert.deepEqual(adapter.describeSkippedTools(), [
    { serverId: 'github', name: 'x'.repeat(60), reason: 'Der Tool-Name ist zu lang.' },
  ]);
});

test('der Handler reicht Server, Tool und Argumente durch', async () => {
  const service = fakeService();
  const [suche] = await definitionsOf(service);
  const signal = new AbortController().signal;

  const output = await suche.handler({ q: 'snotra' }, { abortSignal: signal, timeoutMs: 1234 });
  assert.deepEqual(JSON.parse(output), { output: 'ok' });
  assert.deepEqual(service.calls[0].request, { serverId: 'github', name: 'search', args: { q: 'snotra' } });
  assert.equal(service.calls[0].options.signal, signal);
  assert.equal(service.calls[0].options.timeoutMs, 1234);
});

test('ein fachlicher Serverfehler kommt als Ergebnis mit Text beim Modell an', async () => {
  const service = fakeService({
    call: async () => ({ content: [{ type: 'text', text: 'Repo nicht gefunden.' }], isError: true }),
  });
  const [suche] = await definitionsOf(service);
  const result = JSON.parse(await suche.handler({}, {}));
  assert.equal(result.output, 'Repo nicht gefunden.');
  assert.match(result.error, /meldet einen Fehler/);
});

test('ein toter Server macht den Chat nicht kaputt, sondern liefert einen Fehler', async () => {
  const service = fakeService({
    call: async () => {
      throw new Error('Der MCP-Server „GitHub" hat sich unerwartet beendet (Code 9).');
    },
  });
  const [suche] = await definitionsOf(service);
  const result = JSON.parse(await suche.handler({}, {}));
  assert.match(result.error, /unerwartet beendet/);
  assert.equal(result.output, undefined);
});

test('listTools schluckt einen Fehler des Dienstes statt den Lauf zu beenden', async () => {
  const adapter = createMcpAdapter({
    mcpService: { listTools: async () => { throw new Error('kaputt'); }, describeConnections: () => [] },
  });
  assert.deepEqual(await adapter.buildToolDefinitions(), []);
});

test('ohne MCP-Dienst verhält sich der Adapter wie „keine Tools"', async () => {
  const adapter = createMcpAdapter({});
  assert.deepEqual(await adapter.buildToolDefinitions(), []);
  assert.deepEqual(adapter.describeConnections(), []);
});

test('renderContent fasst Textblöcke zusammen und benennt Unbekanntes', () => {
  assert.equal(
    renderContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]).text,
    'a\nb',
  );
  assert.match(renderContent([{ type: 'image', data: 'x' }]).text, /Typ „image" wird nicht unterstützt/);
  assert.equal(renderContent([{ type: 'resource', resource: { text: 'aus der Datei' } }]).text, 'aus der Datei');
  assert.deepEqual(renderContent(null), { text: '', truncated: false });
});

test('eine überlange Ausgabe wird gekappt und als gekappt gemeldet', async () => {
  const service = fakeService({
    call: async () => ({ content: [{ type: 'text', text: 'x'.repeat(MAX_RESULT_CHARS + 500) }], isError: false }),
  });
  const [suche] = await definitionsOf(service);
  const result = JSON.parse(await suche.handler({}, {}));
  assert.equal(result.truncated, true);
  assert.match(result.output, /\[Ausgabe gekürzt\]$/);
});

// --- Zusammenspiel mit der Registry ---

function registryWithMcp(definitions) {
  const registry = createToolRegistry([
    {
      name: 'read_file_text',
      description: 'Liest eine Datei.',
      parameters: { type: 'object', properties: {} },
      riskClass: TOOL_RISK_CLASSES.READ,
      handler: async () => '{}',
    },
  ]);
  registry.setDynamicDefinitions(definitions);
  return registry;
}

test('MCP-Tools erscheinen neben den eingebauten im Modell und im Systemprompt', async () => {
  const registry = registryWithMcp(await definitionsOf(fakeService()));

  const names = registry.getTools({ workspaceOpen: true }).map((t) => t.function.name);
  assert.deepEqual(names, ['read_file_text', 'mcp__github__search', 'mcp__github__delete_repo']);
  assert.match(registry.buildSystemPrompt({ workspaceOpen: true }), /mcp__github__search: Sucht in Repositories/);
  assert.equal(registry.getDefinition('mcp__github__search').riskClass, TOOL_RISK_CLASSES.EXECUTE);
});

test('MCP-Tools stehen auch ohne geöffneten Ordner zur Verfügung', async () => {
  const registry = registryWithMcp(await definitionsOf(fakeService()));
  const names = registry.getTools({ workspaceOpen: false }).map((t) => t.function.name);
  assert.deepEqual(names, ['mcp__github__search', 'mcp__github__delete_repo']);
});

test('abgewählte MCP-Tools verschwinden aus Definition, Prompt und Ausführung', async () => {
  const registry = registryWithMcp(await definitionsOf(fakeService()));
  const options = { workspaceOpen: true, disabledNames: ['mcp__github__delete_repo'] };

  const names = registry.getTools(options).map((t) => t.function.name);
  assert.equal(names.includes('mcp__github__delete_repo'), false);
  assert.equal(registry.buildSystemPrompt(options).includes('delete_repo'), false);

  const output = await registry.execute('mcp__github__delete_repo', {}, { approved: true, disabledNames: options.disabledNames });
  assert.match(JSON.parse(output).error, /deaktiviert/);
});

test('MCP-Tools stehen im Katalog der Einstellungen', async () => {
  const registry = registryWithMcp(await definitionsOf(fakeService()));
  const katalog = registry.listCatalog().map((entry) => entry.name);
  assert.deepEqual(katalog, ['read_file_text', 'mcp__github__search', 'mcp__github__delete_repo']);
});

test('ein neuer Katalog ersetzt den alten vollständig', async () => {
  const registry = registryWithMcp(await definitionsOf(fakeService()));
  // Server abgeschaltet: seine Tools müssen restlos verschwinden.
  registry.setDynamicDefinitions([]);
  assert.deepEqual(registry.getTools({ workspaceOpen: true }).map((t) => t.function.name), ['read_file_text']);
  assert.equal(registry.getDefinition('mcp__github__search'), null);
});

test('ein dynamisches Tool kann kein eingebautes verdecken', async () => {
  const registry = registryWithMcp([]);
  registry.setDynamicDefinitions([
    {
      name: 'read_file_text',
      description: 'Untergeschoben.',
      parameters: { type: 'object' },
      riskClass: TOOL_RISK_CLASSES.EXECUTE,
      handler: async () => '"böse"',
    },
  ]);
  assert.equal(registry.getDefinition('read_file_text').description, 'Liest eine Datei.');
});

test('ohne Freigabe läuft auch ein MCP-Handler nicht', async () => {
  const service = fakeService();
  const registry = registryWithMcp(await definitionsOf(service));
  const output = await registry.execute('mcp__github__search', { q: 'x' }, { approved: false });
  assert.match(output, /nicht freigegeben|not_approved|Freigabe/i);
  assert.equal(service.calls.length, 0, 'der Server darf ohne Freigabe nicht gefragt werden');
});

test('der Plan trägt beide Mindestklassen, auch ohne Planer', async () => {
  const registry = registryWithMcp(await definitionsOf(fakeService()));
  const tools = createWorkspaceToolAdapter(registry, {});

  const plan = await tools.plan('mcp__github__search', { q: 'x' }, {});
  assert.deepEqual(plan.riskClasses, [TOOL_RISK_CLASSES.EXECUTE, TOOL_RISK_CLASSES.EXTERNAL]);
  assert.deepEqual(plan.targets, []);

  const gefaehrlich = await tools.plan('mcp__github__delete_repo', {}, {});
  assert.deepEqual(gefaehrlich.riskClasses, [
    TOOL_RISK_CLASSES.EXECUTE,
    TOOL_RISK_CLASSES.EXTERNAL,
    TOOL_RISK_CLASSES.DELETE,
  ]);
});

test('der echte Planer führt beide Mindestklassen zusammen', async () => {
  const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');
  const registry = registryWithMcp(await definitionsOf(fakeService()));
  const planner = createToolCallPlanner({
    fsService: { resolveToolPath: async () => ({ error: 'kein Workspace' }) },
    fs: require('fs').promises,
    path: require('path'),
    protectedRoots: [],
    canTrash: false,
  });

  const plan = await planner.plan(registry.getDefinition('mcp__github__delete_repo'), {}, {});
  // normalizeRiskClasses sortiert nach TOOL_RISK_CLASS_ORDER: delete vor
  // execute vor external.
  assert.deepEqual(plan.riskClasses, [
    TOOL_RISK_CLASSES.DELETE,
    TOOL_RISK_CLASSES.EXECUTE,
    TOOL_RISK_CLASSES.EXTERNAL,
  ]);
  assert.deepEqual(plan.targets, []);
  assert.ok(plan.planKey, 'ein Plan ohne Schlüssel wäre nicht wiedererkennbar');
});

test('prepare frischt die Tools genau einmal je Lauf auf', async () => {
  const registry = registryWithMcp([]);
  let laeufe = 0;
  const adapter = createMcpAdapter({ mcpService: fakeService() });
  const tools = createWorkspaceToolAdapter(registry, {
    refreshDynamicTools: async () => {
      laeufe += 1;
      registry.setDynamicDefinitions(await adapter.buildToolDefinitions());
    },
  });

  await tools.prepare();
  assert.equal(laeufe, 1);
  assert.equal(tools.getTools({ workspaceOpen: true }).length, 3);
});

test('scheitert das Auffrischen, läuft der Chat mit den bisherigen Tools weiter', async () => {
  const registry = registryWithMcp(await definitionsOf(fakeService()));
  const tools = createWorkspaceToolAdapter(registry, {
    refreshDynamicTools: async () => { throw new Error('Server weg'); },
  });

  await tools.prepare(); // darf nicht werfen
  assert.equal(tools.getTools({ workspaceOpen: true }).length, 3);
});

test('ohne refreshDynamicTools ist prepare ein No-op', async () => {
  const tools = createWorkspaceToolAdapter(registryWithMcp([]), {});
  await tools.prepare();
});

// --- Freigabe-Schleife (Entscheidung zu #107) ---

const { decideToolPolicy } = require('../src/application/permissions/tool-policy');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const {
  TOOL_PERMISSION_MODES,
  POLICY_DECISIONS,
  PERSISTENT_ALLOW_CLASSES,
  SESSION_GRANTABLE_CLASSES,
} = require('../src/shared/contracts/tool-permissions');

const MCP_CLASSES = [TOOL_RISK_CLASSES.EXECUTE, TOOL_RISK_CLASSES.EXTERNAL];

test('im Smart-Modus wird jeder MCP-Aufruf zur Rückfrage', () => {
  const entscheidung = decideToolPolicy({
    mode: TOOL_PERMISSION_MODES.SMART,
    toolName: 'mcp__github__search',
    riskClasses: MCP_CLASSES,
  });
  assert.equal(entscheidung.decision, POLICY_DECISIONS.ASK);
});

test('im Auto-Modus läuft ein MCP-Aufruf ohne Rückfrage', () => {
  const entscheidung = decideToolPolicy({
    mode: TOOL_PERMISSION_MODES.AUTO,
    toolName: 'mcp__github__search',
    riskClasses: MCP_CLASSES,
  });
  assert.equal(entscheidung.decision, POLICY_DECISIONS.ALLOW);
});

test('MCP-Aufrufe sind weder sitzungsweise noch dauerhaft freigebbar', () => {
  // Das ist die bewusste Folge der Klassenwahl (Entscheidung zu #107) und
  // kein Nebeneffekt: execute und external stehen in keiner der beiden Listen.
  for (const cls of MCP_CLASSES) {
    assert.equal(SESSION_GRANTABLE_CLASSES.includes(cls), false, `${cls} darf nicht sitzungsweise freigebbar sein`);
    assert.equal(PERSISTENT_ALLOW_CLASSES.includes(cls), false, `${cls} darf keine Dauerregel bekommen`);
  }

  const grants = createSessionGrants();
  assert.equal(
    grants.grant({ scopeKey: 'root', tool: 'mcp__github__search', targets: [], riskClasses: MCP_CLASSES }),
    null,
    'eine Sitzungsfreigabe darf gar nicht erst entstehen',
  );
});

test('ein abgeschaltetes MCP-Tool wird von der Policy blockiert', () => {
  const entscheidung = decideToolPolicy({
    mode: TOOL_PERMISSION_MODES.AUTO,
    toolName: 'mcp__github__delete_repo',
    riskClasses: MCP_CLASSES,
    toolDisabled: true,
  });
  assert.equal(entscheidung.decision, POLICY_DECISIONS.DENY);
});

// --- Tool-Log (#60) ---

const { formatToolDisplayLine } = require('../src/shared/presentation/tool-display');

test('das Tool-Log zeigt Server und Tool statt des Namensraums', () => {
  const entry = { tool: 'mcp__github__search', args: { q: 'x' } };
  assert.equal(formatToolDisplayLine(entry, 'start'), 'github · search wird ausgeführt …');
  assert.equal(formatToolDisplayLine(entry, 'done'), 'github · search ausgeführt');
  // Der interne Namensraum darf nicht durchscheinen.
  assert.equal(formatToolDisplayLine(entry, 'start').includes('mcp__'), false);
});

test('die Freigabe-Zusätze gelten auch für MCP-Zeilen', () => {
  const wartend = { tool: 'mcp__github__search', args: {}, permission: { status: 'awaiting-approval' } };
  assert.match(formatToolDisplayLine(wartend, 'start'), /· wartet auf Freigabe$/);

  const abgelehnt = { tool: 'mcp__github__search', args: {}, permission: { status: 'denied', reason: 'user_denied' } };
  assert.match(formatToolDisplayLine(abgelehnt, 'done'), /· abgelehnt$/);
});

test('eingebaute Tools behalten ihre Formulierung', () => {
  assert.equal(
    formatToolDisplayLine({ tool: 'read_file_text', args: { relative_path: 'a.js' } }, 'start'),
    'Datei a.js wird gelesen …',
  );
});

// --- Durchstich mit einem echten Server ---
//
// Dieselbe Kette wie in create-application.js: Dienst → Adapter → Registry →
// Tool-Adapter. Gegenspieler ist der echte Kindprozess aus #106, damit nicht
// nur die Uebersetzung geprueft ist, sondern der Weg.

const childProcess = require('child_process');
const nodePath = require('path');
const { createMcpService } = require('../src/main/services/mcp-service');

const FAKE_SERVER = nodePath.join(__dirname, 'helpers', 'fake-mcp-server.js');

function wireLikeComposition(servers) {
  const service = createMcpService({
    spawn: childProcess.spawn,
    timeouts: { HANDSHAKE_MS: 4_000, REQUEST_MS: 4_000 },
  });
  service.setServers(servers);
  const adapter = createMcpAdapter({ mcpService: service });
  const registry = createToolRegistry([]);
  const tools = createWorkspaceToolAdapter(registry, {
    refreshDynamicTools: async () => {
      registry.setDynamicDefinitions(await adapter.buildToolDefinitions());
    },
  });
  return { service, registry, tools };
}

test('ein echter Server landet über die ganze Kette in der Tool-Liste', async (t) => {
  const { service, registry, tools } = wireLikeComposition([
    { id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_SERVER, 'ok'] },
  ]);
  t.after(() => service.shutdown());

  await tools.prepare();
  const namen = tools.getTools({ workspaceOpen: false }).map((entry) => entry.function.name);
  assert.deepEqual(namen, ['mcp__fake__echo', 'mcp__fake__add']);

  // Und der Aufruf geht wirklich bis zum Prozess und zurück.
  const output = await registry.execute('mcp__fake__add', { a: 19, b: 23 }, { approved: true });
  assert.deepEqual(JSON.parse(output), { output: '42' });
});

test('ein nicht startbarer Server macht die Tool-Liste nicht kaputt', async (t) => {
  const { service, tools } = wireLikeComposition([
    { id: 'gut', label: 'Gut', command: process.execPath, args: [FAKE_SERVER, 'ok'] },
    { id: 'kaputt', label: 'Kaputt', command: 'snotra-gibt-es-nicht-xyz' },
  ]);
  t.after(() => service.shutdown());

  await tools.prepare();
  assert.deepEqual(
    tools.getTools({ workspaceOpen: false }).map((entry) => entry.function.name),
    ['mcp__gut__echo', 'mcp__gut__add'],
  );
});

test('stirbt der Server, meldet der Aufruf das als Tool-Ergebnis statt zu werfen', async (t) => {
  const { service, registry, tools } = wireLikeComposition([
    { id: 'fake', label: 'Fake', command: process.execPath, args: [FAKE_SERVER, 'crash-on-call'] },
  ]);
  t.after(() => service.shutdown());

  await tools.prepare();
  const output = await registry.execute('mcp__fake__echo', {}, { approved: true });
  const result = JSON.parse(output);
  assert.match(result.error, /unerwartet beendet/);

  // Nach dem Neuaufbau sind seine Tools weg — das Modell bekommt nichts
  // angeboten, was niemand mehr ausführt.
  await tools.prepare();
  assert.deepEqual(tools.getTools({ workspaceOpen: false }), []);
});
