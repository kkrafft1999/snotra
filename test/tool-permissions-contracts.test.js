// Verträge der Tool-Berechtigungen (Issue #66): Klassen, Modi, Regeln,
// Ablehnungsergebnis, Freigabe-DTO und Audit-Eintrag.

const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../src/shared/contracts');
const {
  TOOL_RISK_CLASSES,
  TOOL_RISK_CLASS_ORDER,
  TOOL_PERMISSION_MODES,
  PERMISSION_DENIAL_REASONS,
  normalizeToolPermissionMode,
  normalizeRiskClasses,
  normalizeRulePathPattern,
  normalizePermissionRule,
  normalizePermissionRules,
  normalizeSensitivePathPatterns,
  normalizeApprovalResponse,
  createPermissionDeniedToolResult,
  parsePermissionDeniedToolResult,
  createToolApprovalRequestDto,
  isToolApprovalRequestDto,
  normalizeToolApprovalResponse,
  createPermissionAuditEntry,
} = require('../src/shared/contracts/tool-permissions');

test('Contracts-Index exportiert die Berechtigungsverträge für Main und Renderer', () => {
  assert.equal(contracts.TOOL_RISK_CLASSES.READ_SENSITIVE, 'read-sensitive');
  assert.equal(contracts.TOOL_PERMISSION_MODES.ASK_ALL, 'ask-all');
  assert.equal(contracts.DEFAULT_TOOL_PERMISSION_MODE, 'smart');
  assert.equal(contracts.PERMISSION_PROGRESS_EVENTS.AWAITING, 'awaiting');
  assert.equal(contracts.CHAT_ERROR_CODES.PERMISSION, 'PERMISSION');
  assert.equal(typeof contracts.createPermissionDeniedToolResult, 'function');
});

test('sechs Risikoklassen in fester Reihenfolge; unbekannte Klassen blockieren statt read zu werden', () => {
  assert.deepEqual(TOOL_RISK_CLASS_ORDER, ['read', 'read-sensitive', 'write', 'delete', 'execute', 'external']);
  assert.deepEqual(normalizeRiskClasses(['write', 'read', 'write']), ['read', 'write']);
  assert.equal(normalizeRiskClasses(['read', 'shell']), null);
  assert.equal(normalizeRiskClasses('read'), null);
  assert.deepEqual(normalizeRiskClasses([]), []);
});

test('unbekannter Modus ergibt smart', () => {
  assert.equal(normalizeToolPermissionMode('auto'), 'auto');
  assert.equal(normalizeToolPermissionMode('ask-all'), 'ask-all');
  assert.equal(normalizeToolPermissionMode('yolo'), 'smart');
  assert.equal(normalizeToolPermissionMode(undefined), 'smart');
});

test('Pfadmuster werden normalisiert; Ausbrüche und Steuerzeichen fallen durch', () => {
  assert.equal(normalizeRulePathPattern(''), '**');
  assert.equal(normalizeRulePathPattern('.'), '**');
  assert.equal(normalizeRulePathPattern('./src\\lib//*.js/'), 'src/lib/*.js');
  assert.equal(normalizeRulePathPattern('../secret'), null);
  assert.equal(normalizeRulePathPattern('a\u0000b'), '**', 'Steuerzeichen → wie leer → alles');
  assert.equal(normalizeRulePathPattern('x'.repeat(500)), '**');
});

test('Regeln brauchen genau ein Ziel (Tool oder Klasse) und einen gültigen Effekt', () => {
  const ok = normalizePermissionRule({ id: 'r1', effect: 'deny', tool: 'write_file_text', pathPattern: 'src/**' });
  assert.deepEqual(ok, {
    id: 'r1',
    effect: 'deny',
    scope: 'global',
    root: null,
    tool: 'write_file_text',
    riskClass: null,
    pathPattern: 'src/**',
    createdAt: 0,
  });
  assert.equal(normalizePermissionRule({ id: 'r2', effect: 'deny' }), null, 'weder Tool noch Klasse');
  assert.equal(
    normalizePermissionRule({ id: 'r3', effect: 'deny', tool: 'x', riskClass: 'read' }),
    null,
    'Tool und Klasse zugleich'
  );
  assert.equal(normalizePermissionRule({ id: 'r4', effect: 'maybe', tool: 'x' }), null);
  assert.equal(normalizePermissionRule({ effect: 'deny', tool: 'x' }), null, 'ohne ID');
  assert.equal(
    normalizePermissionRule({ id: 'r5', effect: 'deny', scope: 'workspace', tool: 'x' }),
    null,
    'Workspace-Regel ohne Wurzel'
  );
  const ws = normalizePermissionRule({ id: 'r6', effect: 'allow', scope: 'workspace', root: '/p', riskClass: 'read' });
  assert.equal(ws.root, '/p');
  assert.equal(ws.pathPattern, '**');
});

test('dauerhafte Allow-Regeln gibt es nur für read und write (Konzept §7)', () => {
  for (const cls of ['read', 'write']) {
    assert.ok(normalizePermissionRule({ id: cls, effect: 'allow', riskClass: cls }), cls);
  }
  for (const cls of ['read-sensitive', 'delete', 'execute', 'external']) {
    assert.equal(normalizePermissionRule({ id: cls, effect: 'allow', riskClass: cls }), null, cls);
    assert.ok(normalizePermissionRule({ id: cls, effect: 'deny', riskClass: cls }), `deny ${cls}`);
  }
});

