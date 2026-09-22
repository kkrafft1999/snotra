const test = require('node:test');
const assert = require('node:assert/strict');
const {
  truncateToolLabel,
  summarizeToolCall,
  formatToolDisplayLine,
} = require('../src/shared/presentation/tool-display');

/**
 * One table for both languages (#290). English is the default and therefore
 * the column that is checked without a locale; German is the same call with
 * `de` behind it. Written side by side on purpose — a line that reads well in
 * one language and badly in the other is visible here, not only in the app.
 */
const LINES = [
  ['list_directory', { relative_path: 'src/main' }, 'start',
    'Searching folder src/main …', 'Ordner src/main wird durchsucht …'],
  ['list_directory', { relative_path: 'src/main' }, 'done',
    'Folder src/main searched', 'Ordner src/main durchsucht'],
  ['list_directory', { relative_path: '.' }, 'start',
    'Searching the project folder …', 'Projektordner wird durchsucht …'],
  ['list_directory', { relative_path: '' }, 'done',
    'Project folder searched', 'Projektordner durchsucht'],
  ['read_file_text', { relative_path: 'README.md' }, 'start',
    'Reading file README.md …', 'Datei README.md wird gelesen …'],
  ['read_file_text', { relative_path: 'README.md' }, 'done',
    'File README.md read', 'Datei README.md gelesen'],
  ['read_file_text', {}, 'start', 'Reading file …', 'Datei wird gelesen …'],
  ['read_file_lines', { relative_path: 'src/app.js', start_line: 400, end_line: 450 }, 'start',
    'Reading file src/app.js (lines 400–450) …', 'Datei src/app.js (Zeilen 400–450) wird gelesen …'],
  ['read_file_lines', { relative_path: 'src/app.js', start_line: 400, end_line: 450 }, 'done',
    'File src/app.js (lines 400–450) read', 'Datei src/app.js (Zeilen 400–450) gelesen'],
  ['read_file_lines', { relative_path: 'src/app.js', start_line: 400 }, 'done',
    'File src/app.js (from line 400) read', 'Datei src/app.js (ab Zeile 400) gelesen'],
  ['read_file_lines', {}, 'start', 'Reading file …', 'Datei wird gelesen …'],
  ['write_file_text', { relative_path: 'notes/todo.md' }, 'start',
    'Writing file notes/todo.md …', 'Datei notes/todo.md wird geschrieben …'],
  ['write_file_text', { relative_path: 'notes/todo.md' }, 'done',
    'File notes/todo.md written', 'Datei notes/todo.md geschrieben'],
  ['write_file_text', {}, 'start', 'Writing file …', 'Datei wird geschrieben …'],
  ['write_file_text', {}, 'done', 'File written', 'Datei geschrieben'],
  ['edit_file', { relative_path: 'src/app.js' }, 'start',
    'Changing file src/app.js …', 'Datei src/app.js wird geändert …'],
  ['edit_file', { relative_path: 'src/app.js' }, 'done',
    'File src/app.js changed', 'Datei src/app.js geändert'],
  ['edit_file', {}, 'start', 'Changing file …', 'Datei wird geändert …'],
  ['edit_file', {}, 'done', 'File changed', 'Datei geändert'],
  ['apply_patch', { relative_path: 'src/app.js' }, 'start',
    'Patching file src/app.js …', 'Datei src/app.js wird gepatcht …'],
  ['apply_patch', { relative_path: 'src/app.js' }, 'done',
    'File src/app.js patched', 'Datei src/app.js gepatcht'],
  // In patch mode the paths sit in the diff, not in the arguments.
  ['apply_patch', { patch: '--- a\n' }, 'start', 'Applying patch …', 'Patch wird angewendet …'],
  ['apply_patch', {}, 'done', 'Patch applied', 'Patch angewendet'],
  ['search_in_files', { query: 'createFsService' }, 'start',
    'Searching for “createFsService” …', 'Suche nach „createFsService“ …'],
  ['search_in_files', { query: 'createFsService' }, 'done',
    'Searched for “createFsService”', 'Nach „createFsService“ gesucht'],
  ['search_in_files', { query: 'x'.repeat(60) }, 'done',
    `Searched for “${'x'.repeat(31)}…”`, `Nach „${'x'.repeat(31)}…“ gesucht`],
  ['search_in_files', {}, 'start', 'Searching files …', 'Dateien werden durchsucht …'],
  ['search_in_files', {}, 'done', 'Files searched', 'Dateien durchsucht'],
  ['find_files', { pattern: '**/*.js' }, 'start',
    'Looking for files matching “**/*.js” …', 'Suche Dateien zu „**/*.js“ …'],
  ['find_files', { pattern: '**/*.js' }, 'done',
    'Looked for files matching “**/*.js”', 'Dateien zu „**/*.js“ gesucht'],
  ['find_files', {}, 'start', 'Looking for files …', 'Dateien werden gesucht …'],
  ['find_files', {}, 'done', 'File search finished', 'Dateisuche beendet'],
  ['stat_path', { relative_path: 'src/app.js' }, 'start',
    'Checking path src/app.js …', 'Pfad src/app.js wird geprüft …'],
  ['stat_path', { relative_path: 'src/app.js' }, 'done',
    'Path src/app.js checked', 'Pfad src/app.js geprüft'],
  ['stat_path', {}, 'start', 'Checking path …', 'Pfad wird geprüft …'],
  ['stat_path', {}, 'done', 'Path checked', 'Pfad geprüft'],
  ['outline_file', { relative_path: 'docs/konzept.md' }, 'start',
    'Working out the outline of docs/konzept.md …', 'Gliederung von docs/konzept.md wird ermittelt …'],
  ['outline_file', { relative_path: 'docs/konzept.md' }, 'done',
    'Outline of docs/konzept.md worked out', 'Gliederung von docs/konzept.md ermittelt'],
  ['outline_file', {}, 'start', 'Working out the outline …', 'Gliederung wird ermittelt …'],
  ['outline_file', {}, 'done', 'Outline worked out', 'Gliederung ermittelt'],
  ['list_directory_tree', { relative_path: 'src' }, 'start',
    'Reading folder tree src …', 'Ordnerbaum src wird gelesen …'],
  ['list_directory_tree', { relative_path: 'src' }, 'done',
    'Folder tree src read', 'Ordnerbaum src gelesen'],
  ['list_directory_tree', {}, 'start', 'Reading the folder tree …', 'Ordnerbaum wird gelesen …'],
  ['list_directory_tree', {}, 'done', 'Folder tree read', 'Ordnerbaum gelesen'],
  ['unknown_tool', {}, 'start', 'Running unknown_tool …', 'unknown_tool wird ausgeführt …'],
  ['unknown_tool', {}, 'done', 'unknown_tool run', 'unknown_tool ausgeführt'],
];

