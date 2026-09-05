// Freigabe-Schleife der Chat-Engine (Issue #66, Konzept §3–§7): Policy vor
// Ausführung, Karten, Ablehnung, Verfall, Sitzungsfreigaben, Neubewertung,
// sensible Ausgaben, Provider-Redaktion, harte Grenzen, Regeln und Audit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createChatEngine, CHAT_ENGINE_EVENTS } = require('../src/application/chat/chat-engine');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const { formatToolDisplayLine } = require('../src/shared/presentation/tool-display');

const WRITE_TOOLS = new Set(['write_file_text', 'edit_file', 'apply_patch']);
const ROOT = '/tmp/snotra-project';

function defaultPlan(toolName, args, extra = {}) {
  const riskClasses = extra.riskClasses || [WRITE_TOOLS.has(toolName) ? 'write' : 'read'];
  const targets =
    typeof args?.relative_path === 'string' && args.relative_path
      ? [{ path: args.relative_path, kind: 'file', exists: true, version: extra.version || 'v1', sensitive: extra.sensitive === true }]
      : [];
  return { tool: toolName, riskClasses, targets, planKey: JSON.stringify([toolName, args, riskClasses, extra.version || 'v1']), ...extra.plan };
}

function makeToolPort({ execute, plan } = {}) {
  const calls = [];
  const planCalls = [];
  return {
    calls,
    planCalls,
    getTools: () => [{ type: 'function', function: { name: 'list_directory' } }],
    buildSystemPrompt: () => 'Tools: list_directory',
    async plan(toolName, args, context) {
      planCalls.push({ toolName, args, context });
      return plan ? plan(toolName, args, context, planCalls.length) : defaultPlan(toolName, args);
    },
    buildTraceEntry(toolName, args, extra = {}) {
      return { tool: toolName, args, ...extra };
    },
    formatDisplayLine(entry, phase) {
      return formatToolDisplayLine(entry, phase);
    },
    async execute(toolName, args, context) {
      calls.push({ toolName, args, context });
      if (execute) return execute(toolName, args, context, calls.length);
      return { output: JSON.stringify({ ok: true }), progressEvents: [] };
    },
  };
}

function makeApprovals(answer = 'allow-once') {
  const requests = [];
  return {
    requests,
    isAvailable: () => true,
    async requestApproval({ request }) {
      requests.push(request);
      const response = typeof answer === 'function' ? await answer(request, requests.length) : answer;
      return response && typeof response === 'object' ? response : { response };
    },
  };
}

function makeWorkspacePaths() {
  return {
    resolveRoot: (raw) => (typeof raw === 'string' && raw.trim() ? path.resolve(raw.trim()) : null),
    resolveSelection: () => null,
    basename: (p) => path.basename(p),
  };
}

function assistantText(content) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: null };
}

function assistantToolCall(id, name, args) {
  return {
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    finishReason: 'tool_calls',
    usage: null,
  };
}

function makeLlmPort(results, { baseUrl } = {}) {
  let index = 0;
  const calls = [];
  return {
    calls,
    async resolveChatTarget() { return { providerId: 'test', model: 'm' }; },
    async validateTarget() { return null; },
    async prepareSendBundle(target) { return { config: baseUrl ? { baseUrl } : {}, model: target.model }; },
    async streamRound(params) {
      calls.push(params);
      const result = typeof results === 'function' ? results(params, index) : results[Math.min(index, results.length - 1)];
      index += 1;
      return result;
    },
    formatRoundError: (err) => err?.message || String(err),
  };
}

function makeEngine(results, { tools, approvals = null, toolPolicy = null, sessionGrants, preferences, llm } = {}) {
  const llmPort = llm || makeLlmPort(results);
  const toolPort = tools || makeToolPort();
  const grants = sessionGrants || createSessionGrants();
  const engine = createChatEngine({
    llm: llmPort,
    tools: toolPort,
    preferences: preferences || { async read() { return {}; } },
    workspacePaths: makeWorkspacePaths(),
    toolPolicy,
    approvals,
    sessionGrants: grants,
    maxToolRounds: 4,
  });
  return { engine, llm: llmPort, tools: toolPort, grants };
}

async function send(engine, { chatId, content = 'los', events } = {}) {
  return engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content }], workspaceRoot: ROOT, chatId },
    onEvent: events ? (event) => events.push(event) : undefined,
  });
}

