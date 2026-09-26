const test = require('node:test');
const assert = require('node:assert/strict');
const { measureArgumentConformance, MAX_PATHS_PER_KIND } = require('../src/main/tools/argument-conformance');
const { validateArguments } = require('../src/main/tools/tool-call-planner');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { sanitizeChatMessagesForStore, normalizeLoadedMessages } = require('../src/main/services/chat-history-normalization');
const { summarizeToolTrace, summarizeConversation } = require('../src/shared/runtime/tool-trace-metrics');

function makeRegistry() {
  const stub = new Proxy({}, { get: () => () => true });
  return createWorkspaceToolRegistry({
    fsService: stub,
    webSearch: stub,
    pythonRunner: stub,
    urlFetch: stub,
    shellRunner: stub,
  });
}

const DEFINITION = {
  name: 'demo',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer' },
      ratio: { type: 'number' },
      tags: { type: 'array', items: { type: 'string' } },
      edits: {
        type: 'array',
        items: {
          type: 'object',
          properties: { old_string: { type: 'string' }, new_string: { type: 'string' } },
        },
      },
    },
    required: ['query'],
  },
};

test('conforming arguments measure as null', () => {
  assert.equal(
    measureArgumentConformance(DEFINITION, {
      query: 'x',
      limit: 3,
      ratio: 0.5,
      tags: ['a'],
      edits: [{ old_string: 'a', new_string: 'b' }],
    }),
    null
  );
});

test('unknown properties, non-integers and mismatching items are counted by path', () => {
  assert.deepEqual(
    measureArgumentConformance(DEFINITION, {
      query: 'x',
      path: 'src',
      limit: 2.5,
      tags: ['a', 7, null],
      edits: [{ old_string: 'a', new_string: 'b', old_text: 'a' }, 'raw'],
    }),
    {
      unknownProperties: ['path', 'edits[0].old_text'],
      nonInteger: ['limit'],
      invalidItems: ['tags[1]', 'tags[2]', 'edits[1]'],
    }
  );
});

test('the measurement leaves wrong base types to validateArguments', () => {
  // A string for an integer is refused by the planner; counting it again
  // here would count the same mistake twice.
  assert.equal(measureArgumentConformance(DEFINITION, { query: 'x', limit: '3', tags: 'a' }), null);
  assert.equal(validateArguments(DEFINITION, { query: 'x', limit: '3' }), 'Argument "limit" must be a number.');
});

test('schemas that allow extra properties, or describe none, count no unknown ones', () => {
  const open = { parameters: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true } };
  const bare = { parameters: { type: 'object' } };
  assert.equal(measureArgumentConformance(open, { a: 'x', b: 1 }), null);
  assert.equal(measureArgumentConformance(bare, { anything: 1 }), null);
  assert.equal(measureArgumentConformance({}, { anything: 1 }), null);
  assert.equal(measureArgumentConformance(DEFINITION, null), null);
  assert.equal(measureArgumentConformance(DEFINITION, ['x']), null);
});

test('the paths per kind are capped', () => {
  const args = { query: 'x' };
  for (let i = 0; i < MAX_PATHS_PER_KIND + 10; i += 1) args[`extra_${i}`] = i;
  assert.equal(measureArgumentConformance(DEFINITION, args).unknownProperties.length, MAX_PATHS_PER_KIND);
});

// The case the issue is about: a property that is valid for a *different*
// tool. `pattern` belongs to `find_files`, not to `search_in_files` — the
// planner lets it through, the measurement names it.
test('a property valid for another tool passes validateArguments and is counted', () => {
  const registry = makeRegistry();
  const search = registry.getDefinition('search_in_files');
  assert.ok('pattern' in registry.getDefinition('find_files').parameters.properties);
  assert.ok(!('pattern' in search.parameters.properties));

  const args = { query: 'TODO', pattern: '*.js', max_results: 20.5 };
  assert.equal(validateArguments(search, args), null, 'validateArguments stays as lenient as before');
  const measured = measureArgumentConformance(search, args);
  assert.deepEqual(measured, { unknownProperties: ['pattern'], nonInteger: ['max_results'] });

  const adapter = createWorkspaceToolAdapter(registry);
  assert.deepEqual(adapter.measureArguments('search_in_files', args), measured);
  assert.equal(adapter.measureArguments('search_in_files', { query: 'TODO' }), null);
  assert.equal(adapter.measureArguments('no_such_tool', { pattern: 'x' }), null);
});

test('round and schema violations survive the history round trip, values do not', () => {
  const stored = sanitizeChatMessagesForStore([
    { role: 'user', content: 'Suche' },
    {
      role: 'assistant',
      content: 'Fertig',
      toolTrace: [
        {
          tool: 'search_in_files',
          line: 'Searched',
          args: { query: 'secret' },
          round: 1,
          schema: { unknownProperties: ['path', 42, 'x'.repeat(300)], nonInteger: [], bogus: ['y'] },
        },
        { tool: 'read_file_text', line: 'Read', round: 0, schema: 'nope' },
      ],
    },
  ]);
  const [first, second] = stored[1].toolTrace;
  assert.equal(first.round, 1);
  assert.deepEqual(first.schema, { unknownProperties: ['path', 'x'.repeat(128)] });
  assert.equal(first.args, undefined);
  assert.equal(second.round, undefined);
  assert.equal(second.schema, undefined);

  const loaded = normalizeLoadedMessages(stored);
  assert.deepEqual(loaded[1].toolTrace[0], first);
});

test('summarizeToolTrace counts denials, rounds and violations of one turn', () => {
  const summary = summarizeToolTrace([
    { tool: 'search_in_files', round: 1, schema: { unknownProperties: ['path'] } },
    { tool: 'read_file_lines', round: 1, permission: { reason: 'invalid_arguments', status: 'denied' } },
    { tool: 'read_file_lines', round: 2, schema: { nonInteger: ['start_line', 'end_line'] } },
    { tool: 'edit_file', round: 3, permission: { reason: 'policy_denied' } },
  ]);
  assert.deepEqual(summary, {
    calls: 4,
    rounds: 3,
    invalidArgumentDenials: 1,
    callsWithSchemaViolations: 2,
    schemaViolations: { unknownProperties: 1, nonInteger: 2, invalidItems: 0 },
  });
});

test('traces from before the measurement count calls without rounds', () => {
  const summary = summarizeToolTrace(['Listed .', { tool: 'read_file_text', line: 'Read' }, '', null]);
  assert.equal(summary.calls, 2);
  assert.equal(summary.rounds, null);
  assert.equal(summarizeToolTrace(undefined).calls, 0);
});

test('summarizeConversation sums the turns that used tools', () => {
  const { turns, total } = summarizeConversation([
    { role: 'user', content: 'a' },
    { role: 'assistant', toolTrace: [{ tool: 'x', round: 1 }, { tool: 'y', round: 2, schema: { invalidItems: ['tags[0]'] } }] },
    { role: 'assistant', content: 'no tools', toolTrace: [] },
    { role: 'assistant', toolTrace: [{ tool: 'z', round: 1, permission: { reason: 'invalid_arguments' } }] },
    { role: 'assistant', toolTrace: ['old line'] },
  ]);
  assert.equal(turns.length, 3);
  assert.deepEqual(turns.map((t) => t.rounds), [2, 1, null]);
  assert.deepEqual(total, {
    calls: 4,
    rounds: 3,
    invalidArgumentDenials: 1,
    callsWithSchemaViolations: 1,
    schemaViolations: { unknownProperties: 0, nonInteger: 0, invalidItems: 1 },
  });
});