test('Regellisten deduplizieren IDs und verwerfen kaputte Einträge', () => {
  const rules = normalizePermissionRules([
    { id: 'a', effect: 'deny', tool: 'x' },
    { id: 'a', effect: 'allow', tool: 'y' },
    { id: 'b', effect: 'nope', tool: 'x' },
    null,
    { id: 'c', effect: 'allow', riskClass: 'read', pathPattern: 'docs/**' },
  ]);
  assert.deepEqual(rules.map((r) => r.id), ['a', 'c']);
  assert.equal(rules[0].effect, 'deny', 'die erste Regel gewinnt bei doppelter ID');
});

test('sensible Pfadmuster: bereinigt, dedupliziert, kein Alles-Muster', () => {
  assert.deepEqual(normalizeSensitivePathPatterns(['personal/**', './personal/**', '**', '', 'a/../b', 42, 'notes/*.md']), [
    'personal/**',
    'notes/*.md',
  ]);
  assert.deepEqual(normalizeSensitivePathPatterns('personal/**'), []);
});

test('Ablehnungsergebnis ist strukturiert, kennt nur bekannte Gründe und trägt nie Argumente', () => {
  const denied = JSON.parse(
    createPermissionDeniedToolResult({ reason: 'user_denied', ruleId: 'r1', riskClasses: ['write', 'read'] })
  );
  assert.deepEqual(denied, {
    error: 'permission_denied',
    reason: 'user_denied',
    message: 'Tool call denied by the user.',
    rule_id: 'r1',
    risk_classes: ['read', 'write'],
  });
  const unknown = JSON.parse(createPermissionDeniedToolResult({ reason: 'made_up' }));
  assert.equal(unknown.reason, PERMISSION_DENIAL_REASONS.POLICY_DENIED);
  assert.ok(unknown.message.length > 0);
  const custom = JSON.parse(createPermissionDeniedToolResult({ reason: 'hard_limit', message: '  Ausbruch  ' }));
  assert.equal(custom.message, 'Ausbruch');

  assert.equal(parsePermissionDeniedToolResult(createPermissionDeniedToolResult({ reason: 'hard_limit' })).reason, 'hard_limit');
  assert.equal(parsePermissionDeniedToolResult(JSON.stringify({ error: 'x' })), null);
  assert.equal(parsePermissionDeniedToolResult('kein json'), null);
});

test('Freigabe-DTO ist versioniert und enthält nur bereinigte Daten', () => {
  const dto = createToolApprovalRequestDto({
    requestId: 'req-1',
    tool: 'write_file_text',
    riskClasses: ['write'],
    targets: [{ path: 'a.md', kind: 'file', exists: true, sensitive: false, absPath: '/geheim/a.md', version: '1:2' }],
    reason: 'weil',
    mode: 'smart',
    sessionAllowed: true,
    sessionScopeLabel: 'Gilt für a.md',
    preview: { kind: 'text', text: 'hallo', truncated: false, masked: true },
  });
  assert.equal(isToolApprovalRequestDto(dto), true);
  assert.equal(dto.contractVersion, 1);
  assert.deepEqual(dto.targets, [{ path: 'a.md', kind: 'file', exists: true, sensitive: false, version: '1:2' }]);
  assert.equal('absPath' in dto.targets[0], false, 'absolute Pfade bleiben im Main');
  assert.deepEqual(dto.preview, { kind: 'text', text: 'hallo', truncated: false, masked: true });
  assert.equal(isToolApprovalRequestDto({ requestId: 'x' }), false);
});

test('Antwort des Renderers: nur requestId und bekannte Entscheidung', () => {
  assert.deepEqual(normalizeToolApprovalResponse({ requestId: ' r ', response: 'allow-once' }), {
    requestId: 'r',
    response: 'allow-once',
  });
  assert.equal(normalizeToolApprovalResponse({ requestId: 'r', response: 'allow-forever' }), null);
  assert.equal(normalizeToolApprovalResponse({ requestId: '', response: 'deny' }), null);
  assert.equal(normalizeToolApprovalResponse({ requestId: 'r', response: 'deny', args: { x: 1 } }).args, undefined);
  assert.equal(normalizeApprovalResponse('deny'), 'deny');
  assert.equal(normalizeApprovalResponse('yes'), null);
});

test('Audit-Eintrag enthält Entscheidung, Klassen, Modus, Status und Zielpfade, aber keine Inhalte', () => {
  const entry = createPermissionAuditEntry({
    decision: 'allow',
    source: 'allow-once',
    riskClasses: ['write'],
    mode: 'smart',
    status: 'executed',
    targets: [{ path: 'a.md', absPath: '/x/a.md', content: 'geheim' }, 'b.md'],
  });
  assert.deepEqual(entry, {
    decision: 'allow',
    status: 'executed',
    mode: 'smart',
    riskClasses: ['write'],
    source: 'allow-once',
    targets: ['a.md', 'b.md'],
  });
  const fallback = createPermissionAuditEntry({ decision: 'nope', status: 'unknown', mode: 'x' });
  assert.equal(fallback.decision, 'deny');
  assert.equal(fallback.status, 'denied');
  assert.equal(fallback.mode, TOOL_PERMISSION_MODES.SMART);
  assert.equal(TOOL_RISK_CLASSES.EXTERNAL, 'external');
});