function policy(overrides = {}) {
  return { async read() { return { mode: 'smart', rules: [], sensitivePathPatterns: [], policyVersion: '1:ok', ...overrides }; } };
}

test('smart: Lesen läuft ohne Karte, Schreiben fragt; vor der Freigabe keine Schreibwirkung', async () => {
  const approvals = makeApprovals(async (request) => {
    assert.equal(request.tool, 'write_file_text');
    assert.deepEqual(request.riskClasses, ['write']);
    assert.equal(request.mode, 'smart');
    assert.equal(request.sessionAllowed, true);
    assert.match(request.reason, /Dateiänderungen eine Freigabe/);
    assert.equal(tools.calls.length, 1, 'bis hier nur der Lesezugriff ausgeführt');
    return 'allow-once';
  });
  const tools = makeToolPort();
  const { engine } = makeEngine([
    assistantToolCall('c1', 'read_file_text', { relative_path: 'a.md' }),
    assistantToolCall('c2', 'write_file_text', { relative_path: 'b.md', content: 'x' }),
    assistantText('fertig'),
  ], { tools, approvals });

  const result = await send(engine);
  assert.equal(result.content, 'fertig');
  assert.equal(approvals.requests.length, 1);
  assert.deepEqual(tools.calls.map((c) => c.toolName), ['read_file_text', 'write_file_text']);
  assert.equal(tools.calls[1].context.approved, true);
  assert.deepEqual(tools.calls[1].context.riskClasses, ['write']);
  assert.equal(result.toolTrace[0].permission.decision, 'allow');
  assert.equal(result.toolTrace[0].permission.source, 'auto');
  assert.equal(result.toolTrace[1].permission.source, 'allow-once');
  assert.equal(result.toolTrace[1].permission.status, 'executed');
  assert.deepEqual(result.toolTrace[1].permission.targets, ['b.md']);
});

test('ask-all fragt auch beim Lesen; auto fragt nie', async () => {
  const approvals = makeApprovals('allow-once');
  const tools = makeToolPort();
  const { engine } = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: 'a.md' }), assistantText('ok')], {
    tools, approvals, toolPolicy: policy({ mode: 'ask-all' }),
  });
  await send(engine);
  assert.equal(approvals.requests.length, 1);
  assert.equal(approvals.requests[0].sessionAllowed, false, 'ask-all bietet keine Sitzung');

  const autoApprovals = makeApprovals('deny');
  const autoTools = makeToolPort();
  const auto = makeEngine([assistantToolCall('c1', 'write_file_text', { relative_path: '.env', content: 'x' }), assistantText('ok')], {
    tools: autoTools, approvals: autoApprovals, toolPolicy: policy({ mode: 'auto' }),
  });
  const result = await send(auto.engine);
  assert.equal(autoApprovals.requests.length, 0);
  assert.equal(autoTools.calls.length, 1);
  assert.equal(result.toolTrace[0].permission.source, 'auto');
});

test('ohne Freigabe-UI verfällt die Anfrage: kein Handler, kein weiterer Provider-Request, Ergebnis im Verlauf', async () => {
  const tools = makeToolPort();
  const events = [];
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'edit_file', { relative_path: 'a.js', old_string: 'a', new_string: 'b' }), assistantText('nie')], { tools });
  const result = await send(engine, { events });
  assert.equal(result.code, 'PERMISSION');
  assert.equal(tools.calls.length, 0);
  assert.equal(llm.calls.length, 1);
  assert.equal(result.toolTrace.length, 1);
  assert.equal(result.toolTrace[0].permission.reason, 'request_invalidated');
  assert.match(result.toolTrace[0].line, /blockiert/);
  const phases = events.filter((e) => e.type === CHAT_ENGINE_EVENTS.PROGRESS && e.payload.type === 'phase').map((e) => e.payload.phase);
  assert.equal(phases.at(-1), 'idle');
});

