const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createToolRegistry,
  createWorkspaceToolRegistry,
} = require('../src/main/tools/workspace-tool-registry');
const { TOOL_RISK_CLASSES } = require('../src/shared/contracts/tool-permissions');

function definition(name, { riskClass = TOOL_RISK_CLASSES.READ, requiresWorkspace } = {}) {
  return {
    name,
    ...(requiresWorkspace === undefined ? {} : { requiresWorkspace }),
    description: `Beschreibung für ${name}`,
    promptDescription: `Prompt für ${name}`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
    riskClass,
    handler: async (args, context) =>
      JSON.stringify({ name, value: args.value, workspaceRoot: context.workspaceRoot }),
  };
}

const APPROVED = { approved: true };

test('registry exposes registered tools in provider format', () => {
  const registry = createToolRegistry([definition('read')]);

  assert.deepEqual(registry.getTools(), [
    {
      type: 'function',
      function: {
        name: 'read',
        description: 'Beschreibung für read',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
        },
      },
    },
  ]);
});

test('registry verlangt eine gültige riskClass und kennt keinen read-Default (Issue #66)', () => {
  assert.throws(
    () => createToolRegistry([{ ...definition('ohne'), riskClass: undefined }]),
    /riskClass/
  );
  assert.throws(
    () => createToolRegistry([{ ...definition('falsch'), riskClass: 'shell' }]),
    /riskClass/
  );
  const registry = createToolRegistry([definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE })]);
  assert.equal(registry.getDefinition('write').riskClass, TOOL_RISK_CLASSES.WRITE);
  assert.equal(registry.getDefinition('missing'), null);
});

test('registry zeigt Schreib-Tools unabhängig vom Modus und filtert nur nach Allowlist', () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('other'),
    definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
  ]);

  // Kein globaler Schreibschalter mehr: die Policy entscheidet pro Aufruf.
  assert.deepEqual(
    registry.getTools().map((tool) => tool.function.name),
    ['read', 'other', 'write']
  );
  assert.deepEqual(
    registry.getTools({ allowedNames: ['read', 'write'] }).map((tool) => tool.function.name),
    ['read', 'write']
  );

  const prompt = registry.buildSystemPrompt({ allowedNames: ['read', 'write'] });
  assert.match(prompt, /read/);
  assert.match(prompt, /write/);
  assert.doesNotMatch(prompt, /other/);
  assert.match(prompt, /Schreib-Tools zurückhaltend/);
  assert.doesNotMatch(registry.buildSystemPrompt({ allowedNames: ['read'] }), /Schreib-Tools zurückhaltend/);
});

test('registry filters disabled tool names from tools, prompt and execution', async () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('other'),
    definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
  ]);

  assert.deepEqual(
    registry.getTools({ disabledNames: ['other', 'write'] }).map((tool) => tool.function.name),
    ['read']
  );
  const prompt = registry.buildSystemPrompt({ disabledNames: ['other'] });
  assert.match(prompt, /read/);
  assert.doesNotMatch(prompt, /other/);

  assert.match(
    JSON.parse(await registry.execute('other', {}, { ...APPROVED, disabledNames: ['other'] })).error,
    /deaktiviert/
  );
  assert.deepEqual(
    JSON.parse(await registry.execute('read', { value: 'x' }, { ...APPROVED, disabledNames: ['other'] })),
    { name: 'read', value: 'x' }
  );

  // Leere Liste = alles aktiv (Default).
  assert.deepEqual(
    registry.getTools({ disabledNames: [] }).map((tool) => tool.function.name),
    ['read', 'other', 'write']
  );
});

// Issue #96: Die Tool-Liste haengt nicht mehr pauschal am geoeffneten Ordner.
test('registry zeigt ohne Workspace nur Tools ohne Ordnerbezug (#96)', () => {
  const registry = createToolRegistry([
    definition('read_file_text'),
    definition('web_search', { riskClass: TOOL_RISK_CLASSES.EXTERNAL, requiresWorkspace: false }),
  ]);

  const withWorkspace = registry.getTools().map((tool) => tool.function.name);
  assert.deepEqual(withWorkspace, ['read_file_text', 'web_search']);

  const withoutWorkspace = registry.getTools({ workspaceOpen: false }).map((tool) => tool.function.name);
  assert.deepEqual(withoutWorkspace, ['web_search'], 'Datei-Tools brauchen einen Ordner');
});

test('registry lässt den Pfad-Hinweis weg, wenn kein Datei-Tool dabei ist (#96)', () => {
  const registry = createToolRegistry([
    definition('read_file_text'),
    definition('web_search', { riskClass: TOOL_RISK_CLASSES.EXTERNAL, requiresWorkspace: false }),
  ]);

  const withWorkspace = registry.buildSystemPrompt();
  assert.match(withWorkspace, /read_file_text/);
  assert.match(withWorkspace, /relative Pfade zum Ordnerroot/);

  const withoutWorkspace = registry.buildSystemPrompt({ workspaceOpen: false });
  assert.match(withoutWorkspace, /web_search/);
  assert.doesNotMatch(withoutWorkspace, /read_file_text/);
  assert.doesNotMatch(withoutWorkspace, /relative Pfade zum Ordnerroot/);
});

