const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Renderer-Modul ist natives ESM; das Contract-Bundle entsteht im pretest-Schritt.
const load = () =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'utils', 'tool-approval-view.js')).href);

function dto(overrides = {}) {
  return {
    contractVersion: 1,
    requestId: 'req-1',
    tool: 'edit_file',
    riskClasses: ['write'],
    targets: [{ path: 'src/config.js', kind: 'file', exists: true, sensitive: false }],
    reason: 'Im Modus „Intelligent“ benötigen Dateiänderungen eine Freigabe.',
    mode: 'smart',
    sessionAllowed: true,
    sessionScopeLabel: 'Gilt in dieser Sitzung für edit_file auf genau src/config.js (Ändern).',
    ...overrides,
  };
}

test('Modus-Optionen: drei Modi in Konzept-Reihenfolge mit Labels', async () => {
  const { TOOL_MODE_OPTIONS, modeLabel } = await load();
  assert.deepEqual(TOOL_MODE_OPTIONS.map((o) => o.value), ['smart', 'ask-all', 'auto']);
  assert.deepEqual(TOOL_MODE_OPTIONS.map((o) => o.label), ['Intelligent', 'Immer fragen', 'Auto']);
  assert.equal(modeLabel('auto'), 'Auto');
  assert.equal(modeLabel('kaputt'), 'Intelligent');
});

test('Karte: Änderung an bestehender Datei mit Sitzungsaktion und Reichweite', async () => {
  const { buildApprovalCardView } = await load();
  const view = buildApprovalCardView(dto());
  assert.equal(view.title, 'Änderung bestätigen');
  assert.equal(view.headline.text, 'Snotra möchte src/config.js ändern (edit_file).');
  assert.equal(view.headline.verb, 'ändern');
  assert.equal(view.classText, 'Ändern');
  assert.equal(view.actions.once.enabled, true);
  assert.equal(view.actions.session.enabled, true);
  assert.equal(view.actions.session.hint, '');
  assert.match(view.scopeNote, /genau src\/config\.js/);
  assert.match(view.scopeNote, /Weitere Änderungen an genau diesen Zielen laufen dann ohne Rückfrage/);
  assert.equal(view.warning, '');
  assert.equal(view.preview, null);
});

test('Karte: neue Datei heißt „anlegen“, Überschreiben warnt mit Papierkorb-Hinweis', async () => {
  const { buildApprovalCardView } = await load();
  const fresh = buildApprovalCardView(
    dto({ tool: 'write_file_text', targets: [{ path: 'docs/neu.md', kind: 'file', exists: false }] })
  );
  assert.equal(fresh.headline.verb, 'anlegen');
  assert.ok(fresh.targets[0].notes.includes('neu'));
  assert.equal(fresh.warning, '');

  const overwrite = buildApprovalCardView(
    dto({ tool: 'write_file_text', targets: [{ path: 'docs/alt.md', kind: 'file', exists: true, recovery: 'trash' }] })
  );
  assert.match(overwrite.warning, /Kopie im Papierkorb/);

  const noRecovery = buildApprovalCardView(
    dto({ tool: 'write_file_text', riskClasses: ['delete'], sessionAllowed: false, targets: [{ path: 'docs/alt.md', kind: 'file', exists: true }] })
  );
  assert.equal(noRecovery.headline.verb, 'ohne Rückweg überschreiben');
  assert.match(noRecovery.warning, /ohne Wiederherstellungskopie/);
  assert.equal(noRecovery.actions.session.enabled, false);
  assert.match(noRecovery.actions.session.hint, /Überschreiben ohne Rückweg.*Einzelentscheidung/);
});

test('Karte: sensibles Lesen zeigt Provider, Dateistand und Titel „Dateizugriff bestätigen“', async () => {
  const { buildApprovalCardView } = await load();
  const view = buildApprovalCardView(
    dto({
      tool: 'read_file_text',
      riskClasses: ['read-sensitive'],
      targets: [{ path: '.env', kind: 'file', exists: true, sensitive: true, sensitiveReason: 'Dateiname .env', version: '1725000000:120' }],
      reason: 'Diese Datei kann Zugangsdaten enthalten. Der freigegebene Inhalt wird an OpenAI übermittelt.',
      providerLabel: 'OpenAI',
      sessionScopeLabel: 'Gilt in dieser Sitzung für read_file_text auf genau .env (Sensible Daten lesen).',
    })
  );
  assert.equal(view.title, 'Dateizugriff bestätigen');
  assert.equal(view.headline.verb, 'lesen');
  assert.equal(view.sensitive, true);
  assert.equal(view.providerLabel, 'OpenAI');
  assert.ok(view.targets[0].notes.some((n) => n.startsWith('sensibel (Dateiname .env)')));
  assert.ok(view.targets[0].notes.includes('Stand 1725000000:120'));
  assert.match(view.scopeNote, /Dateistand und den gewählten Provider/);
});

