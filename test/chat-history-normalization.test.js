const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inferChatTitle,
  sanitizeChatMessagesForStore,
  normalizeTokenUsageForStore,
  normalizeLoadedMessages,
  normalizeSessionForStore,
  normalizeSessionForLoad,
} = require('../src/main/services/chat-history-normalization');

test('inferChatTitle uses first user message and truncates long text', () => {
  assert.equal(inferChatTitle([{ role: 'user', content: '  Hallo   Welt  ' }]), 'Hallo Welt');
  assert.equal(
    inferChatTitle([{ role: 'user', content: 'x'.repeat(60) }]).length,
    48
  );
  assert.equal(inferChatTitle([]), 'Neuer Chat');
  assert.equal(inferChatTitle([{ role: 'assistant', content: 'only bot' }]), 'Neuer Chat');
});

test('sanitizeChatMessagesForStore strips UI fields and keeps rich assistant data', () => {
  const stored = sanitizeChatMessagesForStore([
    { role: 'user', content: [{ type: 'text', text: 'Multimodal' }] },
    {
      role: 'assistant',
      content: 'Answer',
      streaming: true,
      phase: 'generating',
      toolTrace: [{ line: 'Tool läuft …' }, 'Tool fertig'],
      reasoningText: '  denkt nach  ',
      isError: false,
    },
    { role: 'system', content: 'ignored' },
  ]);

  assert.deepEqual(stored, [
    { role: 'user', content: 'Multimodal' },
    {
      role: 'assistant',
      content: 'Answer',
      toolTrace: ['Tool läuft …', 'Tool fertig'],
      reasoningText: 'denkt nach',
    },
  ]);
  assert.equal(stored[0].streaming, undefined);
});

test('normalizeLoadedMessages adds renderer-ready assistant shape', () => {
  const loaded = normalizeLoadedMessages([
    { role: 'user', content: 'Hi' },
    {
      role: 'assistant',
      content: 'Hey',
      toolTrace: ['done'],
      reasoningText: 'r',
      isError: true,
    },
  ]);

  assert.deepEqual(loaded[1], {
    role: 'assistant',
    content: 'Hey',
    toolTrace: ['done'],
    reasoningText: 'r',
    streaming: false,
    isError: true,
  });
});

test('sanitizeChatMessagesForStore uses toolTrace precedence line -> summary -> text', () => {
  const stored = sanitizeChatMessagesForStore([
    {
      role: 'assistant',
      content: '',
      toolTrace: [
        { text: 'from-text', summary: 'from-summary', line: 'from-line' },
        { text: 'text-only', summary: 'summary-wins' },
        { text: 'fallback-text' },
      ],
    },
  ]);
  assert.deepEqual(stored[0].toolTrace, ['from-line', 'summary-wins', 'fallback-text']);
});

test('sanitizeChatMessagesForStore drops empty users but keeps metadata-only assistants', () => {
  const stored = sanitizeChatMessagesForStore([
    { role: 'user', content: '   ' },
    { role: 'assistant', content: '', toolTrace: ['Tool fertig'] },
    { role: 'assistant', content: '', reasoningText: 'denkt' },
    { role: 'assistant', content: '', isError: true },
    { role: 'assistant', content: '   ' },
  ]);
  assert.equal(stored.length, 3);
  assert.equal(stored[0].toolTrace[0], 'Tool fertig');
  assert.equal(stored[1].reasoningText, 'denkt');
  assert.equal(stored[2].isError, true);
});

test('normalizeLoadedMessages applies the same toolTrace precedence', () => {
  const loaded = normalizeLoadedMessages([
    {
      role: 'assistant',
      content: 'x',
      toolTrace: [{ text: 't', summary: 's', line: 'l' }],
    },
  ]);
  assert.deepEqual(loaded[0].toolTrace, ['l']);
});

test('normalizeSessionForStore rejects empty sanitized messages only when requireMessages is set', () => {
  assert.equal(
    normalizeSessionForStore(
      { id: 'empty', messages: [{ role: 'user', content: '  ' }] },
      { normalizeWorkspaceRoot: (p) => p, requireMessages: true }
    ),
    null
  );
});

