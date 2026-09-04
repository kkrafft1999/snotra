const test = require('node:test');
const assert = require('node:assert/strict');
const {
  truncateToolLabel,
  summarizeToolCall,
  formatToolDisplayLine,
} = require('../src/shared/presentation/tool-display');

test('summarizeToolCall formats workspace tools with start and done labels', () => {
  assert.equal(
    summarizeToolCall('list_directory', { relative_path: 'src/main' }, 'start'),
    'Ordner src/main wird durchsucht …'
  );
  assert.equal(
    summarizeToolCall('list_directory', { relative_path: 'src/main' }, 'done'),
    'Ordner src/main durchsucht'
  );
  assert.equal(summarizeToolCall('list_directory', { relative_path: '.' }, 'start'), 'Projektordner wird durchsucht …');
  assert.equal(summarizeToolCall('list_directory', { relative_path: '' }, 'done'), 'Projektordner durchsucht');
  assert.equal(
    summarizeToolCall('read_file_text', { relative_path: 'README.md' }, 'start'),
    'Datei README.md wird gelesen …'
  );
  assert.equal(
    summarizeToolCall('read_file_text', { relative_path: 'README.md' }, 'done'),
    'Datei README.md gelesen'
  );
  assert.equal(summarizeToolCall('read_file_text', {}, 'start'), 'Datei wird gelesen …');
  assert.equal(
    summarizeToolCall('read_file_lines', { relative_path: 'src/app.js', start_line: 400, end_line: 450 }, 'start'),
    'Datei src/app.js (Zeilen 400–450) wird gelesen …'
  );
  assert.equal(
    summarizeToolCall('read_file_lines', { relative_path: 'src/app.js', start_line: 400, end_line: 450 }, 'done'),
    'Datei src/app.js (Zeilen 400–450) gelesen'
  );
  assert.equal(
    summarizeToolCall('read_file_lines', { relative_path: 'src/app.js', start_line: 400 }, 'done'),
    'Datei src/app.js (ab Zeile 400) gelesen'
  );
  assert.equal(summarizeToolCall('read_file_lines', {}, 'start'), 'Datei wird gelesen …');
  assert.equal(
    summarizeToolCall('write_file_text', { relative_path: 'notes/todo.md' }, 'start'),
    'Datei notes/todo.md wird geschrieben …'
  );
  assert.equal(
    summarizeToolCall('write_file_text', { relative_path: 'notes/todo.md' }, 'done'),
    'Datei notes/todo.md geschrieben'
  );
  assert.equal(summarizeToolCall('write_file_text', {}, 'start'), 'Datei wird geschrieben …');
  assert.equal(summarizeToolCall('write_file_text', {}, 'done'), 'Datei geschrieben');
  assert.equal(
    summarizeToolCall('edit_file', { relative_path: 'src/app.js' }, 'start'),
    'Datei src/app.js wird geändert …'
  );
  assert.equal(
    summarizeToolCall('edit_file', { relative_path: 'src/app.js' }, 'done'),
    'Datei src/app.js geändert'
  );
  assert.equal(summarizeToolCall('edit_file', {}, 'start'), 'Datei wird geändert …');
  assert.equal(summarizeToolCall('edit_file', {}, 'done'), 'Datei geändert');
  assert.equal(
    summarizeToolCall('apply_patch', { relative_path: 'src/app.js' }, 'start'),
    'Datei src/app.js wird gepatcht …'
  );
  assert.equal(
    summarizeToolCall('apply_patch', { relative_path: 'src/app.js' }, 'done'),
    'Datei src/app.js gepatcht'
  );
  // Im patch-Modus stehen die Pfade im Diff, nicht in den Argumenten.
  assert.equal(summarizeToolCall('apply_patch', { patch: '--- a\n' }, 'start'), 'Patch wird angewendet …');
  assert.equal(summarizeToolCall('apply_patch', {}, 'done'), 'Patch angewendet');
  assert.equal(
    summarizeToolCall('search_in_files', { query: 'createFsService' }, 'start'),
    'Suche nach „createFsService“ …'
  );
  assert.equal(
    summarizeToolCall('search_in_files', { query: 'createFsService' }, 'done'),
    'Nach „createFsService“ gesucht'
  );
  assert.equal(
    summarizeToolCall('search_in_files', { query: 'x'.repeat(60) }, 'done'),
    `Nach „${'x'.repeat(31)}…“ gesucht`
  );
  assert.equal(summarizeToolCall('search_in_files', {}, 'start'), 'Dateien werden durchsucht …');
  assert.equal(summarizeToolCall('search_in_files', {}, 'done'), 'Dateien durchsucht');
  assert.equal(
    summarizeToolCall('find_files', { pattern: '**/*.js' }, 'start'),
    'Suche Dateien zu „**/*.js“ …'
  );
  assert.equal(
    summarizeToolCall('find_files', { pattern: '**/*.js' }, 'done'),
    'Dateien zu „**/*.js“ gesucht'
  );
  assert.equal(summarizeToolCall('find_files', {}, 'start'), 'Dateien werden gesucht …');
  assert.equal(summarizeToolCall('find_files', {}, 'done'), 'Dateien gesucht');
  assert.equal(
    summarizeToolCall('stat_path', { relative_path: 'src/app.js' }, 'start'),
    'Pfad src/app.js wird geprüft …'
  );
  assert.equal(
    summarizeToolCall('stat_path', { relative_path: 'src/app.js' }, 'done'),
    'Pfad src/app.js geprüft'
  );
  assert.equal(summarizeToolCall('stat_path', {}, 'start'), 'Pfad wird geprüft …');
  assert.equal(summarizeToolCall('stat_path', {}, 'done'), 'Pfad geprüft');
  assert.equal(
    summarizeToolCall('outline_file', { relative_path: 'docs/konzept.md' }, 'start'),
    'Gliederung von docs/konzept.md wird ermittelt …'
  );
  assert.equal(
    summarizeToolCall('outline_file', { relative_path: 'docs/konzept.md' }, 'done'),
    'Gliederung von docs/konzept.md ermittelt'
  );
  assert.equal(summarizeToolCall('outline_file', {}, 'start'), 'Gliederung wird ermittelt …');
  assert.equal(summarizeToolCall('outline_file', {}, 'done'), 'Gliederung ermittelt');
  assert.equal(
    summarizeToolCall('list_directory_tree', { relative_path: 'src' }, 'start'),
    'Ordnerbaum src wird gelesen …'
  );
  assert.equal(
    summarizeToolCall('list_directory_tree', { relative_path: 'src' }, 'done'),
    'Ordnerbaum src gelesen'
  );
  assert.equal(summarizeToolCall('list_directory_tree', {}, 'start'), 'Ordnerbaum wird gelesen …');
  assert.equal(summarizeToolCall('list_directory_tree', {}, 'done'), 'Ordnerbaum gelesen');
  assert.equal(summarizeToolCall('debug_wait', {}, 'start'), 'Warte 5 Sekunden …');
  assert.equal(summarizeToolCall('debug_wait', {}, 'done'), '5 Sekunden gewartet');
  assert.equal(summarizeToolCall('debug_wait', { duration_seconds: 1.2 }, 'start'), 'Warte 1,2 Sekunden …');
  assert.equal(summarizeToolCall('debug_wait', { duration_seconds: 1 }, 'done'), '1 Sekunde gewartet');
  assert.equal(summarizeToolCall('unknown_tool', {}, 'start'), 'unknown_tool wird ausgeführt …');
  assert.equal(summarizeToolCall('unknown_tool', {}, 'done'), 'unknown_tool ausgeführt');
});