test('Karte: im Modus „Immer fragen“ ist die Sitzungsaktion aus – mit Begründung', async () => {
  const { buildApprovalCardView, sessionActionHint } = await load();
  const view = buildApprovalCardView(dto({ mode: 'ask-all', sessionAllowed: false, riskClasses: ['read'] }));
  assert.equal(view.modeLabel, 'Immer fragen');
  assert.equal(view.actions.session.enabled, false);
  assert.equal(view.actions.session.hint, 'Dieser Modus fragt bei jedem Aufruf.');
  assert.equal(sessionActionHint({ sessionAllowed: false, mode: 'smart', riskClasses: ['execute'] }), 'Für „Ausführen“ ist nur eine Einzelentscheidung möglich.');
  assert.equal(sessionActionHint({ sessionAllowed: true }), '');
});

test('Karte: Vorschau trägt Art, Kürzungs- und Maskierungshinweis', async () => {
  const { buildApprovalCardView } = await load();
  const view = buildApprovalCardView(
    dto({ preview: { kind: 'replace', text: '--- alt\nfoo\n+++ neu\nbar', truncated: true, masked: true } })
  );
  assert.equal(view.preview.kindLabel, 'Ersetzung (alt → neu)');
  assert.equal(view.preview.summary, 'Vorschau: Ersetzung (alt → neu) (gekürzt, Geheimnisse maskiert)');
  assert.match(view.preview.truncatedNote, /nur den Anfang/);
  assert.match(view.preview.maskedNote, /auch aufgeklappt/);
  const plain = buildApprovalCardView(dto({ preview: { kind: 'unbekannt', text: 'x', truncated: false, masked: false } }));
  assert.equal(plain.preview.kindLabel, 'Neuer Inhalt');
  assert.equal(plain.preview.summary, 'Vorschau: Neuer Inhalt');
});

test('Karte: ungültige DTOs ergeben kein Anzeige-Modell', async () => {
  const { buildApprovalCardView } = await load();
  assert.equal(buildApprovalCardView(null), null);
  assert.equal(buildApprovalCardView({ requestId: 'x' }), null);
  assert.equal(buildApprovalCardView(dto({ contractVersion: 2 })), null);
});

test('Ergebnis: Entscheidung, Verfall und Abbruch getrennt vom Ausführungserfolg', async () => {
  const { describeApprovalOutcome } = await load();
  assert.equal(describeApprovalOutcome({ response: 'deny' }).label, 'Abgelehnt');
  assert.match(describeApprovalOutcome({ response: 'deny' }).detail, /Tool-Aufruf vom Nutzer abgelehnt/);
  assert.equal(describeApprovalOutcome({ response: 'allow-once' }).status, 'allowed');
  assert.equal(describeApprovalOutcome({ response: 'allow-session' }).label, 'Für diese Sitzung erlaubt');
  const gone = describeApprovalOutcome({ invalidated: true, reason: 'request_invalidated' });
  assert.equal(gone.label, 'Anfrage verfallen');
  assert.match(gone.detail, /Datei, Kontext oder Regeln.*Der Lauf ist beendet\./);
  assert.equal(describeApprovalOutcome({ invalidated: true, reason: 'no_approval_ui' }).status, 'invalidated');
  assert.equal(describeApprovalOutcome({ aborted: true, invalidated: true }).label, 'Lauf abgebrochen');
  assert.equal(describeApprovalOutcome({}).status, 'invalidated');
});

