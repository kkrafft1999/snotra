const test = require('node:test');
const assert = require('node:assert/strict');
const contracts = require('../src/shared/contracts');
const {
  CONTRACT_VERSION,
  CHAT_ERROR_CODES,
  CHAT_PHASES,
  TOOL_LINE_PHASES,
  CHAT_PROGRESS_TYPES,
  createEmptyUsage,
  normalizeUsage,
  coerceUsage,
  mergeUsage,
  DEBUG_WAIT,
  resolveDebugWaitMs,
  createChatResult,
  createCancelledChatResult,
  createChatErrorResult,
  createDeltaEvent,
  createToolLineEvent,
  createPhaseEvent,
  createReasoningEvent,
  createWorkspaceFileWrittenEvent,
  isChatErrorCode,
  isChatPhase,
  isToolLinePhase,
} = contracts;

test('CONTRACT_VERSION is a positive integer', () => {
  assert.equal(Number.isInteger(CONTRACT_VERSION), true);
  assert.ok(CONTRACT_VERSION >= 1);
});

test('enums are frozen and carry the wire values used at the IPC boundary', () => {
  assert.equal(Object.isFrozen(CHAT_ERROR_CODES), true);
  assert.equal(Object.isFrozen(CHAT_PHASES), true);
  assert.equal(CHAT_PHASES.IDLE, 'idle');
  assert.equal(CHAT_PHASES.WAITING, 'waiting');
  assert.equal(CHAT_PHASES.GENERATING, 'generating');
  assert.equal(TOOL_LINE_PHASES.PENDING, 'pending');
  assert.equal(TOOL_LINE_PHASES.START, 'start');
  assert.equal(TOOL_LINE_PHASES.DONE, 'done');
  assert.equal(isToolLinePhase('pending'), true);
  assert.equal(CHAT_PROGRESS_TYPES.PHASE, 'phase');
  assert.equal(CHAT_PROGRESS_TYPES.REASONING, 'reasoning');
});

test('normalizeUsage maps provider fields and coerceUsage never returns null', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5 }), {
    prompt: 10,
    completion: 5,
    total: 15,
  });
  assert.equal(normalizeUsage({}), null);
  assert.deepEqual(createEmptyUsage(), { prompt: 0, completion: 0, total: 0 });
  assert.deepEqual(coerceUsage({}), { prompt: 0, completion: 0, total: 0 });
  assert.deepEqual(coerceUsage({ prompt_tokens: 3 }), { prompt: 3, completion: 0, total: 3 });
});

test('mergeUsage sums rounds and tolerates null inputs', () => {
  assert.deepEqual(
    mergeUsage({ prompt: 10, completion: 5, total: 15 }, { prompt: 3, completion: 2, total: 5 }),
    { prompt: 13, completion: 7, total: 20 }
  );
  assert.deepEqual(mergeUsage({ prompt: 1, completion: 1, total: 2 }, null), {
    prompt: 1,
    completion: 1,
    total: 2,
  });
  assert.equal(mergeUsage(null, null), null);
});

test('resolveDebugWaitMs clamps to the shared bounds', () => {
  assert.equal(resolveDebugWaitMs(), DEBUG_WAIT.DEFAULT_MS);
  assert.equal(resolveDebugWaitMs({ duration_seconds: 0 }), DEBUG_WAIT.MIN_MS);
  assert.equal(resolveDebugWaitMs({ duration_seconds: 999 }), DEBUG_WAIT.MAX_MS);
  assert.equal(resolveDebugWaitMs({ duration_ms: 1234 }), 1234);
});

test('createChatResult / createCancelledChatResult produce the stable success shapes', () => {
  assert.deepEqual(createChatResult({ content: 'hi', toolTrace: [], usage: null }), {
    content: 'hi',
    toolTrace: [],
    usage: null,
  });
  assert.deepEqual(createCancelledChatResult({ content: 'partial' }), {
    cancelled: true,
    content: 'partial',
    toolTrace: [],
    usage: null,
  });
});

