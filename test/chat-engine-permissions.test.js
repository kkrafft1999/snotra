// Freigabe-Schleife der Chat-Engine (Issue #66, Konzept §3–§7): Policy vor
// Ausführung, Karten, Ablehnung, Verfall, Sitzungsfreigaben, Neubewertung,
// sensible Ausgaben, Provider-Redaktion, harte Grenzen, Regeln und Audit.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createChatEngine, CHAT_ENGINE_EVENTS } = require('../src/application/chat/chat-engine');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const { formatToolDisplayLine } = require('../src/shared/presentation/tool-display');

const { translateMessage } = require('../src/shared/i18n');

// Die Begruendung der Karte reist seit #290 als Schluesselliste; zum Pruefen
// des Wortlauts wird sie hier ausgesprochen.
const reasonText = (request, locale = 'de') =>
  (request.reasonParts || []).map((m) => translateMessage(locale, m)).join(' ');

// Dasselbe fuer den Hinweis an den Nutzer, wenn der Lauf endet (#306).
const errorText = (result, locale = 'de') => translateMessage(locale, result.error);

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
    assert.match(reasonText(request), /Dateiänderungen eine Freigabe/);
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
  assert.match(result.toolTrace[0].line, /blocked/);
  const phases = events.filter((e) => e.type === CHAT_ENGINE_EVENTS.PROGRESS && e.payload.type === 'phase').map((e) => e.payload.phase);
  assert.equal(phases.at(-1), 'idle');
});

test('Nutzer lehnt ab: strukturiertes Ergebnis ans Modell, Lauf geht mit der Ablehnung weiter', async () => {
  const approvals = makeApprovals('deny');
  const tools = makeToolPort();
  const { engine, llm } = makeEngine([
    assistantToolCall('c1', 'write_file_text', { relative_path: 'a.md', content: 'x' }),
    assistantText('ok, dann nicht'),
  ], { tools, approvals });
  const result = await send(engine);
  assert.equal(result.content, 'ok, dann nicht');
  assert.equal(approvals.requests.length, 1);
  assert.equal(tools.calls.length, 0);
  const first = JSON.parse(llm.calls[1].messages.find((m) => m.role === 'tool').content);
  assert.equal(first.reason, 'user_denied');
  assert.equal(first.message, 'Tool call denied by the user.');
  assert.match(result.toolTrace[0].line, /denied/);
});

test('identischer Plan nach Ablehnung: keine zweite Karte, Lauf endet ohne weiteren Provider-Request', async () => {
  const approvals = makeApprovals('deny');
  const tools = makeToolPort();
  const events = [];
  const args = { relative_path: 'a.md', content: 'x' };
  const { engine, llm } = makeEngine([
    assistantToolCall('c1', 'write_file_text', args),
    assistantToolCall('c2', 'write_file_text', args),
    assistantText('nie'),
  ], { tools, approvals });
  const result = await send(engine, { events });
  assert.equal(result.code, 'PERMISSION');
  assert.match(errorText(result), /bereits abgelehnten Tool-Aufruf/);
  assert.match(errorText(result, 'en'), /had already been denied/);
  assert.equal(approvals.requests.length, 1, 'zweite identische Anfrage nicht gestellt');
  assert.equal(tools.calls.length, 0);
  assert.equal(llm.calls.length, 2, 'nach der Wiederholung kein weiterer Provider-Request');
  assert.equal(result.toolTrace.length, 2);
  assert.equal(result.toolTrace[0].permission.reason, 'user_denied');
  assert.equal(result.toolTrace[1].permission.reason, 'repeated_denial');
  assert.equal(result.toolTrace[1].permission.status, 'denied');
  const phases = events.filter((e) => e.type === CHAT_ENGINE_EVENTS.PROGRESS && e.payload.type === 'phase').map((e) => e.payload.phase);
  assert.equal(phases.at(-1), 'idle');
});

