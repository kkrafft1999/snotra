const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_HISTORY_CHAR_LIMIT,
  HISTORY_CHAR_LIMIT_MIN,
  HISTORY_CHAR_LIMIT_MAX,
  TOOL_OUTPUT_PLACEHOLDER,
  clampHistoryCharLimit,
  resolveHistoryCharLimit,
  estimateMessageChars,
  estimateTokens,
  trimHistoryMessages,
  truncateStaleToolOutputs,
} = require('../src/main/chat-history-trim');

test('clampHistoryCharLimit clamps to bounds and rejects non-numbers', () => {
  assert.equal(clampHistoryCharLimit(100), HISTORY_CHAR_LIMIT_MIN);
  assert.equal(clampHistoryCharLimit(10_000_000), HISTORY_CHAR_LIMIT_MAX);
  assert.equal(clampHistoryCharLimit(50_000.6), 50_001);
  assert.equal(clampHistoryCharLimit('50000'), undefined);
  assert.equal(clampHistoryCharLimit(NaN), undefined);
});

test('resolveHistoryCharLimit falls back to the default', () => {
  assert.equal(resolveHistoryCharLimit({}), DEFAULT_HISTORY_CHAR_LIMIT);
  assert.equal(resolveHistoryCharLimit(undefined), DEFAULT_HISTORY_CHAR_LIMIT);
  assert.equal(resolveHistoryCharLimit({ historyCharLimit: 10_000 }), 10_000);
});

test('estimateMessageChars counts content and tool_calls arguments', () => {
  const plain = estimateMessageChars({ role: 'user', content: 'x'.repeat(100) });
  assert.ok(plain >= 100);

  const withTools = estimateMessageChars({
    role: 'assistant',
    content: null,
    tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file_text', arguments: 'y'.repeat(200) } },
    ],
  });
  assert.ok(withTools >= 200);

  assert.equal(estimateMessageChars(null), 0);
});

test('estimateTokens uses the chars/4 heuristic', () => {
  const messages = [{ role: 'user', content: 'x'.repeat(376) }]; // 376 + 24 overhead = 400
  assert.equal(estimateTokens(messages), 100);
});

test('trimHistoryMessages keeps the newest messages within budget', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `${i}:${'x'.repeat(1000)}`,
  }));
  // each message ≈ 1026 chars → budget for about 3
  const { messages: kept, dropped } = trimHistoryMessages(messages, 3200);
  assert.equal(dropped, 7);
  assert.deepEqual(kept.map((m) => m.content[0]), ['7', '8', '9']);
});

test('trimHistoryMessages always keeps the latest message even when over budget', () => {
  const messages = [
    { role: 'user', content: 'old' },
    { role: 'user', content: 'x'.repeat(50_000) },
  ];
  const { messages: kept, dropped } = trimHistoryMessages(messages, 4000);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].content.length, 50_000);
  assert.equal(dropped, 1);
});

test('trimHistoryMessages keeps everything when within budget', () => {
  const messages = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
  ];
  const { messages: kept, dropped } = trimHistoryMessages(messages, 4000);
  assert.deepEqual(kept, messages);
  assert.equal(dropped, 0);
});

function makeRound(idSuffix, outputSize) {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: `call_${idSuffix}`, type: 'function', function: { name: 'read_file_text', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: `call_${idSuffix}`, content: 'x'.repeat(outputSize) },
  ];
}

test('truncateStaleToolOutputs shortens old tool outputs but never the latest round', () => {
  const apiMessages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'frage' },
    ...makeRound('a', 5000),
    ...makeRound('b', 5000),
  ];
  const truncated = truncateStaleToolOutputs(apiMessages, 6000);
  assert.equal(truncated, 1, 'only the stale round-a output may be truncated');
  assert.equal(apiMessages[3].content, TOOL_OUTPUT_PLACEHOLDER);
  assert.equal(apiMessages[5].content.length, 5000, 'latest round output must stay intact');
  assert.equal(apiMessages[3].tool_call_id, 'call_a', 'pairing must be preserved');
});

test('truncateStaleToolOutputs truncates oldest-first until under budget', () => {
  const apiMessages = [
    { role: 'user', content: 'frage' },
    ...makeRound('a', 3000),
    ...makeRound('b', 3000),
    ...makeRound('c', 3000),
  ];
  const truncated = truncateStaleToolOutputs(apiMessages, 7000);
  assert.equal(truncated, 1);
  assert.equal(apiMessages[2].content, TOOL_OUTPUT_PLACEHOLDER, 'oldest output goes first');
  assert.equal(apiMessages[4].content.length, 3000);
});

test('truncateStaleToolOutputs does nothing within budget and leaves non-tool messages alone', () => {
  const apiMessages = [
    { role: 'user', content: 'x'.repeat(3000) },
    ...makeRound('a', 100),
  ];
  assert.equal(truncateStaleToolOutputs(apiMessages, 200_000), 0);
  const big = [
    { role: 'user', content: 'x'.repeat(50_000) },
    ...makeRound('a', 100),
  ];
  assert.equal(truncateStaleToolOutputs(big, 4000), 0, 'user content must never be truncated');
  assert.equal(big[0].content.length, 50_000);
});

// Bild-Anhaenge (Issue #84): sie stehen nicht im Content, kosten den Anbieter
// aber Tokens. Ohne eigenen Posten fensterte der Verlauf sie als gratis.
test('estimateMessageChars rechnet Bild-Anhaenge mit ein', () => {
  const { estimateMessageChars } = require('../src/application/chat/chat-history-trim');
  const { IMAGE_ATTACHMENT_CHAR_COST } = require('../src/shared/contracts/attachments');
  const PNG_1PX =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const ohne = { role: 'user', content: 'Hallo' };
  const mit = {
    role: 'user',
    content: 'Hallo',
    attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1PX }],
  };

  assert.equal(estimateMessageChars(mit) - estimateMessageChars(ohne), IMAGE_ATTACHMENT_CHAR_COST);
});
