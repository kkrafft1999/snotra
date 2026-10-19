// The model proposes to switch a skill or tool for one chat (#774): main
// checks the proposal, the user answers on a card, and an accepted change
// applies from the next round of the same run — the tool list and the system
// prompt are rebuilt. A declined proposal is not shown again in the chat.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { createChatEngine } = require('../src/application/chat/chat-engine');
const { formatLine: formatToolDisplayLine } = require('./helpers/tool-descriptors');
const {
  applyConfigProposal,
  declineConfigProposal,
  proposalKey,
} = require('../src/shared/contracts/chat-configuration');

const ROOT = '/tmp/snotra-project';
const ALL_TOOLS = ['list_directory', 'load_skill', 'fetch_url', 'get_configuration', 'propose_config_change'];

function makeToolPort() {
  const calls = [];
  const visible = (options = {}) => ALL_TOOLS.filter((name) => !(options.disabledNames || []).includes(name));
  return {
    calls,
    getTools: (options) => visible(options).map((name) => ({ type: 'function', function: { name } })),
    buildSystemPrompt: (options) => `Tools: ${visible(options).join(', ')}`,
    isSwitchedOff: (name, disabled) => (disabled || []).includes(name),
    async plan(toolName, args) {
      return { tool: toolName, riskClasses: ['read'], targets: [], planKey: JSON.stringify([toolName, args]) };
    },
    buildTraceEntry: (toolName, args, extra = {}) => ({ tool: toolName, args, ...extra }),
    formatDisplayLine: (entry, phase) => formatToolDisplayLine(entry, phase, 'en'),
    async execute(toolName, args, context) {
      calls.push({ toolName, args, context });
      return { output: JSON.stringify({ ok: true }), progressEvents: [] };
    },
  };
}

