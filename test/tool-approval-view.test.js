const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// Renderer-Modul ist natives ESM; das Contract-Bundle entsteht im pretest-Schritt.
const load = () =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'utils', 'tool-approval-view.js')).href);

// The card is built at runtime and reads the active language through `t()`;
// switching it is how the German half is checked (#290). Always switch back —
// the module keeps the locale, and the next test would inherit it.
const loadI18n = () =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js')).href);

async function inGerman(fn) {
  const { setLocale } = await loadI18n();
  setLocale('de');
  try {
    await fn();
  } finally {
    setLocale('en');
  }
}

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
  const { toolModeOptions, modeLabel } = await load();
  assert.deepEqual(toolModeOptions().map((o) => o.value), ['smart', 'ask-all', 'auto']);
  assert.deepEqual(toolModeOptions().map((o) => o.label), ['Smart', 'Always ask', 'Auto']);
  assert.equal(modeLabel('auto'), 'Auto');
  assert.equal(modeLabel('kaputt'), 'Smart');
});

test('card: change to an existing file, with session action and reach', async () => {
  const { buildApprovalCardView } = await load();
  const view = buildApprovalCardView(dto());
  assert.equal(view.title, 'Confirm change');
  assert.equal(view.headline.text, 'Snotra wants to change src/config.js (edit_file).');
  // The two slots stay standing so the component can render them as code.
  assert.equal(view.headline.template, 'Snotra wants to change {target} ({tool}).');
  assert.equal(view.headline.verb, 'change');
  assert.equal(view.classText, 'Change');
  assert.equal(view.actions.once.enabled, true);
  assert.equal(view.actions.session.enabled, true);
  assert.equal(view.actions.session.hint, '');
  assert.match(view.scopeNote, /genau src\/config\.js/);
  assert.match(view.scopeNote, /Further changes to exactly these targets then run without asking/);
  assert.equal(view.warning, '');
  assert.equal(view.preview, null);
});

test('card: German puts the target before the verb', async () => {
  const { buildApprovalCardView } = await load();
  await inGerman(async () => {
    const view = buildApprovalCardView(dto());
    assert.equal(view.title, 'Änderung bestätigen');
    assert.equal(view.headline.text, 'Snotra möchte src/config.js ändern (edit_file).');
    assert.equal(view.headline.template, 'Snotra möchte {target} {verb} ({tool}).'.replace('{verb}', 'ändern'));
    assert.equal(view.headline.verb, 'ändern');
    assert.equal(view.actions.deny.label, 'Ablehnen');
    assert.equal(view.targets[0].kindLabel, 'Datei');
  });
  // Back to the default, and the sentence turns around again.
  assert.equal(buildApprovalCardView(dto()).headline.text, 'Snotra wants to change src/config.js (edit_file).');
});

test('card: a new file is "create", overwriting warns about the trash copy', async () => {
  const { buildApprovalCardView } = await load();
  const fresh = buildApprovalCardView(
    dto({ tool: 'write_file_text', targets: [{ path: 'docs/neu.md', kind: 'file', exists: false }] })
  );
  assert.equal(fresh.headline.verb, 'create');
  assert.ok(fresh.targets[0].notes.includes('new'));
  assert.equal(fresh.warning, '');

  const overwrite = buildApprovalCardView(
    dto({ tool: 'write_file_text', targets: [{ path: 'docs/alt.md', kind: 'file', exists: true, recovery: 'trash' }] })
  );
  assert.match(overwrite.warning, /goes to the trash as a copy/);

  const noRecovery = buildApprovalCardView(
    dto({ tool: 'write_file_text', riskClasses: ['delete'], sessionAllowed: false, targets: [{ path: 'docs/alt.md', kind: 'file', exists: true }] })
  );
  assert.equal(noRecovery.headline.verb, 'overwrite with no way back');
  assert.match(noRecovery.warning, /without a recovery copy/);
  assert.equal(noRecovery.actions.session.enabled, false);
  assert.match(noRecovery.actions.session.hint, /Overwrite with no way back.*single decision/);
});

test('card: a sensitive read shows provider, file version and the file-access title', async () => {
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
  assert.equal(view.title, 'Confirm file access');
  assert.equal(view.headline.verb, 'read');
  assert.equal(view.sensitive, true);
  assert.equal(view.providerLabel, 'OpenAI');
  assert.ok(view.targets[0].notes.some((n) => n.startsWith('sensitive (Dateiname .env)')));
  assert.ok(view.targets[0].notes.includes('as of 1725000000:120'));
  assert.match(view.scopeNote, /this file version and the chosen provider/);
});

test('card: in "always ask" the session action is off – with a reason', async () => {
  const { buildApprovalCardView, sessionActionHint } = await load();
  const view = buildApprovalCardView(dto({ mode: 'ask-all', sessionAllowed: false, riskClasses: ['read'] }));
  assert.equal(view.modeLabel, 'Always ask');
  assert.equal(view.actions.session.enabled, false);
  assert.equal(view.actions.session.hint, 'This mode asks on every call.');
  assert.equal(
    sessionActionHint({ sessionAllowed: false, mode: 'smart', riskClasses: ['execute'] }),
    'For “Execute” only a single decision is possible.'
  );
  assert.equal(sessionActionHint({ sessionAllowed: true }), '');
});

test('card: the preview carries its kind and the shortened and masked notes', async () => {
  const { buildApprovalCardView } = await load();
  const view = buildApprovalCardView(
    dto({ preview: { kind: 'replace', text: '--- alt\nfoo\n+++ neu\nbar', truncated: true, masked: true } })
  );
  assert.equal(view.preview.kindLabel, 'Replacement (old → new)');
  assert.equal(view.preview.summary, 'Preview: Replacement (old → new) (shortened, secrets masked)');
  assert.match(view.preview.truncatedNote, /only passes on the beginning/);
  assert.match(view.preview.maskedNote, /stay masked when it is unfolded/);
  const plain = buildApprovalCardView(dto({ preview: { kind: 'unbekannt', text: 'x', truncated: false, masked: false } }));
  assert.equal(plain.preview.kindLabel, 'New content');
  assert.equal(plain.preview.summary, 'Preview: New content');
});

