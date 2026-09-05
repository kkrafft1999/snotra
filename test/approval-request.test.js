// Kartentext und Provider-Redaktion (Issue #66, Konzept §4/§6).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  describeApprovalReason,
  describeSessionScope,
  buildApprovalRequest,
} = require('../src/application/permissions/approval-request');
const {
  createSensitiveMarker,
  redactSensitiveToolMessages,
  stripSensitiveMarkers,
  redactedToolContent,
} = require('../src/application/permissions/sensitive-redaction');
const { SENSITIVE_CONTENT_REDACTED_TEXT } = require('../src/shared/contracts/tool-permissions');

test('Begründung folgt dem Wortlaut des Konzepts je Modus und Klasse', () => {
  assert.equal(
    describeApprovalReason({ mode: 'smart', askClasses: ['write'] }),
    'Im Modus „Intelligent“ benötigen Dateiänderungen eine Freigabe.'
  );
  assert.match(describeApprovalReason({ mode: 'ask-all', askClasses: ['read'] }), /Der Modus „Immer fragen“ fragt bei jedem Tool-Aufruf\./);
  assert.equal(
    describeApprovalReason({ mode: 'smart', askClasses: ['read-sensitive'], providerLabel: 'openai' }),
    'Diese Datei kann Zugangsdaten enthalten. Der freigegebene Inhalt wird an openai übermittelt.'
  );
  assert.match(describeApprovalReason({ mode: 'smart', askClasses: ['read-sensitive'], checkpoint: 'output' }), /zurückgehalten/);
  assert.match(describeApprovalReason({ mode: 'smart', askClasses: ['delete'] }), /ohne dass eine Wiederherstellungskopie/);
  assert.match(describeApprovalReason({ mode: 'smart', askClasses: ['write'], recovery: 'trash' }), /Papierkorb/);
  assert.match(describeApprovalReason({ mode: 'smart', askClasses: ['execute'] }), /Programm/);
  assert.match(describeApprovalReason({ mode: 'smart', askClasses: ['external'] }), /externen Dienst/);
  assert.match(describeApprovalReason({ mode: 'smart', askClasses: [] }), /benötigt dieser Aufruf eine Freigabe/);
});

test('Sitzungsumfang nennt Tool, exakte Ziele und Klassen', () => {
  assert.equal(
    describeSessionScope({ tool: 'edit_file', targets: [{ path: 'a.js' }, 'b.js'], riskClasses: ['write'] }),
    'Gilt in dieser Sitzung für edit_file auf genau a.js, b.js (Ändern).'
  );
  assert.match(describeSessionScope({ tool: 'debug_wait', targets: [], riskClasses: ['read'] }), /ohne Dateiziel/);
});

test('buildApprovalRequest bindet Plan, Policy-Version und bietet Sitzung nur für freigebbare Klassen', () => {
  const plan = {
    riskClasses: ['write'],
    targets: [{ path: 'a.md', kind: 'file', exists: true, version: '1:2', sensitive: false, absPath: '/x/a.md', recovery: 'trash' }],
    planKey: 'plan-1',
    recovery: 'trash',
    preview: { kind: 'text', text: 'neu', truncated: false, masked: false },
  };
  const request = buildApprovalRequest({ tool: 'write_file_text', plan, askClasses: ['write'], mode: 'smart', providerKey: 'openai', providerLabel: 'openai', policyVersion: '3:ok', chatId: 'c1' });
  assert.equal(request.sessionAllowed, true);
  assert.match(request.sessionScopeLabel, /write_file_text auf genau a\.md/);
  assert.equal(request.planKey, 'plan-1');
  assert.equal(request.policyVersion, '3:ok');
  assert.equal(request.chatId, 'c1');
  assert.deepEqual(request.targets[0], { path: 'a.md', kind: 'file', exists: true, sensitive: false, sensitiveReason: undefined, version: '1:2', recovery: 'trash' });
  assert.equal(request.providerLabel, undefined, 'Provider nur bei sensiblen Daten');
  assert.deepEqual(request.preview, plan.preview);

  const askAll = buildApprovalRequest({ tool: 'read_file_text', plan: { riskClasses: ['read'], targets: [], planKey: 'p' }, askClasses: ['read'], mode: 'ask-all' });
  assert.equal(askAll.sessionAllowed, false, 'ask-all bietet keine Sitzung');

  const del = buildApprovalRequest({ tool: 'write_file_text', plan: { riskClasses: ['delete'], targets: [], planKey: 'p' }, askClasses: ['delete'], mode: 'smart' });
  assert.equal(del.sessionAllowed, false, 'delete nur einmalig');

  const sensitive = buildApprovalRequest({ tool: 'read_file_text', plan: { riskClasses: ['read', 'read-sensitive'], targets: [{ path: '.env' }], planKey: 'p' }, askClasses: ['read-sensitive'], mode: 'smart', providerKey: 'openai|http://x', providerLabel: 'openai (x)' });
  assert.equal(sensitive.sessionAllowed, true);
  assert.equal(sensitive.providerLabel, 'openai (x)');
  assert.equal(sensitive.providerKey, 'openai|http://x');
});

test('Redaktion ersetzt markierte Tool-Nachrichten fremder Endpunkte und lässt passende stehen', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'tool', tool_call_id: '1', content: '{"content":"geheim"}', sensitiveMarker: createSensitiveMarker({ providerKey: 'openai', targets: [{ path: '.env', version: '1' }] }) },
    { role: 'tool', tool_call_id: '2', content: '{"content":"auch geheim"}', sensitiveMarker: createSensitiveMarker({ providerKey: 'anthropic', targets: [{ path: '.env', version: '1' }] }) },
    { role: 'tool', tool_call_id: '3', content: '{"ok":true}' },
  ];
  assert.equal(redactSensitiveToolMessages(messages, 'openai'), 1);
  assert.equal(messages[1].content, '{"content":"geheim"}');
  assert.equal(messages[2].content, redactedToolContent());
  assert.equal(messages[2].redacted, true);
  assert.equal(JSON.parse(messages[2].content).note, SENSITIVE_CONTENT_REDACTED_TEXT);
  assert.equal(redactSensitiveToolMessages(messages, 'openai'), 0, 'nicht doppelt zählen');
  assert.equal(redactSensitiveToolMessages(null, 'x'), 0);

  const wire = stripSensitiveMarkers(messages);
  assert.equal(wire.some((m) => 'sensitiveMarker' in m || 'redacted' in m), false, 'Marker gehen nie über die Leitung');
  assert.equal(wire[1].content, '{"content":"geheim"}');
  assert.equal(messages[1].sensitiveMarker.providerKey, 'openai', 'Original bleibt markiert');
});
