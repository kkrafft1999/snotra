// Sitzungsfreigaben (Issue #66, Konzept §7): Geltungsbereich, exakte Ziele,
// Klassen, Dateiversion und Provider-Bindung bei sensiblen Daten.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSessionGrants, sessionGrantableClasses } = require('../src/application/permissions/session-grants');

const SCOPE = JSON.stringify(['chat-1', '/work', 'smart', '3:ok', 'demo']);

test('nur read, read-sensitive und write sind sitzungsweise freigebbar', () => {
  assert.deepEqual(sessionGrantableClasses(['write', 'read']), ['read', 'write']);
  assert.deepEqual(sessionGrantableClasses(['read-sensitive']), ['read-sensitive']);
  for (const cls of ['delete', 'execute', 'external']) {
    assert.equal(sessionGrantableClasses([cls]), null, cls);
    assert.equal(sessionGrantableClasses(['read', cls]), null, `read+${cls}`);
  }
  assert.equal(sessionGrantableClasses(['nope']), null);
});

test('Freigabe gilt für denselben Bereich, dasselbe Tool, exakt dieselben Ziele und höchstens die Klassen', () => {
  const grants = createSessionGrants();
  const targets = [{ path: 'src/a.js', version: '1' }, { path: 'src/b.js', version: '2' }];
  const entry = grants.grant({ scopeKey: SCOPE, tool: 'apply_patch', targets, riskClasses: ['write'] });
  assert.ok(entry);
  assert.equal(grants.count(), 1);

  const find = (overrides) =>
    grants.find({ scopeKey: SCOPE, tool: 'apply_patch', targets, riskClasses: ['write'], ...overrides });
  assert.equal(find({})?.id, entry.id);
  assert.equal(find({ targets: [targets[1], targets[0]] })?.id, entry.id, 'Reihenfolge egal');
  assert.equal(find({ targets: [targets[0]] }), null, 'Teilmenge zählt nicht');
  assert.equal(find({ targets: [...targets, { path: 'c.js' }] }), null, 'Obermenge zählt nicht');
  assert.equal(find({ tool: 'edit_file' }), null);
  assert.equal(find({ scopeKey: 'anders' }), null);
  assert.equal(find({ riskClasses: ['write', 'read-sensitive'] }), null, 'mehr Klassen als freigegeben');
  assert.equal(find({ riskClasses: ['delete'] }), null, 'write umfasst kein delete');
  // Geänderte Dateiversion stört gewöhnliche Schreibfreigaben nicht: weitere
  // Änderungen an genau diesen Zielen bleiben erlaubt.
  assert.equal(find({ targets: [{ path: 'src/a.js', version: '9' }, { path: 'src/b.js', version: '2' }] })?.id, entry.id);
});

test('sensible Lesefreigaben binden Dateiversion und Provider-Endpunkt', () => {
  const grants = createSessionGrants();
  const targets = [{ path: '.env', version: '10:20' }];
  grants.grant({ scopeKey: SCOPE, tool: 'read_file_text', targets, riskClasses: ['read', 'read-sensitive'], providerKey: 'openai' });

  const base = { scopeKey: SCOPE, tool: 'read_file_text', riskClasses: ['read', 'read-sensitive'] };
  assert.ok(grants.find({ ...base, targets, providerKey: 'openai' }));
  assert.equal(grants.find({ ...base, targets, providerKey: 'anthropic' }), null, 'Providerwechsel fragt erneut');
  assert.equal(grants.find({ ...base, targets: [{ path: '.env', version: '11:21' }], providerKey: 'openai' }), null, 'geänderte Datei fragt erneut');
  // Ein gewöhnliches read auf dieselbe Datei ist von der sensiblen Freigabe gedeckt.
  assert.ok(grants.find({ scopeKey: SCOPE, tool: 'read_file_text', targets, riskClasses: ['read'], providerKey: 'openai' }));
});

test('nicht freigebbare Klassen ergeben keine Freigabe; clear und clearScope räumen auf', () => {
  const grants = createSessionGrants();
  assert.equal(grants.grant({ scopeKey: SCOPE, tool: 'rm', targets: [], riskClasses: ['delete'] }), null);
  assert.equal(grants.grant({ scopeKey: SCOPE, tool: '', targets: [], riskClasses: ['read'] }), null);
  grants.grant({ scopeKey: SCOPE, tool: 'a', targets: [], riskClasses: ['read'] });
  grants.grant({ scopeKey: 'other', tool: 'b', targets: [], riskClasses: ['read'] });
  assert.equal(grants.count(), 2);
  grants.clearScope(SCOPE);
  assert.equal(grants.count(), 1);
  assert.equal(grants.find({ scopeKey: SCOPE, tool: 'a', targets: [], riskClasses: ['read'] }), null);
  grants.clear();
  assert.equal(grants.count(), 0);
});
