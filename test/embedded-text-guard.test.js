// The secret protection for embedded text (#528): skills, AGENTS.md and the
// memory files pass the same two checks as a tool result on their way out.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  EMBEDDED_TEXT_GUARDS,
  WITHHELD_EMBEDDED_TEXT,
  guardEmbeddedText,
  guardEmbeddedFiles,
  guardEmbeddedSkills,
} = require('../src/application/chat/embedded-text-guard');
const { createChatEngine } = require('../src/application/chat/chat-engine');

const OWN_KEY = 'sk-own-provider-key-1234567890';
const CREDENTIAL = 'api_key = "abcdefgh12345678"';

test('an own secret leaves the whole text out', () => {
  const result = guardEmbeddedText(`Use this key: ${OWN_KEY}\nand be nice.`, [OWN_KEY]);
  assert.equal(result.guard, EMBEDDED_TEXT_GUARDS.WITHHELD);
  assert.equal(result.text, WITHHELD_EMBEDDED_TEXT);
});

test('a credential pattern is masked, the rest of the text stays', () => {
  const result = guardEmbeddedText(`Run the tests first.\n${CREDENTIAL}\n`, []);
  assert.equal(result.guard, EMBEDDED_TEXT_GUARDS.MASKED);
  assert.match(result.text, /Run the tests first\./);
  assert.equal(result.text.includes('abcdefgh12345678'), false);
});

test('clean text passes unchanged, and a short own secret does not count', () => {
  const text = 'Write commit messages in English.';
  assert.deepEqual(guardEmbeddedText(text, ['English']), { text, guard: null });
});

test('text too large to scan is left out rather than sent unchecked', () => {
  const result = guardEmbeddedText('a'.repeat(4 * 1024 * 1024 + 1), []);
  assert.equal(result.guard, EMBEDDED_TEXT_GUARDS.WITHHELD);
});

test('files and skills keep their other fields; a guarded skill keeps its name', () => {
  const [file] = guardEmbeddedFiles([{ source: 'workspace-agents', text: CREDENTIAL, truncated: true }], []);
  assert.equal(file.source, 'workspace-agents');
  assert.equal(file.truncated, true);
  assert.equal(file.guard, 'masked');
  const [skill] = guardEmbeddedSkills([{ name: 'deploy', description: 'Deploys.', body: `key ${OWN_KEY}`, path: '/s' }], [OWN_KEY]);
  assert.equal(skill.name, 'deploy');
  assert.equal(skill.path, '/s');
  assert.equal(skill.guard, 'withheld');
  assert.equal(skill.description, 'Deploys.');
});

// Through the engine: what goes out to the provider, and what the breakdown says.
function engineWith({ skills = null, projectInstructions = null, memory = null, ownSecrets }) {
  const calls = [];
  const engine = createChatEngine({
    llm: {
      async resolveChatTarget() { return { providerId: 'test', model: 'm' }; },
      async validateTarget() { return null; },
      async prepareSendBundle() { return { config: {}, capabilities: { images: true } }; },
      async streamRound(params) {
        calls.push(params);
        return { message: { role: 'assistant', content: 'ok' }, usage: null };
      },
      formatRoundError: (error) => error.message,
    },
    tools: {
      getTools: () => [],
      buildSystemPrompt: () => '',
      buildTraceEntry: (tool, args) => ({ tool, args }),
      formatDisplayLine: () => '',
      async plan() { return null; },
      async execute() { return { output: '{}' }; },
    },
    preferences: { async read() { return {}; } },
    workspacePaths: { resolveRoot: (root) => root || null, resolveSelection: () => null, basename: (p) => path.basename(p) },
    skills,
    projectInstructions,
    memory,
    ownSecrets,
  });
  return { engine, calls };
}

async function sendOnce(engine) {
  return engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content: 'hi' }], workspaceRoot: '/tmp/snotra-528' },
  });
}

test('the engine never sends an own secret from AGENTS.md, memory or a skill', async () => {
  const { engine, calls } = engineWith({
    projectInstructions: { async load() { return [{ source: 'workspace-agents', text: `Deploy with ${OWN_KEY}.` }]; } },
    memory: { async load() { return [{ scope: 'workspace', file: '/x/.agents/memory.md', text: `- the key is ${OWN_KEY}`, truncated: false }]; } },
    skills: {
      async getActiveSkills() {
        return [{ name: 'deploy', description: 'Deploys.', body: `curl -H "Authorization: ${OWN_KEY}"`, source: 'workspace', path: '/s', invoked: true }];
      },
    },
    ownSecrets: { async read() { return [OWN_KEY]; } },
  });
  const result = await sendOnce(engine);
  const system = calls[0].messages.find((m) => m.role === 'system').content;
  assert.equal(system.includes(OWN_KEY), false);
  assert.equal(system.split(WITHHELD_EMBEDDED_TEXT).length - 1, 3, 'each of the three is replaced by the notice');
  const rows = result.contextBreakdown.parts;
  assert.equal(rows.find((part) => part.id === 'system:agents-md:workspace-agents').detailKey, 'context.detail.folderPathWithheld');
  assert.equal(rows.find((part) => part.id === 'system:memory:workspace').detailKey, 'context.detail.folderPathWithheld');
  assert.equal(rows.find((part) => part.id === 'skill:deploy').detailKey, 'context.detail.skill.withheld');
});

test('the engine masks a credential pattern in embedded text and keeps the rest', async () => {
  const { engine, calls } = engineWith({
    projectInstructions: { async load() { return [{ source: 'user-snotra', text: `Be brief.\n${CREDENTIAL}` }]; } },
    ownSecrets: { async read() { throw new Error('store locked'); } },
  });
  const result = await sendOnce(engine);
  const system = calls[0].messages.find((m) => m.role === 'system').content;
  assert.match(system, /Be brief\./);
  assert.equal(system.includes('abcdefgh12345678'), false);
  const row = result.contextBreakdown.parts.find((part) => part.id === 'system:agents-md:user-snotra');
  assert.equal(row.detailKey, 'context.detail.pathMasked');
});