test('registry liefert ohne Workspace und ohne ordnerfreie Tools einen leeren Prompt (#96)', () => {
  const registry = createToolRegistry([definition('read_file_text')]);

  assert.deepEqual(registry.getTools({ workspaceOpen: false }), []);
  assert.equal(registry.buildSystemPrompt({ workspaceOpen: false }), '');
});

test('registry lists its full catalog with risk classes independent of filters', () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
  ]);

  // Der Katalog traegt beide Texte: die Einstellungen zeigen den Kurztext und
  // klappen den Volltext auf Wunsch auf (Issue #98).
  assert.deepEqual(registry.listCatalog(), [
    {
      name: 'read',
      description: 'Beschreibung für read',
      shortDescription: 'Prompt für read',
      riskClass: 'read',
    },
    {
      name: 'write',
      description: 'Beschreibung für write',
      shortDescription: 'Prompt für write',
      riskClass: 'write',
    },
  ]);
});

test('catalog falls back to the full description when a tool has no short text', () => {
  const { promptDescription, ...withoutShort } = definition('read');
  const registry = createToolRegistry([withoutShort]);

  assert.deepEqual(registry.listCatalog(), [
    {
      name: 'read',
      description: 'Beschreibung für read',
      shortDescription: 'Beschreibung für read',
      riskClass: 'read',
    },
  ]);
});

test('internal tools stay available to the model but leave the settings catalog', () => {
  const registry = createToolRegistry([
    definition('read'),
    { ...definition('debug_wait'), internal: true },
  ]);

  assert.deepEqual(
    registry.listCatalog().map((entry) => entry.name),
    ['read']
  );
  // Dem Modell wird das Tool weiterhin angeboten — es dient den UI-Tests.
  assert.deepEqual(
    registry.getTools().map((tool) => tool.function.name),
    ['read', 'debug_wait']
  );
});

test('debug_wait is marked internal in the workspace registry', () => {
  const registry = createWorkspaceToolRegistry({ fsService: {} });

  assert.equal(
    registry.listCatalog().some((entry) => entry.name === 'debug_wait'),
    false
  );
  assert.equal(registry.getDefinition('debug_wait').internal, true);
});

test('registry executes handlers with request context', async () => {
  const registry = createToolRegistry([definition('read')]);

  const result = JSON.parse(
    await registry.execute(
      'read',
      { value: 'hello' },
      { ...APPROVED, workspaceRoot: '/tmp/project' }
    )
  );

  assert.deepEqual(result, {
    name: 'read',
    value: 'hello',
    workspaceRoot: '/tmp/project',
  });
});

test('registry führt ohne Policy-Freigabe keinen Handler aus (Issue #66)', async () => {
  let handlerCalls = 0;
  const registry = createToolRegistry([
    {
      ...definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
      handler: async () => {
        handlerCalls += 1;
        return JSON.stringify({ ok: true });
      },
    },
  ]);

  for (const context of [undefined, {}, { approved: false }, { approved: 'true' }]) {
    const out = JSON.parse(await registry.execute('write', { value: 'x' }, context));
    assert.equal(out.error, 'permission_denied');
    assert.equal(out.reason, 'not_approved');
  }
  assert.equal(handlerCalls, 0);

  const ok = JSON.parse(await registry.execute('write', { value: 'x' }, APPROVED));
  assert.deepEqual(ok, { ok: true });
  assert.equal(handlerCalls, 1);
});

test('registry rejects unavailable, unknown and duplicate tools', async () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('write', { riskClass: TOOL_RISK_CLASSES.WRITE }),
  ]);

  assert.match(
    JSON.parse(await registry.execute('read', {}, { ...APPROVED, allowedNames: ['write'] })).error,
    /nicht freigeschaltet/
  );
  assert.match(JSON.parse(await registry.execute('missing', {}, APPROVED)).error, /Unbekanntes Tool/);
  assert.throws(() => registry.register(definition('read')), /bereits registriert/);
});

function makeFsServiceStub() {
  return {
    runListDirectoryTool() {},
    runReadFileTextTool() {},
    runReadFileLinesTool() {},
    runWriteFileTextTool() {},
    runEditFileTool() {},
    runSearchInFilesTool() {},
    runFindFilesTool() {},
    runStatPathTool() {},
    runOutlineFileTool() {},
    runListDirectoryTreeTool() {},
    runApplyPatchTool() {},
    listApplyPatchTargets: (args) => (args.relative_path ? [args.relative_path] : []),
  };
}

