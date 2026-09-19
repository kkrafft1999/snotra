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

test('workspace tool adapter adds display lines and skill metadata via the port API', () => {
  const adapter = createWorkspaceToolAdapter(makeRegistry());

  const entry = adapter.buildTraceEntry('load_skill', { name: 'traffic' });
  assert.equal(entry.skill, 'traffic');
  assert.equal(
    adapter.formatDisplayLine(entry, 'start'),
    'Skill traffic wird geladen …'
  );
  assert.equal(
    adapter.formatDisplayLine(
      { tool: 'read_file_text', args: { relative_path: 'a.js' } },
      'done'
    ),
    'Datei a.js gelesen'
  );
});

// Issue #158: Bis dahin meldete nur write_file_text. edit_file und apply_patch
// liefen still durch — der Baum und die offene Vorschau blieben stehen.
test('edit_file meldet die geänderte Datei aus dem Ergebnis', async () => {
  const adapter = createWorkspaceToolAdapter(
    makeRegistry(() =>
      JSON.stringify({ relative_path: 'src/app.js', replacements: 1, bytes_written: 42 })
    )
  );

  const result = await adapter.execute(
    'edit_file',
    { relative_path: 'src/app.js', old_string: 'a', new_string: 'b' },
    { workspaceRoot: '/tmp/project', allowWrite: true }
  );

  assert.deepEqual(result.progressEvents, [
    {
      type: CHAT_PROGRESS_TYPES.WORKSPACE,
      event: WORKSPACE_PROGRESS_EVENTS.FILE_WRITTEN,
      relativePath: 'src/app.js',
    },
  ]);
});

test('apply_patch meldet jede Datei des Diffs einzeln', async () => {
  const adapter = createWorkspaceToolAdapter(
    makeRegistry(() =>
      JSON.stringify({
        mode: 'unified_diff',
        files_changed: 2,
        files: [{ relative_path: 'a.js' }, { relative_path: 'sub/b.js' }],
      })
    )
  );

  // Im Diff-Modus stehen die Pfade nur im Patch — das Ergebnis kennt sie.
  const result = await adapter.execute(
    'apply_patch',
    { patch: '--- a.js\n+++ a.js\n' },
    { workspaceRoot: '/tmp/project', allowWrite: true }
  );

  assert.deepEqual(
    result.progressEvents.map((event) => event.relativePath),
    ['a.js', 'sub/b.js']
  );
});

test('ein gescheitertes edit_file meldet nichts', async () => {
  const adapter = createWorkspaceToolAdapter(
    makeRegistry(() => JSON.stringify({ error: 'old_string wurde nicht gefunden.' }))
  );

  const result = await adapter.execute(
    'edit_file',
    { relative_path: 'src/app.js', old_string: 'a', new_string: 'b' },
    { workspaceRoot: '/tmp/project', allowWrite: true }
  );

  assert.deepEqual(result.progressEvents, []);
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