test('geänderter Plan nach Ablehnung ist keine Wiederholung: neue Karte, Lauf geht weiter', async () => {
  const approvals = makeApprovals('deny');
  const tools = makeToolPort();
  const { engine } = makeEngine([
    assistantToolCall('c1', 'write_file_text', { relative_path: 'a.md', content: 'x' }),
    assistantToolCall('c2', 'write_file_text', { relative_path: 'b.md', content: 'x' }),
    assistantText('gut'),
  ], { tools, approvals });
  const result = await send(engine);
  assert.equal(result.content, 'gut');
  assert.equal(approvals.requests.length, 2, 'anderes Ziel wird erneut erfragt');
  assert.equal(tools.calls.length, 0);
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
  // The approval keeps the card's sentence and its chat for the settings (#447).
  const [listed] = grants.list();
  assert.equal(listed.chatId, 'chat-1');
  assert.equal(listed.tool, 'edit_file');
  assert.equal(listed.scope?.key, 'approval.sessionScope.targets');
  assert.ok(Number.isFinite(listed.grantedAt));

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
  assert.match(reasonText(approvals.requests[0]), /ohne dass eine Wiederherstellungskopie/);
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
  assert.match(reasonText(approvals.requests[0]), /Zugangsdaten enthalten.*test \(localhost:11434\)/);
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
  assert.match(reasonText(denied.requests[0]), /zurückgehalten/);
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
  assert.match(messages[0].content, /withheld/);
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
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'web_search', {}), assistantText('ok')], {
    tools, approvals, preferences: { async read() { return { disabledTools: ['web_search'] }; } },
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

// #552: list_directory and load_skill could be switched off before #195. The
// stored name stays, but no longer counts — the settings do not list the two
// any more, so a refusal could never be lifted.
test('a stale switch-off does not refuse the basic equipment (#552)', async () => {
  const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
  const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
  const listed = [];
  const fsService = {
    async runListDirectoryTool(args) {
      listed.push(args);
      return JSON.stringify({ entries: [] });
    },
  };
  const tools = createWorkspaceToolAdapter(createWorkspaceToolRegistry({ fsService }));
  const preferences = { async read() { return { disabledTools: ['list_directory', 'web_search'] }; } };
  const { engine, llm } = makeEngine([assistantToolCall('c1', 'list_directory', {}), assistantText('ok')], {
    tools, preferences, toolPolicy: policy({ mode: 'auto' }),
  });
  const result = await send(engine);
  assert.equal(listed.length, 1);
  assert.deepEqual(JSON.parse(llm.calls[1].messages.find((m) => m.role === 'tool').content), { entries: [] });
  assert.equal(result.toolTrace[0].permission.status, 'executed');
  // An ordinary tool in the same list stays switched off.
  assert.equal(tools.isSwitchedOff('web_search', ['list_directory', 'web_search']), true);
  assert.equal(tools.isSwitchedOff('list_directory', ['list_directory', 'web_search']), false);
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
  assert.match(msg.message, /cannot be read/);
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

// Decision on #357: with the sandbox switched off for the workspace, "Auto"
// still runs execution tools without a card. The red mode pill carries the
// warning instead (see sandbox-opt-out.test.js).
test('auto with the sandbox switched off for the workspace runs execute without a card (#357)', async () => {
  const approvals = makeApprovals('deny');
  const tools = makeToolPort({
    plan: (toolName, args) => defaultPlan(toolName, args, {
      riskClasses: ['execute'],
      plan: { sandbox: { disabled: true, root: ROOT }, preview: { kind: 'shell', text: 'gh pr list', isolation: { isolated: false, reason: 'workspace', missing: [] } } },
    }),
  });
  const { engine } = makeEngine([assistantToolCall('c1', 'shell_execute', { command: 'gh pr list' }), assistantText('ok')], {
    tools, approvals, toolPolicy: policy({ mode: 'auto' }),
  });
  const result = await send(engine);
  assert.equal(approvals.requests.length, 0);
  assert.equal(tools.calls.length, 1);
  assert.equal(tools.calls[0].context.plan.sandbox.disabled, true, 'the approved plan reaches the handler');
  assert.equal(result.toolTrace[0].permission.source, 'auto');

  // In "Smart" the same call gets its card, as every execution does.
  const smartApprovals = makeApprovals('allow-once');
  const smart = makeEngine([assistantToolCall('c1', 'shell_execute', { command: 'gh pr list' }), assistantText('ok')], {
    tools, approvals: smartApprovals, toolPolicy: policy({ mode: 'smart' }),
  });
  await send(smart.engine);
  assert.equal(smartApprovals.requests.length, 1);
  assert.deepEqual(smartApprovals.requests[0].preview.isolation, { isolated: false, reason: 'workspace', missing: [] });
});

// ── Remembered shell commands (#121) ─────────────────────────────────────────

function shellPlan(toolName, args) {
  return {
    tool: toolName,
    riskClasses: ['execute'],
    targets: [],
    planKey: JSON.stringify([toolName, args]),
    shellCommand: { command: args.command, cwd: '', networkDomains: [], stdin: false },
  };
}

test('a remembered command runs without a card and is audited as an allowance rule', async () => {
  const tools = makeToolPort({ plan: shellPlan });
  const approvals = makeApprovals('allow-once');
  const rule = {
    id: 'cmd-1', effect: 'allow', scope: 'workspace', root: path.resolve(ROOT), tool: 'shell_execute',
    riskClass: null, pathPattern: '**', command: 'git status', cwd: '', networkDomains: [],
  };
  const { engine } = makeEngine(
    [assistantToolCall('c1', 'shell_execute', { command: 'git status' }), assistantToolCall('c2', 'shell_execute', { command: 'git status --short' }), assistantText('fertig')],
    { tools, approvals, toolPolicy: policy({ rules: [rule] }) }
  );
  const result = await send(engine);
  assert.equal(tools.calls.length, 2);
  // Only the call that differs from the remembered line asks.
  assert.equal(approvals.requests.length, 1);
  assert.equal(approvals.requests[0].preview, undefined);
  const [first, second] = result.toolTrace;
  assert.equal(first.permission.source, 'allow-rule');
  assert.equal(first.permission.ruleId, 'cmd-1');
  assert.equal(second.permission.source, 'allow-once');
});

test('"always" on the card runs the call and records the new rule; the card offer carries the rule', async () => {
  const tools = makeToolPort({ plan: shellPlan });
  const approvals = makeApprovals(() => ({ response: 'allow-always', ruleId: 'new-rule' }));
  const { engine } = makeEngine(
    [assistantToolCall('c1', 'shell_execute', { command: 'npm test' }), assistantText('fertig')],
    { tools, approvals, toolPolicy: policy({ encryptionAvailable: true }) }
  );
  const result = await send(engine);
  assert.equal(tools.calls.length, 1);
  const [card] = approvals.requests;
  assert.equal(card.alwaysAllowed, true);
  assert.equal(card.commandRule.command, 'npm test');
  assert.equal(card.commandRule.root, path.resolve(ROOT));
  assert.equal(result.toolTrace[0].permission.source, 'allow-rule');
  assert.equal(result.toolTrace[0].permission.ruleId, 'new-rule');
});

test('without secure storage the card does not offer to remember a command', async () => {
  const tools = makeToolPort({ plan: shellPlan });
  const approvals = makeApprovals('allow-once');
  const { engine } = makeEngine(
    [assistantToolCall('c1', 'shell_execute', { command: 'npm test' }), assistantText('fertig')],
    { tools, approvals, toolPolicy: policy({ encryptionAvailable: false }) }
  );
  await send(engine);
  assert.equal(approvals.requests[0].alwaysAllowed, false);
  assert.equal(approvals.requests[0].alwaysUnavailableReason, 'no-encryption');
});

// #525: the user's sensitive path patterns reach the broad tools, not only the
// planner — against the real fs service, registry and adapter.
test('broad searches leave out hits under a user-defined sensitive pattern (#525)', async () => {
  const fs = require('fs/promises');
  const os = require('os');
  const { createFsService } = require('../src/main/services/fs-service');
  const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
  const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');

  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-525-'));
  try {
    await fs.mkdir(path.join(ws, 'personal'));
    await fs.writeFile(path.join(ws, 'personal', 'diary.txt'), 'salary review: 95k\n');
    await fs.writeFile(path.join(ws, 'notes.txt'), 'salary bands are public\n');
    const fsService = createFsService({ fs, path, maxReadFileBytes: 1e6, maxWriteFileBytes: 1e6 });
    const tools = createWorkspaceToolAdapter(createWorkspaceToolRegistry({ fsService }), { fsService, fs, path });
    const llm = makeLlmPort([
      assistantToolCall('s', 'search_in_files', { query: 'salary', relative_path: '.' }),
      assistantToolCall('f', 'find_files', { pattern: '**/*.txt' }),
      assistantText('done'),
    ]);
    const approvals = makeApprovals('deny');
    const engine = createChatEngine({
      llm,
      tools,
      preferences: { async read() { return {}; } },
      workspacePaths: makeWorkspacePaths(),
      toolPolicy: policy({ sensitivePathPatterns: ['personal/**'] }),
      approvals,
      maxToolRounds: 4,
    });
    await engine.send({
      sessionId: 'renderer-1',
      payload: { messages: [{ role: 'user', content: 'search' }], workspaceRoot: ws },
    });
    const toolMessages = llm.calls[2].messages.filter((m) => m.role === 'tool').map((m) => m.content);
    assert.equal(toolMessages.length, 2);
    assert.match(toolMessages[0], /notes\.txt/);
    assert.match(toolMessages[1], /notes\.txt/);
    for (const content of toolMessages) {
      assert.doesNotMatch(content, /diary|95k/, 'the hit under the user pattern stays out');
    }
    assert.equal(approvals.requests.length, 0, 'leaving a hit out asks nothing');
  } finally {
    await fs.rm(ws, { recursive: true, force: true });
  }
});

test('the execute context carries the policy\'s sensitive path patterns (#525)', async () => {
  const tools = makeToolPort();
  const { engine } = makeEngine([assistantToolCall('c1', 'read_file_text', { relative_path: 'a.md' }), assistantText('ok')], {
    tools, toolPolicy: policy({ sensitivePathPatterns: ['private/**'] }),
  });
  await send(engine);
  assert.deepEqual(tools.calls[0].context.sensitivePathPatterns, ['private/**']);
});

// #526: the output checkpoint ends the run on a repeated plan as the access
// checkpoint does — and does not run the call again to find out.
test('a repeated call whose sensitive output was withheld is not run again and ends the run (#526)', async () => {
  const secret = JSON.stringify({ content: 'TOKEN=abcdef1234567890' });
  const tools = makeToolPort({ execute: () => ({ output: secret, progressEvents: [], sensitive: true }) });
  const approvals = makeApprovals('deny');
  const events = [];
  const args = { relative_path: 'config.md' };
  const { engine, llm } = makeEngine([
    assistantToolCall('c1', 'read_file_text', args),
    assistantToolCall('c2', 'read_file_text', args),
    assistantText('never'),
  ], { tools, approvals });
  const result = await send(engine, { events });
  assert.equal(tools.calls.length, 1, 'the call ran once, for the first output check');
  assert.equal(approvals.requests.length, 1, 'no second card');
  assert.equal(llm.calls.length, 2, 'no provider request after the repetition');
  assert.equal(result.code, 'PERMISSION');
  assert.match(errorText(result, 'en'), /had already been denied/);
  assert.equal(result.toolTrace[0].permission.reason, 'user_denied');
  assert.equal(result.toolTrace[1].permission.reason, 'repeated_denial');
  for (const message of llm.calls[1].messages) {
    assert.equal(String(message.content).includes('abcdef1234567890'), false);
  }
});

test('a withheld output does not block a different call (#526)', async () => {
  const tools = makeToolPort({
    execute: (name, args) => ({ output: JSON.stringify({ path: args.relative_path }), progressEvents: [], sensitive: args.relative_path === 'secret.md' }),
  });
  const approvals = makeApprovals('deny');
  const { engine, llm } = makeEngine([
    assistantToolCall('c1', 'read_file_text', { relative_path: 'secret.md' }),
    assistantToolCall('c2', 'read_file_text', { relative_path: 'other.md' }),
    assistantText('ok'),
  ], { tools, approvals });
  const result = await send(engine);
  assert.equal(result.content, 'ok');
  assert.equal(tools.calls.length, 2);
  assert.equal(llm.calls.length, 3);
});

// #532: an answer that is none of the four allows nothing.
test('an approval answer outside the four responses invalidates the request (#532)', async () => {
  for (const outcome of [{}, { response: 'yes' }, { response: null }]) {
    const tools = makeToolPort();
    const { engine, llm } = makeEngine([
      assistantToolCall('c1', 'write_file_text', { relative_path: 'a.md', content: 'x' }),
      assistantText('never'),
    ], { tools, approvals: makeApprovals(() => outcome) });
    const result = await send(engine);
    assert.equal(tools.calls.length, 0, `${JSON.stringify(outcome)} must not run the write`);
    assert.equal(result.code, 'PERMISSION');
    assert.equal(result.toolTrace[0].permission.reason, 'request_invalidated');
    assert.equal(llm.calls.length, 1);
  }
});

test('a wider answer than the card offered still counts as once (#532)', async () => {
  const tools = makeToolPort();
  const { engine, grants } = makeEngine([
    assistantToolCall('c1', 'write_file_text', { relative_path: 'a.md', content: 'x' }),
    assistantText('ok'),
  ], { tools, approvals: makeApprovals('allow-always') });
  const result = await send(engine);
  assert.equal(tools.calls.length, 1);
  assert.equal(result.toolTrace[0].permission.source, 'allow-once');
  assert.equal(grants.count(), 0);
});

// ── The sandbox card after a run (#792) ─────────────────────────────────────

const CACHE = '/home/u/.cache/prisma/engines';
function blockedRun({ exitCode = 1, allow = [CACHE, '/home/u/.cache/prisma'], kind = 'write', target = CACHE } = {}) {
  return {
    output: JSON.stringify({ stdout: '', stderr: 'EPERM\n\n<sandbox_blocked>\n…\n</sandbox_blocked>\n', exit_code: exitCode, duration_ms: 2400 }),
    progressEvents: [],
    sandboxBlocked: {
      entries: [{ kind, target, count: 1, operations: ['file-write-create'], ...(allow ? { allow } : {}) }],
      moreEntries: 0,
      total: 1,
      raw: [`node(1) deny(1) file-write-create ${target}`],
    },
  };
}
const okRun = () => ({ output: JSON.stringify({ stdout: 'done', stderr: '', exit_code: 0, duration_ms: 900 }), progressEvents: [] });
const sandboxRequests = (approvals) => approvals.requests.filter((r) => r.checkpoint === 'sandbox');
const toolMessageOf = (llm) => llm.calls.at(-1).messages.find((m) => m.role === 'tool');

test('sandbox card: asks even in Auto, then runs the command again with the folder it opened', async () => {
  const approvals = makeApprovals((request) => {
    assert.equal(request.checkpoint, 'sandbox');
    assert.equal(request.mode, 'auto');
    assert.deepEqual(request.riskClasses, ['write']);
    assert.equal(request.sessionAllowed, true);
    assert.deepEqual(request.sandbox.entries, [{ kind: 'write', target: CACHE, count: 1, folder: false, allow: [CACHE, '/home/u/.cache/prisma'] }]);
    assert.deepEqual(request.sandbox.run, { exitCode: 1, durationMs: 2400, timedOut: false });
    assert.equal(request.sandbox.output, 'EPERM', 'the sandbox block itself is not the command\'s report');
    return { response: 'allow-once', sandboxPaths: ['/home/u/.cache/prisma'] };
  });
  const tools = makeToolPort({ execute: (name, args, ctx, n) => (n === 1 ? blockedRun() : okRun()) });
  const llm = makeLlmPort([assistantToolCall('c1', 'shell_execute', { command: 'npx prisma generate' }), assistantText('fertig')]);
  const { engine } = makeEngine(null, { tools, approvals, llm, toolPolicy: policy({ mode: 'auto' }) });

  const result = await send(engine);

  assert.equal(result.content, 'fertig');
  assert.equal(sandboxRequests(approvals).length, 1);
  assert.equal(tools.calls.length, 2, 'once, and once again after the card');
  assert.equal(tools.calls[0].context.sandboxGrants, null);
  assert.deepEqual(tools.calls[1].context.sandboxGrants, { writePaths: ['/home/u/.cache/prisma'], readPaths: [], hosts: [] });
  const entry = result.toolTrace[0];
  assert.equal(entry.sandboxBlocked.entries[0].target, CACHE, 'the row keeps what the card asked about');
  assert.deepEqual(entry.sandboxDecision, {
    outcome: 'allowed', duration: 'run', paths: [{ kind: 'write', path: '/home/u/.cache/prisma' }], retry: { exitCode: 0 },
  });
  assert.equal(entry.permission.status, 'executed', 'the card did not leave the row waiting');
  const output = JSON.parse(toolMessageOf(llm).content);
  assert.equal(output.stdout, 'done', 'the model reads the second run');
  assert.match(output.sandbox_decision, /allowed writing to \/home\/u\/\.cache\/prisma for this run, and the command ran a second time/);
});

test('sandbox card: a path the card did not offer opens the first offer instead', async () => {
  const approvals = makeApprovals({ response: 'allow-once', sandboxPaths: ['/'] });
  const tools = makeToolPort({ execute: (name, args, ctx, n) => (n === 1 ? blockedRun() : okRun()) });
  const { engine } = makeEngine([assistantToolCall('c1', 'shell_execute', { command: 'x' }), assistantText('ok')],
    { tools, approvals });
  await send(engine);
  assert.deepEqual(tools.calls[1].context.sandboxGrants, { writePaths: [CACHE], readPaths: [], hosts: [] });
});

test('sandbox card: "for this session" carries the folder to the next run of the chat, without a card', async () => {
  const approvals = makeApprovals({ response: 'allow-session', sandboxPaths: [CACHE] });
  const tools = makeToolPort({ execute: (name, args, ctx, n) => (n === 1 ? blockedRun() : okRun()) });
  const { engine, grants } = makeEngine([
    assistantToolCall('c1', 'shell_execute', { command: 'npx prisma generate' }),
    assistantToolCall('c2', 'shell_execute', { command: 'npx prisma generate --watch' }),
    assistantText('ok'),
  ], { tools, approvals });

  const result = await send(engine, { chatId: 'chat-1' });

  assert.equal(sandboxRequests(approvals).length, 1);
  assert.deepEqual(tools.calls[2].context.sandboxGrants, { writePaths: [CACHE], readPaths: [], hosts: [] }, 'the second call starts with it');
  assert.equal(result.toolTrace[0].sandboxDecision.duration, 'session');
  const listed = grants.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].classes, ['write']);
  assert.equal(listed[0].scope.key, 'approval.sandbox.sessionScope.write');
  assert.deepEqual(listed[0].scope.params, { path: CACHE });
});

test('sandbox card: a protected read is opened as a read, not as a folder', async () => {
  const approvals = makeApprovals({ response: 'allow-once', sandboxPaths: ['/home/u/.ssh/known_hosts'] });
  const tools = makeToolPort({
    execute: (name, args, ctx, n) => (n === 1
      ? blockedRun({ kind: 'read', target: '/home/u/.ssh/known_hosts', allow: ['/home/u/.ssh/known_hosts'] })
      : okRun()),
  });
  const { engine } = makeEngine([assistantToolCall('c1', 'shell_execute', { command: 'git fetch' }), assistantText('ok')],
    { tools, approvals });
  await send(engine);
  assert.deepEqual(sandboxRequests(approvals)[0].riskClasses, ['read-sensitive']);
  assert.deepEqual(tools.calls[1].context.sandboxGrants, { writePaths: [], readPaths: ['/home/u/.ssh/known_hosts'], hosts: [] });
});

test('sandbox card: denied, the command does not run again and the model is told not to work around it', async () => {
  const approvals = makeApprovals('deny');
  const tools = makeToolPort({ execute: () => blockedRun() });
  const llm = makeLlmPort([assistantToolCall('c1', 'shell_execute', { command: 'x' }), assistantText('Ich sag es dir')]);
  const { engine } = makeEngine(null, { tools, approvals, llm, toolPolicy: policy({ mode: 'auto' }) });

  const result = await send(engine);

  assert.equal(result.content, 'Ich sag es dir', 'the run goes on: the model tells the user');
  assert.equal(tools.calls.length, 1);
  assert.deepEqual(result.toolTrace[0].sandboxDecision, { outcome: 'denied' });
  const decision = JSON.parse(toolMessageOf(llm).content).sandbox_decision;
  assert.match(decision, /The user denied writing to \/home\/u\/\.cache\/prisma\/engines\. The command was not run again\./);
  assert.match(decision, /Do not work around it/);
});

test('sandbox card: no answer counts as no — nothing opened, nothing run again', async () => {
  const approvals = makeApprovals({ invalidated: true, reason: 'request_invalidated' });
  const tools = makeToolPort({ execute: () => blockedRun() });
  const { engine } = makeEngine([assistantToolCall('c1', 'shell_execute', { command: 'x' }), assistantText('ok')],
    { tools, approvals });
  const result = await send(engine);
  assert.equal(tools.calls.length, 1);
  assert.deepEqual(result.toolTrace[0].sandboxDecision, { outcome: 'unanswered' });
});

test('sandbox card: the same command again after a denial ends the run', async () => {
  const approvals = makeApprovals('deny');
  const tools = makeToolPort({ execute: () => blockedRun() });
  const { engine } = makeEngine([
    assistantToolCall('c1', 'shell_execute', { command: 'x' }),
    assistantToolCall('c2', 'shell_execute', { command: 'x' }),
    assistantText('never'),
  ], { tools, approvals, toolPolicy: policy({ mode: 'auto' }) });
  const result = await send(engine);
  assert.equal(sandboxRequests(approvals).length, 1, 'asked once');
  assert.notEqual(result.content, 'never');
  assert.equal(result.toolTrace[1].permission.reason, 'repeated_denial');
});

test('sandbox card: only what can be opened is asked about; a refused connection alone asks nothing', async () => {
  const approvals = makeApprovals('allow-once');
  const tools = makeToolPort({ execute: () => blockedRun({ kind: 'network', target: 'example.com:443', allow: null }) });
  const { engine } = makeEngine([assistantToolCall('c1', 'shell_execute', { command: 'curl x' }), assistantText('ok')],
    { tools, approvals });
  const result = await send(engine);
  assert.equal(sandboxRequests(approvals).length, 0);
  assert.equal(result.toolTrace[0].sandboxBlocked.entries[0].kind, 'network');
  assert.equal(result.toolTrace[0].sandboxDecision, undefined);
});

test('sandbox card: the retry\'s own refusals go with the decision, not a second card', async () => {
  const approvals = makeApprovals({ response: 'allow-once', sandboxPaths: [CACHE] });
  const again = blockedRun({ target: '/home/u/.cache/other', allow: ['/home/u/.cache/other'] });
  const tools = makeToolPort({ execute: (name, args, ctx, n) => (n === 1 ? blockedRun() : again) });
  const { engine } = makeEngine([assistantToolCall('c1', 'shell_execute', { command: 'x' }), assistantText('ok')],
    { tools, approvals });
  const result = await send(engine);
  assert.equal(sandboxRequests(approvals).length, 1);
  assert.equal(result.toolTrace[0].sandboxBlocked.entries[0].target, CACHE);
  assert.equal(result.toolTrace[0].sandboxDecision.retry.blocked.entries[0].target, '/home/u/.cache/other');
  assert.equal(result.toolTrace[0].sandboxDecision.retry.exitCode, 1);
});

// ── A connection that waits while the command runs (#792, step 3) ───────────

const HOST = 'download.pytorch.org:443';
const HOST_OFFER = [HOST, '*.pytorch.org'];

/** What the sandbox asks about a waiting connection, as the runner hands it to the engine. */
function connectionRequest(target = HOST, allow = HOST_OFFER) {
  return { host: target.split(':')[0], port: 443, target, allow, domains: ['pypi.org'], waitedMs: 1200, stdout: 'Collecting torch', stderr: '' };
}

/**
 * A command that opens a connection while it runs: the runner puts the
 * question to the engine and carries on with the answer. `then` is what the
 * command comes back with afterwards.
 */
function connectingRun({ then = okRun, signal = new AbortController().signal, answers = [] } = {}) {
  return async (name, args, ctx) => {
    answers.push(await ctx.onSandboxNetworkAsk(connectionRequest(), { signal }));
    return then(answers);
  };
}

test('live connection: asks even in Auto while the command runs, and the command carries on', async () => {
  const approvals = makeApprovals((request) => {
    assert.equal(request.checkpoint, 'sandbox');
    assert.equal(request.mode, 'auto');
    assert.deepEqual(request.riskClasses, ['external']);
    assert.equal(request.sessionAllowed, true, 'a connection may be kept for the session on this card');
    assert.equal(request.sandbox.live, true);
    assert.equal(request.sandbox.waitedMs, 1200);
    assert.deepEqual(request.sandbox.domains, ['pypi.org']);
    assert.deepEqual(request.sandbox.entries, [{ kind: 'network', target: HOST, count: 1, allow: HOST_OFFER }]);
    assert.equal(request.sandbox.output, 'Collecting torch', 'what it printed so far');
    assert.deepEqual(request.sandbox.run, { exitCode: null, durationMs: null, timedOut: false });
    return { response: 'allow-once', sandboxPaths: ['*.pytorch.org'] };
  });
  const answers = [];
  const tools = makeToolPort({ execute: connectingRun({ answers }) });
  const llm = makeLlmPort([assistantToolCall('c1', 'shell_execute', { command: 'pip install torch' }), assistantText('fertig')]);
  const { engine } = makeEngine(null, { tools, approvals, llm, toolPolicy: policy({ mode: 'auto' }) });

  const result = await send(engine);

  assert.equal(result.content, 'fertig');
  assert.deepEqual(answers, [{ outcome: 'allowed', pattern: '*.pytorch.org' }]);
  assert.equal(tools.calls.length, 1, 'nothing runs twice');
  const entry = result.toolTrace[0];
  assert.deepEqual(entry.sandboxLive, [{ target: HOST, outcome: 'allowed', duration: 'run', pattern: '*.pytorch.org' }]);
  assert.equal(entry.permission.status, 'executed', 'the card did not leave the row waiting');
  const output = JSON.parse(toolMessageOf(llm).content);
  assert.match(output.sandbox_connections, /the user allowed download\.pytorch\.org:443 \(as \*\.pytorch\.org\) for this run\./);
  assert.equal(output.sandbox_decision, undefined, 'no card after the run');
});

test('live connection: "for this session" opens the host for the chat\'s next runs, without a card', async () => {
  const approvals = makeApprovals({ response: 'allow-session', sandboxPaths: [HOST] });
  const tools = makeToolPort({ execute: (name, args, ctx, n) => (n === 1 ? connectingRun()(name, args, ctx) : okRun()) });
  const { engine, grants } = makeEngine([
    assistantToolCall('c1', 'shell_execute', { command: 'pip install torch' }),
    assistantToolCall('c2', 'shell_execute', { command: 'pip install torchvision' }),
    assistantText('ok'),
  ], { tools, approvals });

  const result = await send(engine, { chatId: 'chat-1' });

  assert.equal(sandboxRequests(approvals).length, 1);
  assert.deepEqual(tools.calls[1].context.sandboxGrants, { writePaths: [], readPaths: [], hosts: [HOST] });
  assert.equal(result.toolTrace[0].sandboxLive[0].duration, 'session');
  const listed = grants.list();
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].classes, ['external'], 'kept for the session although a call never is');
  assert.equal(listed[0].scope.key, 'approval.sandbox.sessionScope.network');
  assert.deepEqual(listed[0].scope.params, { path: HOST });
});