test('normalizeSessionForStore preserves legacy sessions with empty message arrays', () => {
  const session = normalizeSessionForStore(
    {
      id: 'legacy',
      title: 'Legacy',
      updatedAt: 1,
      messages: [],
    },
    { normalizeWorkspaceRoot: (p) => p }
  );
  assert.equal(session.id, 'legacy');
  assert.equal(session.title, 'Legacy');
  assert.deepEqual(session.messages, []);
});

test('normalizeSessionForLoad keeps legacy sessions with empty messages readable', () => {
  const loaded = normalizeSessionForLoad({
    id: 'legacy',
    title: 'Legacy',
    updatedAt: 1,
    messages: [],
  });
  assert.equal(loaded.title, 'Legacy');
  assert.deepEqual(loaded.messages, []);
});

test('normalizeSessionForStore preserves existingTitle when payload omits title', () => {
  const session = normalizeSessionForStore(
    {
      id: 's1',
      workspaceRoot: '/tmp/ws',
      updatedAt: 42,
      messages: [{ role: 'user', content: 'Neue Nachricht' }],
    },
    { normalizeWorkspaceRoot: (p) => p, existingTitle: 'Gespeicherter Titel' }
  );
  assert.equal(session.title, 'Gespeicherter Titel');
});

test('normalizeSessionForStore infers title when omitted and no existing title', () => {
  const session = normalizeSessionForStore(
    {
      id: 's1',
      workspaceRoot: '/tmp/ws',
      updatedAt: 42,
      messages: [{ role: 'user', content: 'Mein Thema' }],
    },
    { normalizeWorkspaceRoot: (p) => p }
  );
  assert.equal(session.title, 'Mein Thema');
});

test('normalizeSessionForLoad normalizes legacy sessions without tokenUsage', () => {
  const loaded = normalizeSessionForLoad({
    id: 'legacy',
    workspaceRoot: null,
    title: 'Saved',
    updatedAt: 1,
    messages: [{ role: 'assistant', content: 'old', toolTrace: ['x'] }],
  });
  assert.equal(loaded.title, 'Saved');
  assert.deepEqual(loaded.tokenUsage, { prompt: 0, completion: 0, total: 0 });
  assert.equal(loaded.messages[0].streaming, false);
  assert.deepEqual(loaded.messages[0].toolTrace, ['x']);
});

test('normalizeTokenUsageForStore coerces partial numeric fields', () => {
  assert.deepEqual(normalizeTokenUsageForStore({ prompt: 10.2, completion: '3' }), {
    prompt: 10,
    completion: 3,
    total: 13,
  });
});

test('sanitizeChatMessagesForStore keeps the tool name alongside the line', () => {
  const stored = sanitizeChatMessagesForStore([
    {
      role: 'assistant',
      content: 'ok',
      toolTrace: [
        { line: 'Datei a.js gelesen', tool: 'read_file_text', args: { relative_path: 'a.js' } },
        { line: 'Ordner src durchsucht', tool: '' },
        'Alt-Eintrag ohne Tool',
      ],
    },
  ]);
  // Nur Einträge mit Tool-Namen werden Objekte; die Argumente bleiben draußen.
  assert.deepEqual(stored[0].toolTrace, [
    { line: 'Datei a.js gelesen', tool: 'read_file_text' },
    'Ordner src durchsucht',
    'Alt-Eintrag ohne Tool',
  ]);
});

test('normalizeLoadedMessages keeps the tool name for loaded sessions', () => {
  const loaded = normalizeLoadedMessages([
    {
      role: 'assistant',
      content: 'ok',
      toolTrace: [{ line: 'Nach „foo“ gesucht', tool: 'search_in_files' }, 'Alt-Eintrag'],
    },
  ]);
  assert.deepEqual(loaded[0].toolTrace, [
    { line: 'Nach „foo“ gesucht', tool: 'search_in_files' },
    'Alt-Eintrag',
  ]);
});
