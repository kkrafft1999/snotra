const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'utils', 'tool-approval-queue.js')).href);

function dto(requestId = 'req-1') {
  return { contractVersion: 1, requestId, tool: 'edit_file', riskClasses: ['write'], targets: [], reason: '', mode: 'smart', sessionAllowed: true };
}

test('ungültige DTOs und Duplikate werden ignoriert', async () => {
  const { createToolApprovalQueue } = await load();
  const queue = createToolApprovalQueue();
  assert.equal(queue.add({ requestId: 'x' }), null);
  assert.ok(queue.add(dto()));
  assert.equal(queue.add(dto()), null, 'zweite Anfrage mit derselben ID zählt nicht');
  assert.equal(queue.size(), 1);
  assert.equal(queue.pending().length, 1);
});

test('erster Klick gewinnt; Fehlschlag gibt die Karte frei', async () => {
  const { createToolApprovalQueue, APPROVAL_ENTRY_STATES } = await load();
  const queue = createToolApprovalQueue();
  queue.add(dto());
  assert.equal(queue.beginResponse('req-1', 'allow-once'), true);
  assert.equal(queue.beginResponse('req-1', 'deny'), false, 'Doppelklick hat keine Wirkung');
  assert.equal(queue.get('req-1').state, APPROVAL_ENTRY_STATES.RESPONDING);
  assert.equal(queue.beginResponse('req-1', 'allow-forever'), false);
  assert.equal(queue.failResponse('req-1'), true);
  assert.equal(queue.get('req-1').state, APPROVAL_ENTRY_STATES.PENDING);
  assert.equal(queue.beginResponse('unbekannt', 'deny'), false);
});

test('Auflösung nur einmal und nur für bekannte Anfragen', async () => {
  const { createToolApprovalQueue } = await load();
  const queue = createToolApprovalQueue();
  queue.add(dto());
  assert.equal(queue.resolve({ requestId: 'fremd', response: 'allow-once' }), null);
  const entry = queue.resolve({ requestId: 'req-1', response: 'deny', invalidated: false, reason: null });
  assert.deepEqual(entry.outcome, { invalidated: false, response: 'deny', reason: null });
  assert.equal(queue.resolve({ requestId: 'req-1', response: 'allow-once' }), null, 'verspätete Antwort tut nichts');
  assert.equal(queue.beginResponse('req-1', 'allow-once'), false, 'nach Auflösung keine Antwort mehr');
  assert.equal(queue.pending().length, 0);
});

test('Verfall durch Main überschreibt eine laufende Antwort', async () => {
  const { createToolApprovalQueue } = await load();
  const queue = createToolApprovalQueue();
  queue.add(dto());
  queue.beginResponse('req-1', 'allow-once');
  const entry = queue.resolve({ requestId: 'req-1', response: null, invalidated: true, reason: 'request_invalidated' });
  assert.deepEqual(entry.outcome, { invalidated: true, response: null, reason: 'request_invalidated' });
  assert.equal(queue.failResponse('req-1'), false, 'verfallen bleibt verfallen');
});

test('invalidateAll und forgetResolved räumen auf', async () => {
  const { createToolApprovalQueue } = await load();
  const queue = createToolApprovalQueue();
  queue.add(dto('a'));
  queue.add(dto('b'));
  queue.resolve({ requestId: 'a', response: 'allow-once' });
  const gone = queue.invalidateAll('request_invalidated');
  assert.deepEqual(gone.map((e) => e.dto.requestId), ['b']);
  assert.equal(gone[0].outcome.invalidated, true);
  queue.forgetResolved();
  assert.equal(queue.size(), 0);
});
