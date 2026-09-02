const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createToolRegistry,
  createWorkspaceToolRegistry,
} = require('../src/main/tools/workspace-tool-registry');

function definition(name, { requiresWrite = false } = {}) {
  return {
    name,
    description: `Beschreibung für ${name}`,
    promptDescription: `Prompt für ${name}`,
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
    },
    requiresWrite,
    handler: async (args, context) =>
      JSON.stringify({ name, value: args.value, workspaceRoot: context.workspaceRoot }),
  };
}

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

test('registry filters write tools and allowed tool names consistently', () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('other'),
    definition('write', { requiresWrite: true }),
  ]);

  assert.deepEqual(
    registry.getTools().map((tool) => tool.function.name),
    ['read', 'other']
  );
  assert.deepEqual(
    registry
      .getTools({ allowWrite: true, allowedNames: ['read', 'write'] })
      .map((tool) => tool.function.name),
    ['read', 'write']
  );

  const prompt = registry.buildSystemPrompt({
    allowWrite: true,
    allowedNames: ['read', 'write'],
  });
  assert.match(prompt, /read/);
  assert.match(prompt, /write/);
  assert.doesNotMatch(prompt, /other/);
  assert.match(prompt, /Schreib-Tools zurückhaltend/);
});

test('registry filters disabled tool names from tools, prompt and execution', async () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('other'),
    definition('write', { requiresWrite: true }),
  ]);

  assert.deepEqual(
    registry.getTools({ allowWrite: true, disabledNames: ['other', 'write'] }).map((tool) => tool.function.name),
    ['read']
  );
  const prompt = registry.buildSystemPrompt({ disabledNames: ['other'] });
  assert.match(prompt, /read/);
  assert.doesNotMatch(prompt, /other/);

  assert.match(
    JSON.parse(await registry.execute('other', {}, { disabledNames: ['other'] })).error,
    /deaktiviert/
  );
  assert.deepEqual(
    JSON.parse(await registry.execute('read', { value: 'x' }, { disabledNames: ['other'] })),
    { name: 'read', value: 'x' }
  );

  // Leere Liste = alles aktiv (Default).
  assert.deepEqual(
    registry.getTools({ disabledNames: [] }).map((tool) => tool.function.name),
    ['read', 'other']
  );
});

test('registry lists its full catalog independent of write and disabled filters', () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('write', { requiresWrite: true }),
  ]);

  assert.deepEqual(registry.listCatalog(), [
    { name: 'read', description: 'Beschreibung für read', requiresWrite: false },
    { name: 'write', description: 'Beschreibung für write', requiresWrite: true },
  ]);
});

test('registry executes handlers with request context', async () => {
  const registry = createToolRegistry([definition('read')]);

  const result = JSON.parse(
    await registry.execute(
      'read',
      { value: 'hello' },
      { workspaceRoot: '/tmp/project' }
    )
  );

  assert.deepEqual(result, {
    name: 'read',
    value: 'hello',
    workspaceRoot: '/tmp/project',
  });
});

test('registry rejects unavailable, unknown and duplicate tools', async () => {
  const registry = createToolRegistry([
    definition('read'),
    definition('write', { requiresWrite: true }),
  ]);

  assert.match(JSON.parse(await registry.execute('write', {})).error, /Schreibzugriff/);
  assert.match(
    JSON.parse(
      await registry.execute('read', {}, { allowedNames: ['write'] })
    ).error,
    /nicht freigeschaltet/
  );
  assert.match(JSON.parse(await registry.execute('missing', {})).error, /Unbekanntes Tool/);
  assert.throws(() => registry.register(definition('read')), /bereits registriert/);
});

test('workspace registry declares all built-in tools and filters write consistently', () => {
  const fsService = {
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
  };
  const registry = createWorkspaceToolRegistry({ fsService });

  const readOnlyNames = registry.getTools().map((tool) => tool.function.name);
  assert.deepEqual(readOnlyNames, [
    'list_directory',
    'read_file_text',
    'read_file_lines',
    'search_in_files',
    'find_files',
    'stat_path',
    'outline_file',
    'list_directory_tree',
    'debug_wait',
  ]);
  assert.doesNotMatch(registry.buildSystemPrompt(), /write_file_text/);

  const writableNames = registry
    .getTools({ allowWrite: true })
    .map((tool) => tool.function.name);
  assert.deepEqual(writableNames, [
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
  assert.match(registry.buildSystemPrompt({ allowWrite: true }), /write_file_text/);
});
