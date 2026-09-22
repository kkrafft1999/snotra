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
const { translateMessage } = require('../src/shared/i18n');

// Seit #290 liefern die beiden Beschreiber Katalogschluessel statt Saetze —
// gesprochen wird erst beim Anzeigen. Der Test liest sie hier in beiden
// Sprachen aus, damit der Wortlaut geprueft bleibt.
const reasonIn = (locale, options) =>
  describeApprovalReason(options).map((m) => translateMessage(locale, m)).join(' ');
const scopeIn = (locale, options) => translateMessage(locale, describeSessionScope(options));

test('Begründung folgt dem Wortlaut des Konzepts je Modus und Klasse', () => {
  // Der Modusname steckt als Schluessel in den Parametern und wird beim
  // Uebersetzen eingesetzt — deshalb steht „Smart" englisch und „Intelligent"
  // deutsch im selben Satz.
  assert.deepEqual(describeApprovalReason({ mode: 'smart', askClasses: ['write'] }), [
    { key: 'approval.reason.write', params: { modeKey: 'permissions.mode.smart' } },
  ]);
  assert.equal(
    reasonIn('en', { mode: 'smart', askClasses: ['write'] }),
    'In “Smart” mode, file changes need an approval.'
  );
  assert.equal(
    reasonIn('de', { mode: 'smart', askClasses: ['write'] }),
    'Im Modus „Intelligent“ benötigen Dateiänderungen eine Freigabe.'
  );
  assert.match(reasonIn('de', { mode: 'ask-all', askClasses: ['read'] }), /Der Modus „Immer fragen“ fragt bei jedem Tool-Aufruf\./);
  assert.equal(
    reasonIn('de', { mode: 'smart', askClasses: ['read-sensitive'], providerLabel: 'openai' }),
    'Diese Datei kann Zugangsdaten enthalten. Der freigegebene Inhalt wird an openai übermittelt.'
  );
  assert.match(reasonIn('en', { mode: 'smart', askClasses: ['read-sensitive'] }), /the chosen provider/);
  assert.match(reasonIn('de', { mode: 'smart', askClasses: ['read-sensitive'], checkpoint: 'output' }), /zurückgehalten/);
  assert.match(reasonIn('de', { mode: 'smart', askClasses: ['delete'] }), /ohne dass eine Wiederherstellungskopie/);
  assert.match(reasonIn('de', { mode: 'smart', askClasses: ['write'], recovery: 'trash' }), /Papierkorb/);
  assert.match(reasonIn('de', { mode: 'smart', askClasses: ['execute'] }), /Programm/);
  assert.match(reasonIn('de', { mode: 'smart', askClasses: ['external'] }), /externen Dienst/);
  assert.match(reasonIn('de', { mode: 'smart', askClasses: [] }), /benötigt dieser Aufruf eine Freigabe/);
});

test('Sitzungsumfang nennt Tool, exakte Ziele und Klassen', () => {
  const write = { tool: 'edit_file', targets: [{ path: 'a.js' }, 'b.js'], riskClasses: ['write'] };
  assert.equal(scopeIn('de', write), 'Gilt in dieser Sitzung für edit_file auf genau a.js, b.js (Ändern).');
  assert.equal(scopeIn('en', write), 'Applies in this session to edit_file on exactly a.js, b.js (Change).');
  // Ohne Pfade haengt die Freigabe am Tool statt an einem Ziel — „auf genau
  // ohne Dateiziel" waere kein deutscher Satz (#166).
  const anyCall = { tool: 'web_search', targets: [], riskClasses: ['read'] };
  assert.equal(scopeIn('de', anyCall), 'Gilt in dieser Sitzung für jeden Aufruf von web_search (Lesen).');
  assert.equal(scopeIn('en', anyCall), 'Applies in this session to every call of web_search (Read).');
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
  assert.match(scopeIn('de', { tool: request.tool, targets: plan.targets, riskClasses: request.riskClasses }), /write_file_text auf genau a\.md/);
  assert.equal(request.sessionScope.key, 'approval.sessionScope.targets');
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