/** Proposals as main checks them, against a two-line catalogue. */
function makeProposals(initial = null) {
  const store = new Map([['chat-1', initial]]);
  const prepared = [];
  return {
    store,
    prepared,
    async overridesFor(chatId) {
      return store.get(chatId) ?? null;
    },
    async prepare(input) {
      prepared.push(input);
      const { proposal, overrides } = input;
      if ((overrides?.declined || []).includes(proposalKey(proposal))) return { declined: true };
      if (proposal.kind === 'tool' && proposal.name === 'fetch_url') {
        return { card: { ...proposal, reason: proposal.reason, descriptionKey: 'tools.short.fetch_url', riskClasses: ['external'] } };
      }
      if (proposal.kind === 'skill' && proposal.name === 'pdf-export') {
        return { card: { ...proposal, description: 'Turns Markdown into a PDF.', descriptionIsData: true, origin: 'user' } };
      }
      return { error: `There is no ${proposal.kind} named "${proposal.name}".` };
    },
    async accept(chatId, proposal) {
      store.set(chatId, applyConfigProposal(store.get(chatId), proposal));
      return store.get(chatId);
    },
    async decline(chatId, proposal) {
      store.set(chatId, declineConfigProposal(store.get(chatId), proposal));
      return store.get(chatId);
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

function makeSkills() {
  const asked = [];
  const catalogue = {
    release: { name: 'release', description: 'Cuts a release.', body: 'Release steps.', path: '/skills/release' },
    'pdf-export': { name: 'pdf-export', description: 'Turns Markdown into a PDF.', body: 'PDF-BODY', path: '/skills/pdf-export' },
  };
  return {
    asked,
    async getActiveSkills(input) {
      asked.push(input);
      const invoked = new Set(input.invokedSkills || []);
      return [
        { ...catalogue.release, invoked: false },
        ...(invoked.has('pdf-export') ? [{ ...catalogue['pdf-export'], invoked: true }] : []),
      ];
    },
  };
}

function toolCall(id, name, args) {
  return {
    message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    finishReason: 'tool_calls',
    usage: null,
  };
}

function text(content) {
  return { message: { role: 'assistant', content }, finishReason: 'stop', usage: null };
}

function makeEngine(results, { proposals, approvals, disabledTools = [], skills = null } = {}) {
  const calls = [];
  const tools = makeToolPort();
  const engine = createChatEngine({
    llm: {
      async resolveChatTarget() { return { providerId: 'test', model: 'm' }; },
      async validateTarget() { return null; },
      async prepareSendBundle(target) { return { config: {}, model: target.model }; },
      async streamRound(params) {
        calls.push({ tools: (params.tools || []).map((t) => t.function.name), system: params.messages[0]?.content || '', messages: params.messages });
        return results[Math.min(calls.length - 1, results.length - 1)];
      },
      formatRoundError: (err) => err?.message || String(err),
    },
    tools,
    preferences: { async read() { return { disabledTools }; } },
    workspacePaths: {
      resolveRoot: (raw) => (typeof raw === 'string' && raw.trim() ? path.resolve(raw.trim()) : null),
      resolveSelection: () => null,
      basename: (p) => path.basename(p),
    },
    skills,
    toolPolicy: { async read() { return { mode: 'smart', rules: [], sensitivePathPatterns: [], policyVersion: '1:ok' }; } },
    approvals,
    configProposals: proposals,
    maxToolRounds: 6,
  });
  return { engine, calls, tools };
}

async function send(engine, { chatId = 'chat-1', content = 'Fetch the page' } = {}) {
  const lines = [];
  const result = await engine.send({
    sessionId: 'renderer-1',
    payload: { messages: [{ role: 'user', content }], workspaceRoot: ROOT, chatId },
    onEvent: (event) => { if (event.type === 'tool-line' && event.payload?.phase === 'done') lines.push(event.payload.line); },
  });
  return { result, lines };
}

const toolMessages = (call) => call.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));

test('an accepted proposal switches the tool on for the rest of the run', async () => {
  const proposals = makeProposals();
  const approvals = makeApprovals('allow-once');
  const { engine, calls } = makeEngine([
    toolCall('c1', 'propose_config_change', { kind: 'tool', name: 'fetch_url', enable: true, reason: 'To read the page you linked.' }),
    toolCall('c2', 'fetch_url', { url: 'https://example.com' }),
    text('Done.'),
  ], { proposals, approvals, disabledTools: ['fetch_url'] });

  const { result, lines } = await send(engine);
  assert.equal(result.content, 'Done.');
  // The card carries the catalogue's facts and the model's reason as its own field.
  assert.equal(approvals.requests.length, 1);
  const [request] = approvals.requests;
  assert.equal(request.checkpoint, 'config');
  assert.equal(request.chatId, 'chat-1');
  assert.deepEqual(request.config, {
    kind: 'tool', name: 'fetch_url', enable: true, reason: 'To read the page you linked.',
    descriptionKey: 'tools.short.fetch_url', riskClasses: ['external'],
  });
  // Off in the first round, on from the next one — tools and system prompt alike.
  assert.equal(calls[0].tools.includes('fetch_url'), false);
  assert.equal(calls[1].tools.includes('fetch_url'), true);
  assert.doesNotMatch(calls[0].system, /fetch_url/);
  assert.match(calls[1].system, /fetch_url/);
  assert.equal(toolMessages(calls[1])[0].accepted, true);
  assert.match(toolMessages(calls[1])[0].message, /on for this chat now/);
  // The call that follows runs: it is no longer switched off.
  assert.match(JSON.stringify(toolMessages(calls[2])[1]), /"ok":true/);
  assert.deepEqual(proposals.store.get('chat-1'), { tools: { on: ['fetch_url'] } });
  assert.deepEqual(lines.slice(0, 1), ['Switched on fetch_url for this chat']);
});

test('a declined proposal is refused without a second card in the same chat', async () => {
  const proposals = makeProposals();
  const approvals = makeApprovals('deny');
  const propose = (id) => toolCall(id, 'propose_config_change', { kind: 'tool', name: 'fetch_url', enable: true, reason: 'Needed.' });
  const { engine, calls } = makeEngine([propose('c1'), propose('c2'), text('Without it, then.')], {
    proposals, approvals, disabledTools: ['fetch_url'],
  });

  const { result, lines } = await send(engine);
  assert.equal(result.content, 'Without it, then.');
  assert.equal(approvals.requests.length, 1, 'one card, not two');
  const [declined, again] = toolMessages(calls[2]);
  assert.equal(declined.accepted, false);
  assert.match(declined.message, /do not propose it again/);
  assert.equal(again.accepted, false);
  assert.match(again.message, /declined this change earlier/);
  assert.equal(calls[2].tools.includes('fetch_url'), false);
  assert.deepEqual(lines, ['Declined: switching on fetch_url', 'Suggestion for fetch_url not shown — declined earlier in this chat']);
  assert.deepEqual(proposals.store.get('chat-1'), { declined: ['tool:on:fetch_url'] });
});

test('an unknown name never reaches a card', async () => {
  const proposals = makeProposals();
  const approvals = makeApprovals();
  const { engine, calls } = makeEngine([
    toolCall('c1', 'propose_config_change', { kind: 'tool', name: 'rm_everything', enable: true, reason: 'x' }),
    text('ok'),
  ], { proposals, approvals });

  const { lines } = await send(engine);
  assert.equal(approvals.requests.length, 0);
  assert.match(toolMessages(calls[1])[0].error, /no tool named "rm_everything"/);
  assert.deepEqual(lines, ['Suggestion not possible']);
});

test('switched off, the proposal tool is refused like any other tool', async () => {
  const proposals = makeProposals();
  const approvals = makeApprovals();
  const { engine, calls } = makeEngine([
    toolCall('c1', 'propose_config_change', { kind: 'tool', name: 'fetch_url', enable: true, reason: 'x' }),
    text('ok'),
  ], { proposals, approvals, disabledTools: ['fetch_url', 'propose_config_change'] });

  await send(engine);
  assert.equal(approvals.requests.length, 0);
  assert.equal(proposals.prepared.length, 0);
  assert.equal(toolMessages(calls[1])[0].error, 'permission_denied');
});

test('a card that lapses ends the run without switching anything', async () => {
  const proposals = makeProposals();
  const approvals = makeApprovals({ invalidated: true, reason: 'request_invalidated' });
  const { engine, calls } = makeEngine([
    toolCall('c1', 'propose_config_change', { kind: 'tool', name: 'fetch_url', enable: true, reason: 'x' }),
    text('never'),
  ], { proposals, approvals, disabledTools: ['fetch_url'] });

  const { result } = await send(engine);
  assert.equal(calls.length, 1, 'no further provider request');
  assert.equal(result.code, 'PERMISSION');
  assert.equal(proposals.store.get('chat-1'), null);
});

test('what the chat switched before applies when the run starts', async () => {
  const proposals = makeProposals({ tools: { on: ['fetch_url'] }, skills: { off: ['release'] } });
  const skills = makeSkills();
  const { engine, calls } = makeEngine([text('hi')], {
    proposals, approvals: makeApprovals(), disabledTools: ['fetch_url'], skills,
  });

  await send(engine);
  assert.equal(calls[0].tools.includes('fetch_url'), true);
  assert.doesNotMatch(calls[0].system, /release/);
});

test('a skill switched on by a card is listed for load_skill, not written out like a /name call', async () => {
  const proposals = makeProposals();
  const skills = makeSkills();
  const { engine, calls } = makeEngine([
    toolCall('c1', 'propose_config_change', { kind: 'skill', name: 'pdf-export', enable: true, reason: 'You asked for a PDF.' }),
    text('ok'),
  ], { proposals, approvals: makeApprovals('allow-once'), skills });

  await send(engine, { content: 'Make a PDF of the notes' });
  assert.doesNotMatch(calls[0].system, /pdf-export/);
  assert.match(calls[1].system, /- pdf-export: Turns Markdown into a PDF\./);
  // The instructions stay with load_skill (#173), unlike a "/pdf-export" call.
  assert.doesNotMatch(calls[1].system, /PDF-BODY/);
  assert.deepEqual(skills.asked.at(-1).invokedSkills, ['pdf-export']);
  assert.match(toolMessages(calls[1])[0].message, /Load it with load_skill/);
});
