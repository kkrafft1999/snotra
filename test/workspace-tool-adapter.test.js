const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { CHAT_PROGRESS_TYPES, WORKSPACE_PROGRESS_EVENTS } = require('../src/shared/contracts/enums');

function makeRegistry(executeImpl) {
  return {
    getTools() {
      return [];
    },
    buildSystemPrompt() {
      return '';
    },
    async execute(name, args, context) {
      return executeImpl(name, args, context);
    },
  };
}

test('workspace tool adapter emits a workspace fileWritten progress event after successful write', async () => {
  const adapter = createWorkspaceToolAdapter(
    makeRegistry(() => JSON.stringify({ ok: true, path: 'notes/todo.md' }))
  );

  const result = await adapter.execute(
    'write_file_text',
    { relative_path: 'notes/todo.md', content: 'hi' },
    { workspaceRoot: '/tmp/project', allowWrite: true }
  );

  assert.equal(result.output, JSON.stringify({ ok: true, path: 'notes/todo.md' }));
  assert.equal(result.progressEvents.length, 1);
  assert.deepEqual(result.progressEvents[0], {
    type: CHAT_PROGRESS_TYPES.WORKSPACE,
    event: WORKSPACE_PROGRESS_EVENTS.FILE_WRITTEN,
    relativePath: 'notes/todo.md',
  });
});

test('workspace tool adapter skips fileWritten when the tool output reports an error', async () => {
  const adapter = createWorkspaceToolAdapter(
    makeRegistry(() => JSON.stringify({ error: 'Schreibzugriff verweigert' }))
  );

  const result = await adapter.execute(
    'write_file_text',
    { relative_path: 'notes/todo.md', content: 'hi' },
    { workspaceRoot: '/tmp/project', allowWrite: true }
  );

  assert.deepEqual(result.progressEvents, []);
});

test('workspace tool adapter adds display lines and debug_wait metadata via the port API', () => {
  const adapter = createWorkspaceToolAdapter(makeRegistry());

  const entry = adapter.buildTraceEntry('debug_wait', { duration_seconds: 0.1 });
  assert.equal(entry.waitMs, 500);
  assert.equal(
    adapter.formatDisplayLine(entry, 'start'),
    'Warte 0,5 Sekunden …'
  );
  assert.equal(
    adapter.formatDisplayLine(
      { tool: 'read_file_text', args: { relative_path: 'a.js' } },
      'done'
    ),
    'Datei a.js gelesen'
  );
});

test('buildTraceEntry marks reads from a skill directory with the skill name', () => {
  const adapter = createWorkspaceToolAdapter(makeRegistry());
  const skillEntry = adapter.buildTraceEntry('read_file_text', {
    relative_path: 'skill:ds-design/references/farben.md',
  });
  assert.equal(skillEntry.skill, 'ds-design');
  // Workspace-Pfade bleiben ohne Skill-Bezug.
  assert.equal(adapter.buildTraceEntry('read_file_text', { relative_path: 'README.md' }).skill, undefined);
  assert.equal(adapter.buildTraceEntry('list_directory', {}).skill, undefined);
});