test('summarizeToolCall formats workspace tools with start and done labels', () => {
  for (const [tool, args, phase, en, de] of LINES) {
    const where = `${tool} ${phase} ${JSON.stringify(args)}`;
    // No locale means the app default, and that has been English since #290.
    assert.equal(summarizeToolCall(tool, args, phase), en, where);
    assert.equal(summarizeToolCall(tool, args, phase, 'en'), en, where);
    assert.equal(summarizeToolCall(tool, args, phase, 'de'), de, where);
  }
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
    'File a.js read'
  );
  assert.equal(
    formatToolDisplayLine({ tool: 'read_file_text', args: { relative_path: 'a.js' } }, 'done', 'de'),
    'Datei a.js gelesen'
  );
  assert.equal(
    formatToolDisplayLine({ tool: 'list_directory', args: {}, noWorkspace: true }, 'start'),
    'Searching the project folder … · no folder open'
  );
  assert.equal(
    formatToolDisplayLine({ tool: 'list_directory', args: {}, noWorkspace: true }, 'start', 'de'),
    'Projektordner wird durchsucht … · kein Ordner geöffnet'
  );
  // Persisted older sessions already contain formatted strings.
  assert.equal(formatToolDisplayLine('Datei x gelesen', 'done'), 'Datei x gelesen');
});

test('summarizeToolCall uses the start wording for the pending phase', () => {
  assert.equal(summarizeToolCall('write_file_text', {}, 'pending'), 'Writing file …');
  assert.equal(summarizeToolCall('write_file_text', {}, 'pending', 'de'), 'Datei wird geschrieben …');
  assert.equal(
    summarizeToolCall('write_file_text', { relative_path: 'docs/neu.md' }, 'pending'),
    'Writing file docs/neu.md …'
  );
  assert.equal(
    summarizeToolCall('edit_file', { relative_path: 'src/app.js' }, 'pending', 'de'),
    'Datei src/app.js wird geändert …'
  );
  assert.equal(
    formatToolDisplayLine({ tool: 'search_in_files', args: { query: 'TODO' } }, 'pending'),
    'Searching for “TODO” …'
  );
});

test('summarizeToolCall makes skill paths recognisable as skills (issue #61)', () => {
  assert.equal(
    summarizeToolCall('read_file_text', { relative_path: 'skill:demo/references/anleitung.md' }, 'start'),
    'Reading file references/anleitung.md (skill demo) …'
  );
  assert.equal(
    summarizeToolCall('read_file_text', { relative_path: 'skill:demo/references/anleitung.md' }, 'start', 'de'),
    'Datei references/anleitung.md (Skill demo) wird gelesen …'
  );
  assert.equal(
    summarizeToolCall('list_directory', { relative_path: 'skill:demo' }, 'done'),
    'Folder Skill demo searched'
  );
  assert.equal(
    summarizeToolCall('list_directory', { relative_path: 'skill:demo' }, 'done', 'de'),
    'Ordner Skill demo durchsucht'
  );
  // A workspace path stays as it is.
  assert.equal(
    summarizeToolCall('read_file_text', { relative_path: 'src/app.js' }, 'done'),
    'File src/app.js read'
  );
});
