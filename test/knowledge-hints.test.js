// Hints instead of refusals (#1277): a fact that reads like a rule or a
// procedure, and an entry that reads like an episode, earn a hint on the
// result and the card — and nothing is refused for its kind.

const test = require('node:test');
const assert = require('node:assert/strict');
const { knowledgeHints, KNOWLEDGE_HINTS } = require('../src/shared/contracts/knowledge-hints');
const { createWorkspaceToolRegistry } = require('../src/application/tools/workspace-tool-registry');

const cases = [
  ['fact', 'When you write a commit message, write it in English.', [KNOWLEDGE_HINTS.FACT_LOOKS_LIKE_RULE]],
  ['fact', 'Wenn du mir antwortest, antworte auf Deutsch.', [KNOWLEDGE_HINTS.FACT_LOOKS_LIKE_RULE]],
  ['fact', '1. Bump the version\n2. Tag it', [KNOWLEDGE_HINTS.FACT_LOOKS_LIKE_PROCEDURE]],
  ['fact', 'Today we fixed the login bug.', [KNOWLEDGE_HINTS.LOOKS_LIKE_EPISODE]],
  ['rule', 'The build is failing right now.', [KNOWLEDGE_HINTS.LOOKS_LIKE_EPISODE]],
  ['fact', 'Gestern haben wir den Login repariert.', [KNOWLEDGE_HINTS.LOOKS_LIKE_EPISODE]],
  // No hint: a fact, a rule stored as a rule, a decision, a reason.
  ['fact', 'Tests run with npm test.', []],
  ['fact', 'I speak German.', []],
  ['rule', 'When you write a commit message, write it in English.', []],
  ['fact', 'We decided today to use pnpm because npm was slow.', []],
  ['fact', 'The beds are measured in centimetres because the plans are.', []],
];

for (const [kind, text, expected] of cases) {
  test(`${kind}: "${text.split('\n')[0]}" → ${expected.join(', ') || 'no hint'}`, () => {
    assert.deepEqual(knowledgeHints({ kind, text }), expected);
  });
}

test('the result of remember carries the hint, and the entry is written all the same', async () => {
  const writes = [];
  const stub = new Proxy({}, { get: () => () => true });
  const registry = createWorkspaceToolRegistry({
    fsService: stub, webSearch: stub, pythonRunner: stub, urlFetch: stub, shellRunner: stub,
    knowledgeWriter: {
      async describe() { return { target: null, alternatives: {}, folderInstructions: { agentsMd: false, rulesFiles: 0 } }; },
      async write(request) { writes.push(request); return { kind: request.kind, scope: request.scope, file: '/x', text: request.text }; },
    },
  });
  const result = JSON.parse(await registry.getDefinition('remember').handler(
    { kind: 'fact', scope: 'user', text: 'When you answer me, answer in German.', origin: 'requested' }, {}));
  assert.equal(result.ok, true);
  assert.equal(writes.length, 1);
  assert.match(result.hints[0], /reads like a rule/);
});