test('Nutzer lehnt ab: strukturiertes Ergebnis ans Modell, identischer Plan wird im Lauf nicht erneut erfragt', async () => {
  const approvals = makeApprovals('deny');
  const tools = makeToolPort();
  const args = { relative_path: 'a.md', content: 'x' };
  const { engine, llm } = makeEngine([
    assistantToolCall('c1', 'write_file_text', args),
    assistantToolCall('c2', 'write_file_text', args),
    assistantText('ok, dann nicht'),
  ], { tools, approvals });
  const result = await send(engine);
  assert.equal(result.content, 'ok, dann nicht');
  assert.equal(approvals.requests.length, 1, 'zweite identische Anfrage nicht gestellt');
  assert.equal(tools.calls.length, 0);
  const first = JSON.parse(llm.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(first.reason, 'user_denied');
  assert.equal(first.message, 'Tool-Aufruf vom Nutzer abgelehnt');
  const second = JSON.parse(llm.calls[2].messages.filter((m) => m.role === 'tool').at(-1).content);
  assert.equal(second.reason, 'repeated_denial');
  assert.match(result.toolTrace[0].line, /abgelehnt/);
});

test('Für diese Sitzung erlauben: gleiche Ziele im gleichen Chat laufen ohne Karte, anderer Chat fragt erneut', async () => {
  const approvals = makeApprovals('allow-session');
  const tools = makeToolPort();
  const grants = createSessionGrants();
  const rounds = [
    assistantToolCall('c1', 'edit_file', { relative_path: 'a.js', old_string: 'a', new_string: 'b' }),
    assistantToolCall('c2', 'edit_file', { relative_path: 'a.js', old_string: 'b', new_string: 'c' }),
    assistantToolCall('c3', 'edit_file', { relative_path: 'other.js', old_string: 'b', new_string: 'c' }),
    assistantText('ok'),
  ];
  const { engine } = makeEngine(rounds, { tools, approvals, sessionGrants: grants });
  await send(engine, { chatId: 'chat-1' });
  assert.equal(approvals.requests.length, 2, 'a.js einmal, other.js einmal');
  assert.equal(tools.calls.length, 3);
  assert.equal(grants.count(), 2);

  const second = makeEngine(rounds, { tools: makeToolPort(), approvals, sessionGrants: grants });
  await send(second.engine, { chatId: 'chat-2' });
  assert.equal(approvals.requests.length, 4, 'anderer Chat teilt keine Freigaben');
  const third = makeEngine([rounds[0], rounds[3]], { tools: makeToolPort(), approvals, sessionGrants: grants });
  await send(third.engine, { chatId: 'chat-1' });
  assert.equal(approvals.requests.length, 4, 'gleicher Chat nutzt die Freigabe');
});

test('delete/execute/external gibt es nur einmalig: allow-session wird zur Einzelfreigabe', async () => {
  const approvals = makeApprovals('allow-session');
  const grants = createSessionGrants();
  const tools = makeToolPort({ plan: (name, args) => defaultPlan(name, args, { riskClasses: ['delete'] }) });
  const { engine } = makeEngine([assistantToolCall('c1', 'write_file_text', { relative_path: 'a.md', content: 'x' }), assistantText('ok')], { tools, approvals, sessionGrants: grants });
  const result = await send(engine);
  assert.equal(approvals.requests[0].sessionAllowed, false);
  assert.equal(grants.count(), 0);
  assert.equal(result.toolTrace[0].permission.source, 'allow-once');
  assert.match(approvals.requests[0].reason, /ohne dass eine Wiederherstellungskopie/);
});

test('geänderter Plan nach der Freigabe: neu bewerten, neue Karte; bleibt es instabil, verfällt der Aufruf', async () => {
  let version = 0;
  const tools = makeToolPort({ plan: (name, args) => defaultPlan(name, args, { version: `v${(version += 1)}` }) });
  const approvals = makeApprovals('allow-once');
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'edit_file', { relative_path: 'a.js', old_string: 'a', new_string: 'b' }), assistantText('nie')], { tools, approvals });
  const result = await send(engine);
  assert.equal(result.code, 'PERMISSION', 'jede Neuplanung liefert eine andere Version');
  assert.equal(tools.calls.length, 0);
  assert.ok(approvals.requests.length >= 2, 'nach Änderung gab es eine neue Karte');
  assert.equal(llm.calls.length, 1);

  // Ändert sich die Datei nur einmal, führt die zweite Karte zur Ausführung.
  let calls = 0;
  const flaky = makeToolPort({ plan: (name, args) => defaultPlan(name, args, { version: (calls += 1) === 2 ? 'changed' : 'stable' }) });
  const okApprovals = makeApprovals('allow-once');
  const ok = makeEngine([assistantToolCall('c1', 'edit_file', { relative_path: 'a.js', old_string: 'a', new_string: 'b' }), assistantText('fertig')], { tools: flaky, approvals: okApprovals });
  const okResult = await send(ok.engine);
  assert.equal(okResult.content, 'fertig');
  assert.equal(flaky.calls.length, 1);
  assert.equal(okApprovals.requests.length, 2);
});