test('Audit-Tooltip: Entscheidung, Klasse, Status, Grund; leer für Alt-Sessions', async () => {
  const { describePermissionAudit, permissionStatusKey } = await load();
  assert.equal(describePermissionAudit(undefined), '');
  assert.equal(describePermissionAudit('string'), '');
  const denied = describePermissionAudit({ decision: 'deny', source: 'deny', reason: 'user_denied', riskClasses: ['write'], mode: 'smart', status: 'denied' });
  assert.equal(denied, 'Entscheidung: Abgelehnt · Klasse: Ändern · Status: nicht ausgeführt · Grund: Tool-Aufruf vom Nutzer abgelehnt · Modus: Intelligent');
  const session = describePermissionAudit({ decision: 'allow', source: 'allow-session', riskClasses: ['read-sensitive'], status: 'executed', sensitive: true });
  assert.match(session, /^Entscheidung: Erlaubt \(Sitzungsfreigabe\) · Klasse: Sensible Daten lesen · Status: ausgeführt/);
  assert.match(session, /Sensibler Inhalt zurückgehalten$/);
  assert.equal(permissionStatusKey({ status: 'awaiting-approval' }), 'awaiting');
  assert.equal(permissionStatusKey({ decision: 'deny', status: 'denied' }), 'denied');
  assert.equal(permissionStatusKey({ decision: 'allow', status: 'executed' }), 'allowed');
  assert.equal(permissionStatusKey(null), '');
});

test('Regeln: Beschreibung und Formularprüfung folgen dem Konzept', async () => {
  const { describeRule, validateRuleDraft, ruleClassOptions } = await load();
  const text = describeRule({ id: 'r1', effect: 'deny', scope: 'global', tool: 'write_file_text', pathPattern: 'secrets/**' }).text;
  assert.equal(text, 'Sperre: Tool write_file_text auf secrets/** (Alle Workspaces)');
  assert.equal(
    describeRule({ id: 'r2', effect: 'allow', scope: 'workspace', root: '/p', riskClass: 'read', pathPattern: '**' }).text,
    'Erlaubnis: Klasse Lesen auf alle Pfade (Dieser Workspace)'
  );
  assert.deepEqual(ruleClassOptions('allow').map((o) => o.value), ['read', 'write']);
  assert.equal(ruleClassOptions('deny').length, 6);

  assert.deepEqual(
    validateRuleDraft({ effect: 'deny', scope: 'workspace', subjectType: 'tool', tool: ' write_file_text ', pathPattern: './docs//**', hasWorkspace: true }),
    { ok: true, rule: { effect: 'deny', scope: 'workspace', tool: 'write_file_text', pathPattern: 'docs/**' } }
  );
  assert.equal(validateRuleDraft({ effect: 'deny', scope: 'workspace', subjectType: 'tool', tool: 'x', hasWorkspace: false }).ok, false);
  assert.match(validateRuleDraft({ effect: 'allow', scope: 'global', subjectType: 'class', riskClass: 'delete' }).error, /nur für „Lesen“ und „Ändern“/);
  assert.match(validateRuleDraft({ effect: 'deny', scope: 'global', subjectType: 'class', riskClass: 'read', pathPattern: '../x' }).error, /\.\./);
  assert.equal(validateRuleDraft({ effect: 'deny', scope: 'global', subjectType: 'class', riskClass: 'read', pathPattern: '' }).rule.pathPattern, '**');
  assert.equal(validateRuleDraft({ effect: 'nope' }).ok, false);
});

test('Sensible Pfadmuster: kein „..“, kein Alles-Muster, keine Duplikate', async () => {
  const { validateSensitivePattern } = await load();
  assert.deepEqual(validateSensitivePattern(' personal/** ', []), { ok: true, pattern: 'personal/**' });
  assert.equal(validateSensitivePattern('**', []).ok, false);
  assert.equal(validateSensitivePattern('', []).ok, false);
  assert.equal(validateSensitivePattern('../x', []).ok, false);
  assert.match(validateSensitivePattern('personal/**', ['personal/**']).error, /schon/);
});

test('Integritätswarnung und Reset-Umfang sind benannt', async () => {
  const { integrityWarning, RESET_ACTIONS } = await load();
  assert.match(integrityWarning('invalid'), /beschädigt oder verändert.*Sperren bleiben/);
  assert.match(integrityWarning('unsigned'), /Auto.*dauerhafte Erlaubnisse/);
  assert.equal(integrityWarning('ok'), '');
  assert.deepEqual(RESET_ACTIONS.map((a) => a.key), ['session', 'workspace', 'all']);
  assert.equal(RESET_ACTIONS[2].confirm, true);
  assert.match(RESET_ACTIONS[2].description, /Modus „Intelligent“/);
});
