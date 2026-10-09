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

test('card: a sensitive read shows provider and the file-access title, keeps the file version hidden', async () => {
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
  // The version token is kept for the binding but never shown (#811).
  assert.equal(view.targets[0].version, '1725000000:120');
  assert.ok(!view.targets[0].notes.some((n) => n.includes('1725000000')));
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
    dto({ preview: { kind: 'replace', text: '--- old\nfoo\n+++ new\nbar', truncated: true, masked: true } })
  );
  assert.equal(view.preview.kindLabel, 'Replacement (old → new)');
  assert.equal(view.preview.summary, 'Preview: Replacement (old → new) (shortened, secrets masked)');
  assert.match(view.preview.truncatedNote, /only the beginning of a very long text/);
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
  // Session allowances left the reset list for a list of their own (#447).
  assert.deepEqual(resetActions().map((a) => a.key), ['workspace', 'all']);
  assert.equal(resetActions()[1].confirm, true);
  assert.match(resetActions()[1].description, /“Smart” mode/);
  assert.match(resetActions()[1].description, /program allowances/);
});

test('session approvals are grouped by chat, the open chat first, in both languages (#447)', async () => {
  const { sessionGrantGroups } = await load();
  const grants = [
    { id: 'g-bg', chatId: 'bg', chatTitle: 'Tree filter', current: false, tool: 'edit_file', classes: ['write'], scope: null, grantedAt: 5 },
    {
      id: 'g-1', chatId: 'cur', chatTitle: '', current: true, tool: 'write_file_text', classes: ['write'], grantedAt: 7,
      scope: { key: 'approval.sessionScope.targets', params: { tool: 'write_file_text', paths: 'docs/a.md', effectKeys: [] } },
    },
    { id: '', chatId: 'cur', current: true, tool: 'x', classes: [] },
    null,
  ];
  const formatTime = (ms) => `t${ms}`;
  const groups = sessionGrantGroups(grants, { formatTime });
  assert.deepEqual(groups.map((g) => g.label), ['New chat · open chat', 'Tree filter · running in the background']);
  assert.equal(groups[0].items.length, 1, 'an entry without id is dropped');
  assert.match(groups[0].items[0].text, /write_file_text.*docs\/a\.md/);
  assert.equal(groups[0].items[0].meta, 'Granted at t7', 'the sentence names the class already');
  assert.equal(groups[1].items[0].text, 'Applies in this session to edit_file.');
  assert.equal(groups[1].items[0].meta, 'Change · granted at t5', 'without the sentence the class is named');
  assert.deepEqual(sessionGrantGroups(undefined), []);

  await inGerman(async () => {
    const de = sessionGrantGroups(grants, { formatTime });
    assert.deepEqual(de.map((g) => g.label), ['Neuer Chat · geöffneter Chat', 'Tree filter · läuft im Hintergrund']);
    assert.equal(de[0].items[0].meta, 'Erteilt um t7');
    assert.equal(de[1].items[0].meta, 'Ändern · erteilt um t5');
  });
});

// #551: standard input and arguments belong on the card; without them `sh` or
// `exec(input())` could be any program.
test('the card shows stdin and argv below the source, in both languages (#551)', async () => {
  const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');
  const request = createToolApprovalRequestDto({
    requestId: 'r-stdin',
    tool: 'run_python',
    riskClasses: ['execute'],
    targets: [],
    mode: 'smart',
    sessionAllowed: false,
    preview: { kind: 'code', text: 'import sys', truncated: false, masked: false, stdin: 'line 1\nline 2', argv: ['--out', 'a b', 7] },
  });
  assert.equal(request.preview.stdin, 'line 1\nline 2');
  assert.deepEqual(request.preview.argv, ['--out', 'a b'], 'only strings pass');

  const { buildApprovalCardView } = await load();
  const view = buildApprovalCardView(request);
  assert.deepEqual(view.preview.blocks, [
    { id: 'stdin', label: 'Input (stdin)', text: 'line 1\nline 2' },
    { id: 'argv', label: 'Arguments (sys.argv[1:])', text: '"--out"\n"a b"' },
  ]);
  await inGerman(async () => {
    const german = buildApprovalCardView(request);
    assert.deepEqual(german.preview.blocks.map((block) => block.label), ['Eingabe (stdin)', 'Argumente (sys.argv[1:])']);
  });

  const plain = buildApprovalCardView(dto({ preview: { kind: 'shell', text: 'git status', truncated: false, masked: false } }));
  assert.deepEqual(plain.preview.blocks, []);
});

// CR-B13-01 (#596): a bidi control reorders what the card shows, so
// `echo safe # ; echo PWNED` can be what is read while the shell runs both.
// Every text the model chose shows its invisible characters as ⟨U+…⟩.
const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const PDI = String.fromCodePoint(0x2069);
const PDF = String.fromCodePoint(0x202c);
const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const ZWNJ = String.fromCodePoint(0x200c);
const TAG_A = String.fromCodePoint(0xe0041);

