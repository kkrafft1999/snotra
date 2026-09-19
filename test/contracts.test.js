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
    cached: 0,
  });
  assert.equal(normalizeUsage({}), null);
  assert.deepEqual(createEmptyUsage(), { prompt: 0, completion: 0, total: 0, cached: 0 });
  assert.deepEqual(coerceUsage({}), { prompt: 0, completion: 0, total: 0, cached: 0 });
  assert.deepEqual(coerceUsage({ prompt_tokens: 3 }), {
    prompt: 3,
    completion: 0,
    total: 3,
    cached: 0,
  });
});

test('cached_tokens: OpenAI zaehlt im Prompt, Anthropic daneben (#179)', () => {
  // OpenAI (Responses): cached_tokens steckt in input_tokens_details und ist
  // eine Teilmenge von input_tokens — der Prompt bleibt, wie er gemeldet wird.
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 10000,
      input_tokens_details: { cached_tokens: 8192 },
      output_tokens: 200,
      total_tokens: 10200,
    }),
    { prompt: 10000, completion: 200, total: 10200, cached: 8192 }
  );
  // OpenAI (Chat Completions): derselbe Wert, anderer Schluessel.
  assert.equal(
    normalizeUsage({ prompt_tokens: 500, prompt_tokens_details: { cached_tokens: 384 } }).cached,
    384
  );
  // Anthropic: cache_read und cache_creation stehen NEBEN input_tokens. Wer sie
  // stehen laesst, verliert 9.500 von 10.000 Prompt-Token.
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 500,
      cache_read_input_tokens: 9000,
      cache_creation_input_tokens: 500,
      output_tokens: 200,
    }),
    { prompt: 10000, completion: 200, total: 10200, cached: 9000 }
  );
  // Google: wieder Teilmenge.
  assert.equal(
    normalizeUsage({ promptTokenCount: 800, cachedContentTokenCount: 600 }).cached,
    600
  );
  // Anbieter ohne Cache melden keinen — und keine erfundene 0-Ersatzzahl.
  assert.equal(normalizeUsage({ prompt_eval_count: 100, eval_count: 20 }).cached, 0);
  // Ein bereits normalisiertes Objekt darf beim zweiten Durchlauf nicht
  // wachsen — sonst addiert die Tool-Schleife den Cache-Anteil mehrfach.
  const einmal = normalizeUsage({
    input_tokens: 500,
    cache_read_input_tokens: 9000,
    output_tokens: 200,
  });
  assert.deepEqual(normalizeUsage(einmal), einmal);
  // Nie mehr aus dem Cache als im Prompt.
  assert.equal(normalizeUsage({ prompt_tokens: 100, cached_tokens: 900 }).cached, 100);
});

test('mergeUsage summiert den Cache-Anteil ueber die Runden (#179)', () => {
  assert.deepEqual(
    mergeUsage(
      { prompt: 10, completion: 5, total: 15, cached: 0 },
      { prompt: 10000, completion: 20, total: 10020, cached: 9000 }
    ),
    { prompt: 10010, completion: 25, total: 10035, cached: 9000 }
  );
  // Ein Altbestand ohne `cached` (gespeicherte Chats vor #179) zaehlt als 0,
  // statt die Summe auf NaN zu ziehen.
  assert.equal(
    mergeUsage({ prompt: 10, completion: 5, total: 15 }, { prompt: 1, completion: 1, total: 2 })
      .cached,
    0
  );
});

test('mergeUsage sums rounds and tolerates null inputs', () => {
  assert.deepEqual(
    mergeUsage({ prompt: 10, completion: 5, total: 15 }, { prompt: 3, completion: 2, total: 5 }),
    { prompt: 13, completion: 7, total: 20, cached: 0 }
  );
  assert.deepEqual(mergeUsage({ prompt: 1, completion: 1, total: 2 }, null), {
    prompt: 1,
    completion: 1,
    total: 2,
  });
  assert.equal(mergeUsage(null, null), null);
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

test('sanitizeChatTitle strips model decoration and clamps the length', () => {
  const { sanitizeChatTitle, CHAT_TITLE_MAX_LENGTH } = contracts;
  assert.equal(sanitizeChatTitle('Lesespalte begrenzen'), 'Lesespalte begrenzen');
  assert.equal(sanitizeChatTitle('"Lesespalte begrenzen"'), 'Lesespalte begrenzen');
  assert.equal(sanitizeChatTitle('„Lesespalte begrenzen“'), 'Lesespalte begrenzen');
  assert.equal(sanitizeChatTitle('Titel: Lesespalte begrenzen.'), 'Lesespalte begrenzen');
  // Vorsatz und Anfuehrungszeichen in beliebiger Schachtelung.
  assert.equal(sanitizeChatTitle('"Titel: Lesespalte begrenzen."'), 'Lesespalte begrenzen');
  assert.equal(sanitizeChatTitle('Titel: "Lesespalte begrenzen"'), 'Lesespalte begrenzen');
  // Mehrzeilige Antworten: nur die erste nicht-leere Zeile zaehlt.
  assert.equal(sanitizeChatTitle('\n  Composer umbauen \nNoch ein Satz'), 'Composer umbauen');
  const long = sanitizeChatTitle('w'.repeat(120));
  assert.equal(long.length, CHAT_TITLE_MAX_LENGTH);
  assert.ok(long.endsWith('…'));
  assert.equal(sanitizeChatTitle('   '), '');
  assert.equal(sanitizeChatTitle(null), '');
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