test('truncateToolLabel shortens long labels', () => {
  const long = 'a'.repeat(60);
  const out = truncateToolLabel(long, 20);
  assert.equal(out.length, 20);
  assert.match(out, /…$/);
});

test('formatToolDisplayLine formats raw tool trace entries', () => {
  assert.equal(
    formatToolDisplayLine({ tool: 'read_file_text', args: { relative_path: 'a.js' } }, 'done'),
    'Datei a.js gelesen'
  );
  assert.equal(
    formatToolDisplayLine({ tool: 'list_directory', args: {}, noWorkspace: true }, 'start'),
    'Projektordner wird durchsucht … · kein Ordner geöffnet'
  );
  // Persistierte Alt-Sessions enthalten bereits formatierte Strings.
  assert.equal(formatToolDisplayLine('Datei x gelesen', 'done'), 'Datei x gelesen');
});

test('formatToolDisplayLine uses main-supplied waitMs for debug_wait', () => {
  assert.equal(
    formatToolDisplayLine({ tool: 'debug_wait', args: {}, waitMs: 1200 }, 'start'),
    'Warte 1,2 Sekunden …'
  );
  assert.equal(
    formatToolDisplayLine({ tool: 'debug_wait', args: {}, waitMs: 1000 }, 'done'),
    '1 Sekunde gewartet'
  );
});

test('summarizeToolCall nutzt für die Phase pending die Start-Formulierung', () => {
  assert.equal(summarizeToolCall('write_file_text', {}, 'pending'), 'Datei wird geschrieben …');
  assert.equal(
    summarizeToolCall('write_file_text', { relative_path: 'docs/neu.md' }, 'pending'),
    'Datei docs/neu.md wird geschrieben …'
  );
  assert.equal(summarizeToolCall('edit_file', { relative_path: 'src/app.js' }, 'pending'), 'Datei src/app.js wird geändert …');
  assert.equal(
    formatToolDisplayLine({ tool: 'search_in_files', args: { query: 'TODO' } }, 'pending'),
    'Suche nach „TODO“ …'
  );
});

test('summarizeToolCall macht Skill-Pfade als Skill erkennbar (Issue #61)', () => {
  assert.equal(
    summarizeToolCall('read_file_text', { relative_path: 'skill:demo/references/anleitung.md' }, 'start'),
    'Datei references/anleitung.md (Skill demo) wird gelesen …'
  );
  assert.equal(
    summarizeToolCall('list_directory', { relative_path: 'skill:demo' }, 'done'),
    'Ordner Skill demo durchsucht'
  );
  // Ein Workspace-Pfad bleibt unverändert.
  assert.equal(
    summarizeToolCall('read_file_text', { relative_path: 'src/app.js' }, 'done'),
    'Datei src/app.js gelesen'
  );
});