test('Adapter meldet geändertes Ziel bei Ausführung: Verfall ohne weiteren Provider-Request', async () => {
  const tools = makeToolPort({ execute: () => ({ output: JSON.stringify({ error: 'permission_denied', reason: 'request_invalidated' }), progressEvents: [], invalidated: true }) });
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'edit_file', { relative_path: 'a.js', old_string: 'a', new_string: 'b' }), assistantText('nie')], { tools, approvals: makeApprovals('allow-once') });
  const result = await send(engine);
  assert.equal(result.code, 'PERMISSION');
  assert.equal(llm.calls.length, 1);
});

test('Abbruch während einer offenen Karte liefert ein abgebrochenes Ergebnis ohne Ausführung', async () => {
  const tools = makeToolPort();
  let resolveCard;
  const approvals = {
    isAvailable: () => true,
    requestApproval: ({ abortSignal }) => new Promise((resolve) => {
      resolveCard = resolve;
      abortSignal.addEventListener('abort', () => resolve({ invalidated: true, reason: 'request_invalidated' }), { once: true });
    }),
  };
  const { engine } = makeEngine([assistantToolCall('c1', 'edit_file', { relative_path: 'a.js', old_string: 'a', new_string: 'b' }), assistantText('nie')], { tools, approvals });
  const pending = send(engine);
  await new Promise((r) => setTimeout(r, 5));
  engine.abort('renderer-1');
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(tools.calls.length, 0);
  assert.ok(resolveCard);
});

test('Wiederherstellungskopie schlägt fehl: Aufruf wird als delete neu bewertet und erneut erfragt', async () => {
  let attempt = 0;
  const tools = makeToolPort({
    plan: (name, args, context) => defaultPlan(name, args, { riskClasses: context.forcedClasses?.includes('delete') ? ['delete'] : ['write'] }),
    execute: (_name, _args, context) => {
      attempt += 1;
      if (attempt === 1) return { output: JSON.stringify({ error: 'kein Papierkorb', code: 'recovery_failed' }), progressEvents: [], reclassify: ['delete'] };
      assert.deepEqual(context.riskClasses, ['delete']);
      return { output: JSON.stringify({ overwritten: true }), progressEvents: [] };
    },
  });
  const approvals = makeApprovals('allow-once');
  const { engine } = makeEngine([assistantToolCall('c1', 'write_file_text', { relative_path: 'a.md', content: 'x' }), assistantText('ok')], { tools, approvals });
  const result = await send(engine);
  assert.equal(result.content, 'ok');
  assert.deepEqual(approvals.requests.map((r) => r.riskClasses), [['write'], ['delete']]);
  assert.equal(tools.calls.length, 2);
  assert.deepEqual(result.toolTrace[0].permission.riskClasses, ['delete']);
});

test('sensibler Pfad: Karte mit Provider-Hinweis, Tool-Nachricht wird markiert und Trace als sensitive geführt', async () => {
  const tools = makeToolPort({ plan: (name, args) => defaultPlan(name, args, { riskClasses: ['read', 'read-sensitive'], sensitive: true }) });
  const approvals = makeApprovals('allow-once');
  const llm = makeLlmPort([assistantToolCall('c1', 'read_file_text', { relative_path: '.env' }), assistantText('ok')], { baseUrl: 'http://localhost:11434' });
  const { engine } = makeEngine(null, { tools, approvals, llm });
  const result = await send(engine);
  assert.equal(approvals.requests[0].providerLabel, 'test (localhost:11434)');
  assert.equal(approvals.requests[0].providerKey, 'test|http://localhost:11434');
  assert.match(approvals.requests[0].reason, /Zugangsdaten enthalten.*test \(localhost:11434\)/);
  assert.equal(result.toolTrace[0].permission.sensitive, true);
  const wire = llm.calls[1].messages.find((m) => m.role === 'tool');
  assert.equal('sensitiveMarker' in wire, false, 'Marker geht nicht über die Leitung');
  assert.deepEqual(JSON.parse(wire.content), { ok: true });
});