test('live connection: denied — it stays closed, no card after the run, and the model is told not to work around it', async () => {
  const approvals = makeApprovals('deny');
  const answers = [];
  // The run also had a write refused that a card could offer; after the no, it does not.
  const tools = makeToolPort({ execute: connectingRun({ answers, then: () => blockedRun() }) });
  const llm = makeLlmPort([assistantToolCall('c1', 'shell_execute', { command: 'pip install torch' }), assistantText('Ich sag es dir')]);
  const { engine } = makeEngine(null, { tools, approvals, llm, toolPolicy: policy({ mode: 'auto' }) });

  const result = await send(engine);

  assert.deepEqual(answers, [{ outcome: 'denied' }]);
  assert.equal(sandboxRequests(approvals).length, 1, 'the live card only');
  assert.equal(tools.calls.length, 1);
  assert.deepEqual(result.toolTrace[0].sandboxLive, [{ target: HOST, outcome: 'denied' }]);
  assert.equal(result.toolTrace[0].sandboxDecision, undefined);
  const output = JSON.parse(toolMessageOf(llm).content);
  assert.match(output.sandbox_connections, /The user denied the connection to download\.pytorch\.org:443 while the command ran/);
  assert.match(output.sandbox_connections, /Do not work around it/);
});

test('live connection: the same command again after a denial ends the run, without another card', async () => {
  const approvals = makeApprovals('deny');
  const answers = [];
  const tools = makeToolPort({ execute: connectingRun({ answers }) });
  const { engine } = makeEngine([
    assistantToolCall('c1', 'shell_execute', { command: 'pip install torch' }),
    assistantToolCall('c2', 'shell_execute', { command: 'pip install torch' }),
    assistantText('never'),
  ], { tools, approvals, toolPolicy: policy({ mode: 'auto' }) });

  const result = await send(engine);

  assert.equal(sandboxRequests(approvals).length, 1, 'asked once');
  assert.deepEqual(answers, [{ outcome: 'denied' }, { outcome: 'denied' }], 'the second time closed without asking');
  assert.notEqual(result.content, 'never');
  assert.equal(result.toolTrace[1].permission.reason, 'repeated_denial');
});

