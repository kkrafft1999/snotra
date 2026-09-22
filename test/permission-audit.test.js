// Audit-Spuren der Berechtigungen (Issue #66, Konzept §9): Tool-Zeile und
// Verlaufs-Normalisierung tragen bereinigte Entscheidungen, keine Inhalte.

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatToolDisplayLine } = require('../src/shared/presentation/tool-display');
const { toolTraceEntryForStore, sanitizeChatMessagesForStore, normalizeLoadedMessages } = require('../src/main/services/chat-history-normalization');

test('Tool-Zeile zeigt Ablehnung, Blockade und Warten', () => {
  const base = { tool: 'edit_file', args: { relative_path: 'a.js' } };
  assert.equal(formatToolDisplayLine(base, 'done'), 'File a.js changed');
  assert.equal(formatToolDisplayLine({ ...base, permission: { status: 'denied', reason: 'user_denied' } }, 'done'), 'File a.js changed · denied');
  assert.equal(formatToolDisplayLine({ ...base, permission: { status: 'denied', reason: 'hard_limit' } }, 'done'), 'File a.js changed · blocked');
  assert.equal(formatToolDisplayLine({ ...base, permission: { status: 'awaiting-approval' } }, 'start'), 'Changing file a.js … · waiting for approval');
  assert.equal(formatToolDisplayLine({ ...base, permission: { status: 'executed' } }, 'done'), 'File a.js changed');
  assert.equal(formatToolDisplayLine({ ...base, noWorkspace: true, permission: { status: 'denied' } }, 'done'), 'File a.js changed · blocked · no folder open');
});

test('Verlauf speichert den bereinigten Audit-Eintrag und verwirft Rohdaten', () => {
  const entry = {
    tool: 'read_file_text',
    args: { relative_path: '.env', content: 'geheim' },
    line: 'Datei .env gelesen',
    permission: {
      decision: 'allow',
      source: 'allow-once',
      riskClasses: ['read', 'read-sensitive'],
      mode: 'smart',
      status: 'executed',
      targets: ['.env'],
      sensitive: true,
      preview: 'darf nicht mit',
      args: { content: 'geheim' },
    },
  };
  assert.deepEqual(toolTraceEntryForStore(entry), {
    line: 'Datei .env gelesen',
    tool: 'read_file_text',
    permission: {
      decision: 'allow',
      source: 'allow-once',
      mode: 'smart',
      status: 'executed',
      riskClasses: ['read', 'read-sensitive'],
      targets: ['.env'],
      sensitive: true,
    },
  });
  assert.equal(JSON.stringify(toolTraceEntryForStore(entry)).includes('geheim'), false);
  assert.equal(toolTraceEntryForStore({ line: 'alt' }), 'alt', 'alte Einträge bleiben Strings');
  assert.deepEqual(toolTraceEntryForStore({ line: 'x', permission: { nichts: true } }), 'x');
});

test('Audit überlebt Speichern und Laden einer Session', () => {
  const stored = sanitizeChatMessagesForStore([
    { role: 'user', content: 'frage' },
    { role: 'assistant', content: '', toolTrace: [{ tool: 'edit_file', line: 'File a.js changed · denied', permission: { decision: 'deny', reason: 'user_denied', status: 'denied', mode: 'smart', riskClasses: ['write'] } }] },
  ]);
  assert.equal(stored[1].toolTrace[0].permission.reason, 'user_denied');
  const loaded = normalizeLoadedMessages(stored);
  assert.equal(loaded[1].toolTrace[0].permission.decision, 'deny');
  assert.equal(loaded[1].toolTrace[0].line, 'File a.js changed · denied');
});