test('zweite Prüfstelle: unerwartet sensible Ausgabe wird zurückgehalten, bis der Nutzer freigibt', async () => {
  const secret = JSON.stringify({ content: 'api_key = "abcdefgh12345678"' });
  const tools = makeToolPort({ execute: () => ({ output: secret, progressEvents: [], sensitive: true }) });

  const denied = makeApprovals('deny');
  const a = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: 'config.md' }), assistantText('ok')], { tools, approvals: denied });
  await send(a.engine);
  assert.equal(denied.requests.length, 1);
  assert.deepEqual(denied.requests[0].riskClasses, ['read-sensitive']);
  assert.match(denied.requests[0].reason, /zurückgehalten/);
  const withheld = a.llm.calls[1].messages.find((m) => m.role === 'tool').content;
  assert.equal(withheld.includes('abcdefgh12345678'), false);
  assert.equal(JSON.parse(withheld).reason, 'user_denied');

  const allowed = makeApprovals('allow-once');
  const b = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: 'config.md' }), assistantText('ok')], { tools: makeToolPort({ execute: () => ({ output: secret, progressEvents: [], sensitive: true }) }), approvals: allowed });
  const result = await send(b.engine);
  assert.equal(b.llm.calls[1].messages.find((m) => m.role === 'tool').content, secret);
  assert.equal(result.toolTrace[0].permission.sensitive, true);
  assert.deepEqual(result.toolTrace[0].permission.riskClasses, ['read', 'read-sensitive']);

  // Ohne UI: fail-safe, Inhalt bleibt im Puffer, Lauf endet.
  const c = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: 'config.md' }), assistantText('nie')], { tools: makeToolPort({ execute: () => ({ output: secret, progressEvents: [], sensitive: true }) }) });
  const failSafe = await send(c.engine);
  assert.equal(failSafe.code, 'PERMISSION');
  assert.equal(c.llm.calls.length, 1);
});

test('Provider-Redaktion: markierte Tool-Nachricht eines fremden Endpunkts wird vor dem Request ersetzt', async () => {
  const tools = makeToolPort({ plan: (name, args) => defaultPlan(name, args, { riskClasses: ['read', 'read-sensitive'], sensitive: true }) });
  const approvals = makeApprovals('allow-once');
  const events = [];
  // Der Provider-Schlüssel dieses Laufs ist „test“; die Markierung wird bei der
  // Ausführung mit demselben Schlüssel gesetzt, also nicht redigiert …
  const same = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: '.env' }), assistantText('ok')], { tools, approvals });
  await send(same.engine, { events });
  assert.equal(events.some((e) => e.payload?.type === 'permission' && e.payload.event === 'redacted'), false);

  // … aber ein Wechsel des Endpunkts zwischen den Runden redigiert sie.
  let round = 0;
  const switching = {
    calls: [],
    async resolveChatTarget() { return { providerId: 'test', model: 'm' }; },
    async validateTarget() { return null; },
    async prepareSendBundle() { return { config: {}, model: 'm' }; },
    async streamRound(params) {
      this.calls.push(params);
      round += 1;
      if (round === 1) return assistantToolCall('c1', 'read_file_text', { relative_path: '.env' });
      return assistantText('ok');
    },
    formatRoundError: (e) => String(e),
  };
  const tampered = makeToolPort({ plan: (name, args) => defaultPlan(name, args, { riskClasses: ['read', 'read-sensitive'], sensitive: true }) });
  const { redactSensitiveToolMessages } = require('../src/application/permissions/sensitive-redaction');
  const messages = [{ role: 'tool', tool_call_id: 'x', content: '{"geheim":1}', sensitiveMarker: { sensitive: true, providerKey: 'anderer', targets: [] } }];
  assert.equal(redactSensitiveToolMessages(messages, 'test'), 1);
  assert.match(messages[0].content, /zurückgehalten/);
  assert.ok(switching && tampered);
});