test('live connection: the command gave up — the card expires saying so, and the card after the run offers it with a retry', async () => {
  const live = [];
  const approvals = {
    requests: [],
    isAvailable: () => true,
    requestApproval({ request, abortSignal }) {
      this.requests.push(request);
      if (!request.sandbox?.live) return Promise.resolve({ response: 'allow-once', sandboxPaths: [HOST] });
      // The live card waits for the user — until the command stops waiting.
      return new Promise((resolve) => {
        abortSignal.addEventListener('abort', () => {
          const outcome = { invalidated: true, reason: abortSignal.reason };
          live.push(outcome);
          resolve(outcome);
        }, { once: true });
      });
    },
  };
  const tools = makeToolPort({
    execute: async (name, args, ctx, n) => {
      if (n > 1) return okRun();
      const ended = new AbortController();
      const answer = ctx.onSandboxNetworkAsk(connectionRequest(), { signal: ended.signal });
      await new Promise((resolve) => setImmediate(resolve));
      ended.abort();
      assert.deepEqual(await answer, { outcome: 'unanswered' });
      return blockedRun({ kind: 'network', target: HOST, allow: HOST_OFFER });
    },
  });
  const llm = makeLlmPort([assistantToolCall('c1', 'shell_execute', { command: 'pip install torch' }), assistantText('ok')]);
  const { engine } = makeEngine(null, { tools, approvals, llm });

  const result = await send(engine);

  assert.deepEqual(live, [{ invalidated: true, reason: 'sandbox_run_ended' }]);
  const after = approvals.requests.filter((r) => r.checkpoint === 'sandbox' && !r.sandbox.live);
  assert.equal(after.length, 1);
  assert.deepEqual(after[0].sandbox.entries, [{ kind: 'network', target: HOST, count: 1, folder: false, allow: HOST_OFFER }]);
  assert.deepEqual(after[0].riskClasses, ['external']);
  assert.deepEqual(tools.calls[1].context.sandboxGrants, { writePaths: [], readPaths: [], hosts: [HOST] });
  assert.deepEqual(result.toolTrace[0].sandboxDecision, {
    outcome: 'allowed', duration: 'run', paths: [{ kind: 'network', path: HOST }], retry: { exitCode: 0 },
  });
  assert.equal(result.toolTrace[0].sandboxLive, undefined, 'nothing was decided while it waited');
  assert.match(JSON.parse(toolMessageOf(llm).content).sandbox_decision, /allowed connecting to download\.pytorch\.org:443 for this run/);
});