test('workspace registry declares all built-in tools with their minimum risk classes', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });

  const names = registry.getTools().map((tool) => tool.function.name);
  assert.deepEqual(names, [
    'list_directory',
    'read_file_text',
    'read_file_lines',
    'search_in_files',
    'find_files',
    'stat_path',
    'outline_file',
    'list_directory_tree',
    'debug_wait',
    'write_file_text',
    'edit_file',
    'apply_patch',
  ]);
  assert.match(registry.buildSystemPrompt(), /write_file_text/);
  // web_search fehlt oben bewusst: ohne eingerichteten Suchdienst wird es dem
  // Modell nicht angeboten (Issue #63). Im Katalog der Einstellungen steht es.
  assert.equal(names.includes('web_search'), false);
  // run_python ebenso: ohne erlaubte und gefundene Python-Installation
  // erreicht es das Modell nicht (Issue #86).
  assert.equal(names.includes('run_python'), false);
  // fetch_url ebenso: ohne Abruf-Adapter gibt es nichts zu lesen (Issue #95).
  assert.equal(names.includes('fetch_url'), false);
  // shell_execute ebenso: ohne erlaubte und gefundene Shell erreicht es das
  // Modell nicht (Issue #102).
  assert.equal(names.includes('shell_execute'), false);

  // Konzept §2: acht Lesetools → read, drei Schreibtools → write,
  // web_search und fetch_url → external. debug_wait ist read, steht aber als
  // internes Test-Tool nicht im Katalog der Einstellungen (Issue #98).
  const classes = Object.fromEntries(registry.listCatalog().map((entry) => [entry.name, entry.riskClass]));
  const readTools = [
    'list_directory',
    'read_file_text',
    'read_file_lines',
    'search_in_files',
    'find_files',
    'stat_path',
    'outline_file',
    'list_directory_tree',
  ];
  for (const name of readTools) assert.equal(classes[name], 'read', name);
  for (const name of ['write_file_text', 'edit_file', 'apply_patch']) assert.equal(classes[name], 'write', name);
  assert.equal(classes.web_search, 'external');
  assert.equal(classes.fetch_url, 'external');
  assert.equal(classes.run_python, 'execute');
  assert.equal(classes.shell_execute, 'execute');
  assert.equal(registry.getDefinition('debug_wait').riskClass, 'read');
  assert.equal(Object.hasOwn(classes, 'debug_wait'), false);
  // 16 registrierte Tools minus debug_wait, das im Katalog fehlt (#98).
  assert.equal(Object.keys(classes).length, 15);
});

test('workspace registry bindet alle Datei-Tools an den Ordner, web_search nicht (#96)', () => {
  const registry = createWorkspaceToolRegistry({
    fsService: makeFsServiceStub(),
    webSearch: { isConfigured: () => true, search: async () => ({ ok: true, query: '', results: [] }) },
    urlFetch: { fetchUrl: async () => ({ ok: true, url: 'https://example.org', text: '', truncated: false }) },
  });

  const withoutWorkspace = registry.getTools({ workspaceOpen: false }).map((tool) => tool.function.name);
  assert.deepEqual(withoutWorkspace, ['web_search', 'fetch_url']);

  const withWorkspace = registry.getTools().map((tool) => tool.function.name);
  assert.ok(withWorkspace.includes('list_directory'));
  assert.ok(withWorkspace.includes('web_search'));
});

test('workspace registry beschreibt die Zielpfade jedes Tools für den Planer (Issue #66)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const targets = (name, args) => registry.getDefinition(name).targets(args);

  assert.deepEqual(targets('read_file_text', { relative_path: 'a.md' }), [
    { path: 'a.md', kind: 'file', access: 'read' },
  ]);
  assert.deepEqual(targets('stat_path', { relative_path: '.env' }), [
    { path: '.env', kind: 'any', access: 'read' },
  ]);
  assert.deepEqual(targets('list_directory', {}), [{ path: '', kind: 'tree', access: 'read' }]);
  assert.deepEqual(targets('search_in_files', { query: 'x', relative_path: 'src' }), [
    { path: 'src', kind: 'tree', access: 'read' },
  ]);
  assert.deepEqual(targets('debug_wait', {}), []);
  assert.deepEqual(targets('write_file_text', { relative_path: 'n.md', content: '' }), [
    { path: 'n.md', kind: 'file', access: 'write', overwrite: true },
  ]);
  assert.deepEqual(targets('edit_file', { relative_path: 'a.js' }), [
    { path: 'a.js', kind: 'file', access: 'write' },
  ]);
  assert.deepEqual(targets('apply_patch', { relative_path: 'a.js', edits: [] }), [
    { path: 'a.js', kind: 'file', access: 'write' },
  ]);
});