test('inferChatTitle derives a short title from the first user message', () => {
  const { inferChatTitle, CHAT_TITLE_MAX_LENGTH } = contracts;
  assert.equal(inferChatTitle([{ role: 'user', content: 'Wie starte ich die App?' }]), 'Wie starte ich die App?');
  // Der Gruss der Assistentin steht vor der Frage, zaehlt aber nicht.
  assert.equal(
    inferChatTitle([
      { role: 'assistant', content: 'Hallo!' },
      { role: 'user', content: 'Zeig mir die Konfiguration' },
    ]),
    'Zeig mir die Konfiguration'
  );
  // Mehrzeilige Eingaben werden zu einer Zeile und bei Ueberlaenge gekuerzt.
  const long = inferChatTitle([{ role: 'user', content: `${'a'.repeat(80)}\n  b` }]);
  assert.equal(long.length, CHAT_TITLE_MAX_LENGTH);
  assert.ok(long.endsWith('…'));
  assert.equal(inferChatTitle([{ role: 'user', content: 'eins\n\nzwei' }]), 'eins zwei');
  // Ohne Nutzerfrage bleibt der Platzhalter.
  assert.equal(inferChatTitle([]), 'Neuer Chat');
  assert.equal(inferChatTitle(null), 'Neuer Chat');
});

test('result factories carry contextUsage only when provided', () => {
  const ctx = { prompt: 210, completion: 20, total: 230 };
  assert.deepEqual(createChatResult({ content: 'hi', usage: null, contextUsage: ctx }), {
    content: 'hi',
    toolTrace: [],
    usage: null,
    contextUsage: ctx,
  });
  assert.deepEqual(createCancelledChatResult({ contextUsage: null }), {
    cancelled: true,
    content: '',
    toolTrace: [],
    usage: null,
    contextUsage: null,
  });
  assert.deepEqual(
    createChatErrorResult({ error: 'y', code: CHAT_ERROR_CODES.API, usage: ctx, contextUsage: ctx }),
    { error: 'y', code: 'API', usage: ctx, contextUsage: ctx }
  );
  // Ohne Angabe bleibt die Form schlank — kein contextUsage-Schluessel.
  assert.equal('contextUsage' in createChatResult({ content: 'x' }), false);
});

test('createChatErrorResult omits usage unless provided', () => {
  assert.deepEqual(createChatErrorResult({ error: 'x', code: CHAT_ERROR_CODES.INVALID }), {
    error: 'x',
    code: 'INVALID',
  });
  assert.deepEqual(
    createChatErrorResult({ error: 'y', code: CHAT_ERROR_CODES.TOOL_LIMIT, usage: null }),
    { error: 'y', code: 'TOOL_LIMIT', usage: null }
  );
  // Default-Code ist INVALID.
  assert.equal(createChatErrorResult({ error: 'z' }).code, 'INVALID');
});

test('event factories match the push payload shapes', () => {
  assert.deepEqual(createDeltaEvent('abc'), { text: 'abc' });
  assert.deepEqual(createDeltaEvent(undefined), { text: '' });
  assert.deepEqual(createPhaseEvent(CHAT_PHASES.WAITING), { type: 'phase', phase: 'waiting' });
  assert.deepEqual(createReasoningEvent('r'), { type: 'reasoning', text: 'r' });
  assert.deepEqual(createWorkspaceFileWrittenEvent('src/a.js'), {
    type: 'workspace',
    event: 'fileWritten',
    relativePath: 'src/a.js',
  });
  assert.deepEqual(
    createToolLineEvent(TOOL_LINE_PHASES.START, {
      tool: 'read_file_text',
      args: { relative_path: 'a' },
      line: 'Datei a wird gelesen …',
    }),
    { phase: 'start', tool: 'read_file_text', args: { relative_path: 'a' }, line: 'Datei a wird gelesen …' }
  );
});

test('contracts aggregate exports settings helpers', () => {
  assert.equal(typeof contracts.normalizePresetWire, 'function');
  assert.equal(typeof contracts.formatPresetSublabelFromView, 'function');
});