test('harte Grenzen und Sperr-Regeln blockieren in jedem Modus, auch mit Freigabe-UI', async () => {
  const approvals = makeApprovals('allow-once');
  for (const mode of ['smart', 'ask-all', 'auto']) {
    const tools = makeToolPort({ plan: (name, args) => ({ ...defaultPlan(name, args), hardLimit: { reason: 'hard_limit' } }) });
    const { engine, llm } = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: '../x' }), assistantText('ok')], { tools, approvals, toolPolicy: policy({ mode }) });
    const result = await send(engine);
    assert.equal(tools.calls.length, 0, mode);
    assert.equal(JSON.parse(llm.calls[1].messages.find((m) => m.role === 'tool').content).reason, 'hard_limit');
    assert.equal(result.toolTrace[0].permission.reason, 'hard_limit');
  }
  assert.equal(approvals.requests.length, 0);

  const rules = [{ id: 'lock', effect: 'deny', scope: 'global', root: null, tool: 'edit_file', riskClass: null, pathPattern: 'src/**', createdAt: 0 }];
  const tools = makeToolPort();
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'edit_file', { relative_path: 'src/a.js', old_string: 'a', new_string: 'b' }), assistantText('ok')], { tools, approvals, toolPolicy: policy({ mode: 'auto', rules }) });
  const result = await send(engine);
  assert.equal(tools.calls.length, 0);
  const denied = JSON.parse(llm.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(denied.reason, 'policy_denied');
  assert.equal(denied.rule_id, 'lock');
  assert.equal(result.toolTrace[0].permission.ruleId, 'lock');
});

test('deaktivierte Tools, ungültige Argumente und Plan-Fehler blockieren ohne Handler und ohne Karte', async () => {
  const approvals = makeApprovals('allow-once');
  const tools = makeToolPort();
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'debug_wait', {}), assistantText('ok')], {
    tools, approvals, preferences: { async read() { return { disabledTools: ['debug_wait'] }; } },
  });
  await send(engine);
  assert.equal(tools.calls.length, 0);
  assert.equal(JSON.parse(llm.calls[1].messages.find((m) => m.role === 'tool').content).reason, 'tool_disabled');

  const broken = makeToolPort({ plan: () => ({ error: 'relative_path ist erforderlich.', reason: 'invalid_arguments', riskClasses: ['read'], targets: [] }) });
  const b = makeEngine([assistantToolCall('c1', 'read_file_text', {}), assistantText('ok')], { tools: broken, approvals });
  await send(b.engine);
  const msg = JSON.parse(b.llm.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(msg.reason, 'invalid_arguments');
  assert.equal(msg.message, 'relative_path ist erforderlich.');
  assert.equal(approvals.requests.length, 0);
});

test('unlesbare Berechtigungsregeln blockieren Tools statt Sperren zu verlieren', async () => {
  const tools = makeToolPort();
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: 'a.md' }), assistantText('ok')], {
    tools, approvals: makeApprovals('allow-once'), toolPolicy: { async read() { throw new Error('kaputt'); } },
  });
  await send(engine);
  assert.equal(tools.calls.length, 0);
  const msg = JSON.parse(llm.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(msg.reason, 'policy_denied');
  assert.match(msg.message, /nicht lesbar/);
});

test('eigene Provider-Secrets in der Ausgabe: harte Grenze, Ausgabe ersetzt', async () => {
  const tools = makeToolPort({ execute: () => ({ output: JSON.stringify({ error: 'permission_denied', reason: 'own_secret' }), progressEvents: [], hardLimit: { reason: 'own_secret' } }) });
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: 'own.txt' }), assistantText('ok')], { tools, toolPolicy: policy({ mode: 'auto' }) });
  const result = await send(engine);
  assert.equal(JSON.parse(llm.calls[1].messages.find((m) => m.role === 'tool').content).reason, 'own_secret');
  assert.equal(result.toolTrace[0].permission.reason, 'own_secret');
});

test('Permission-Progress-Events melden Warten und Entscheidung mit Aufruf-Index', async () => {
  const events = [];
  const { engine } = makeEngine([assistantToolCall('c1', 'edit_file', { relative_path: 'a.js', old_string: 'a', new_string: 'b' }), assistantText('ok')], { approvals: makeApprovals('allow-once') });
  await send(engine, { events });
  const permission = events.filter((e) => e.type === CHAT_ENGINE_EVENTS.PROGRESS && e.payload.type === 'permission').map((e) => e.payload);
  assert.deepEqual(permission, [
    { type: 'permission', event: 'awaiting', callIndex: 0, tool: 'edit_file' },
    { type: 'permission', event: 'resolved', callIndex: 0, tool: 'edit_file', response: 'allow-once' },
  ]);
});