test('card: invalid DTOs yield no display model', async () => {
  const { buildApprovalCardView } = await load();
  assert.equal(buildApprovalCardView(null), null);
  assert.equal(buildApprovalCardView({ requestId: 'x' }), null);
  assert.equal(buildApprovalCardView(dto({ contractVersion: 2 })), null);
});

test('outcome: decision, expiry and cancellation, apart from the execution result', async () => {
  const { describeApprovalOutcome } = await load();
  assert.equal(describeApprovalOutcome({ response: 'deny' }).label, 'Denied');
  // The reason comes from the catalogue since #293, the frame around it since
  // #290 — both in the language of the interface.
  assert.match(describeApprovalOutcome({ response: 'deny' }).detail, /Tool call denied by you/);
  assert.equal(describeApprovalOutcome({ response: 'allow-once' }).status, 'allowed');
  assert.equal(describeApprovalOutcome({ response: 'allow-session' }).label, 'Allowed for this session');
  const gone = describeApprovalOutcome({ invalidated: true, reason: 'request_invalidated' });
  assert.equal(gone.label, 'Request expired');
  assert.match(gone.detail, /file, context or rules.*The run has ended\./);
  assert.equal(describeApprovalOutcome({ invalidated: true, reason: 'no_approval_ui' }).status, 'invalidated');
  assert.equal(describeApprovalOutcome({ aborted: true, invalidated: true }).label, 'Run cancelled');
  assert.equal(describeApprovalOutcome({}).status, 'invalidated');
  await inGerman(async () => {
    assert.equal(describeApprovalOutcome({ response: 'deny' }).label, 'Abgelehnt');
    assert.match(describeApprovalOutcome({ response: 'deny' }).detail, /^Das Modell erhält: „.+“\.$/);
    assert.equal(describeApprovalOutcome({ aborted: true, invalidated: true }).label, 'Lauf abgebrochen');
  });
});

test('audit tooltip: decision, class, status, reason; empty for older sessions', async () => {
  const { describePermissionAudit, permissionStatusKey } = await load();
  assert.equal(describePermissionAudit(undefined), '');
  assert.equal(describePermissionAudit('string'), '');
  const denied = describePermissionAudit({ decision: 'deny', source: 'deny', reason: 'user_denied', riskClasses: ['write'], mode: 'smart', status: 'denied' });
  assert.equal(denied, 'Decision: Denied · Class: Change · Status: not carried out · Reason: Tool call denied by you · Mode: Smart');
  const session = describePermissionAudit({ decision: 'allow', source: 'allow-session', riskClasses: ['read-sensitive'], status: 'executed', sensitive: true });
  assert.match(session, /^Decision: Allowed \(session allowance\) · Class: Read sensitive data · Status: carried out/);
  assert.match(session, /Sensitive content held back$/);
  assert.equal(permissionStatusKey({ status: 'awaiting-approval' }), 'awaiting');
  assert.equal(permissionStatusKey({ decision: 'deny', status: 'denied' }), 'denied');
  assert.equal(permissionStatusKey({ decision: 'allow', status: 'executed' }), 'allowed');
  assert.equal(permissionStatusKey(null), '');
});

test('Regeln: Beschreibung und Formularprüfung folgen dem Konzept', async () => {
  const { describeRule, validateRuleDraft, ruleClassOptions } = await load();
  const text = describeRule({ id: 'r1', effect: 'deny', scope: 'global', tool: 'write_file_text', pathPattern: 'secrets/**' }).text;
  assert.equal(text, 'Block: Tool write_file_text on secrets/** (All workspaces)');
  assert.equal(
    describeRule({ id: 'r2', effect: 'allow', scope: 'workspace', root: '/p', riskClass: 'read', pathPattern: '**' }).text,
    'Allowance: Class Read on all paths (This workspace)'
  );
  assert.deepEqual(ruleClassOptions('allow').map((o) => o.value), ['read', 'write']);
  assert.equal(ruleClassOptions('deny').length, 6);

  assert.deepEqual(
    validateRuleDraft({ effect: 'deny', scope: 'workspace', subjectType: 'tool', tool: ' write_file_text ', pathPattern: './docs//**', hasWorkspace: true }),
    { ok: true, rule: { effect: 'deny', scope: 'workspace', tool: 'write_file_text', pathPattern: 'docs/**' } }
  );
  assert.equal(validateRuleDraft({ effect: 'deny', scope: 'workspace', subjectType: 'tool', tool: 'x', hasWorkspace: false }).ok, false);
  assert.match(validateRuleDraft({ effect: 'allow', scope: 'global', subjectType: 'class', riskClass: 'delete' }).error, /only for “Read” and “Change”/);
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
  assert.match(validateSensitivePattern('personal/**', ['personal/**']).error, /already exists/);
});

test('Integritätswarnung und Reset-Umfang sind benannt', async () => {
  const { integrityWarning, resetActions } = await load();
  assert.match(integrityWarning('invalid'), /damaged or altered.*blocks remain in force/);
  assert.match(integrityWarning('unsigned'), /Auto.*permanent allowances/);
  assert.equal(integrityWarning('ok'), '');
  assert.deepEqual(resetActions().map((a) => a.key), ['session', 'workspace', 'all']);
  assert.equal(resetActions()[2].confirm, true);
  assert.match(resetActions()[2].description, /“Smart” mode/);
});