test('revealInvisible: bidi, zero-width, tag and control characters, but not line endings or joiners in scripts', async () => {
  const { revealInvisible } = await load();
  assert.deepEqual(revealInvisible(`a${RLO}b${ZWSP}c${TAG_A}d\u0007e`), {
    text: 'a⟨U+202E⟩b⟨U+200B⟩c⟨U+E0041⟩d⟨U+0007⟩e',
    count: 4,
  });
  // Windows content is ordinary text (#244), and so are tab and line feed.
  assert.deepEqual(revealInvisible('line 1\r\nline 2\n\tindented'), { text: 'line 1\r\nline 2\n\tindented', count: 0 });
  // A lone carriage return or a line separator is not a line ending here.
  assert.equal(revealInvisible('a\rb\u2028c').text, 'a⟨U+000D⟩b⟨U+2028⟩c');
  // A joiner inside an emoji sequence or between Persian letters stays; next
  // to ASCII it is what makes `.env` and `.env` plus a joiner look alike.
  const family = `👨${ZWJ}👩${ZWJ}👧`;
  const persian = `می${ZWNJ}خواهم`;
  assert.deepEqual(revealInvisible(`${family} ${persian}`), { text: `${family} ${persian}`, count: 0 });
  assert.equal(revealInvisible(`.env${ZWJ}`).text, '.env⟨U+200D⟩');
  assert.deepEqual(revealInvisible(''), { text: '', count: 0 });
  assert.deepEqual(revealInvisible(undefined), { text: '', count: 0 });
});

test('card: invisible characters in the command, paths, tool, stdin and argv are marked and counted, in both languages', async () => {
  const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');
  const command = `echo safe ${RLO}${LRI}; echo PWNED ${PDI} ${LRI}#${PDI}${PDF}`;
  const request = createToolApprovalRequestDto({
    requestId: 'r-bidi',
    tool: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    mode: 'smart',
    sessionAllowed: false,
    preview: { kind: 'shell', text: command, truncated: false, masked: false, shell: 'zsh', cwd: `/work/x${ZWSP}` },
  });
  assert.equal(request.preview.text, command, 'the contract passes the command on as it is');
  const { buildApprovalCardView } = await load();
  const view = buildApprovalCardView(request);
  assert.equal(view.preview.text, 'echo safe ⟨U+202E⟩⟨U+2066⟩; echo PWNED ⟨U+2069⟩ ⟨U+2066⟩#⟨U+2069⟩⟨U+202C⟩');
  assert.equal(view.cwdLabel, '/work/x⟨U+200B⟩');
  assert.equal(view.invisibleWarning,
    'This call contains 7 invisible characters that can change how its text reads. They are shown as ⟨U+…⟩ where they sit; what runs is the text with them.');
  await inGerman(async () => {
    assert.match(buildApprovalCardView(request).invisibleWarning, /^Dieser Aufruf enthält 7 unsichtbare Zeichen/);
  });

  // A path, an MCP tool's name, stdin and argv.
  const mcp = buildApprovalCardView(dto({
    tool: `mcp__srv__read${RLO}`,
    targets: [{ path: `invoice${RLO}fdp.exe`, kind: 'file', exists: false, sensitive: false }],
    sessionAllowed: false,
  }));
  assert.equal(mcp.targets[0].path, 'invoice⟨U+202E⟩fdp.exe');
  assert.equal(mcp.headline.targetLabel, 'invoice⟨U+202E⟩fdp.exe');
  assert.equal(mcp.headline.tool, 'mcp__srv__read⟨U+202E⟩');
  assert.equal(mcp.invisibleWarning,
    'This call contains 2 invisible characters that can change how its text reads. They are shown as ⟨U+…⟩ where they sit; what runs is the text with them.');
  const python = buildApprovalCardView(dto({
    tool: 'run_python',
    riskClasses: ['execute'],
    targets: [],
    sessionAllowed: false,
    preview: { kind: 'code', text: 'import sys', truncated: false, masked: false, stdin: `x${RLO}`, argv: [`y${ZWSP}`] },
  }));
  assert.deepEqual(python.preview.blocks.map((block) => block.text), ['x⟨U+202E⟩', '"y⟨U+200B⟩"']);
  assert.match(python.invisibleWarning, /^This call contains an invisible|^This call contains 2/);

  // Plain text — CRLF included — says nothing.
  const plain = buildApprovalCardView(dto({ tool: 'write_file_text', preview: { kind: 'text', text: 'a\r\nb\tc', truncated: false, masked: false } }));
  assert.equal(plain.preview.text, 'a\r\nb\tc');
  assert.equal(plain.invisibleWarning, '');
});

test('a remembered command and a session approval read on the Security page as they did on the card', async () => {
  const { describeRule, sessionGrantGroups } = await load();
  const rule = describeRule({ id: 'c1', effect: 'allow', scope: 'workspace', command: `gh pr list${RLO}`, cwd: '', networkDomains: [] });
  assert.equal(rule.pattern, 'gh pr list⟨U+202E⟩');
  assert.match(rule.text, /gh pr list⟨U\+202E⟩/);
  const [group] = sessionGrantGroups([{
    id: 'g1', chatId: 'a', current: true, tool: 'edit_file', classes: ['write'],
    scope: { key: 'approval.sessionScope.targets', params: { tool: 'edit_file', paths: `docs/a${RLO}.md`, effectKeys: [] } },
  }]);
  assert.match(group.items[0].text, /docs\/a⟨U\+202E⟩\.md/);
});
