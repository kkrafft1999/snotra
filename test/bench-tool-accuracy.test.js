'use strict';

// The tool-accuracy benchmark (#186) runs against a real model by hand; these
// tests keep its harness honest without one: the task set stays valid against
// the registry, the "uncut" arm still fits the tools, and a write call is
// really approved and executed instead of being denied and counted as a hit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { TASKS } = require('../bench/tool-accuracy/tasks');
const { UNCUT_TOOLS, UNCUT_PROMPT_LINES, wrapRegistryForArm, propertyAt } = require('../bench/tool-accuracy/arms');
const { scoreTask, normalisePath, specsOf, toolsOf, GROUPS } = require('../bench/tool-accuracy/score');
const { createScriptedLlm, runTask } = require('../bench/tool-accuracy/harness');
const { mcnemarExact, comparePaired } = require('../bench/tool-accuracy/report');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');

const AVAILABLE = { isAvailable: () => true, isConfigured: () => true };

function fullRegistry() {
  return createWorkspaceToolRegistry({
    fsService: {},
    webSearch: AVAILABLE,
    pythonRunner: AVAILABLE,
    urlFetch: AVAILABLE,
    shellRunner: AVAILABLE,
    memory: AVAILABLE,
    documentText: AVAILABLE,
    imageGeneration: AVAILABLE,
  });
}

const OPTIONS = { workspaceOpen: true, skillNames: [] };

function propertyPaths(schema, prefix = '') {
  const out = [];
  for (const [key, child] of Object.entries(schema?.properties || {})) {
    out.push(prefix + key);
    out.push(...propertyPaths(child, `${prefix}${key}.`));
    if (child.items) out.push(...propertyPaths(child.items, `${prefix}${key}[].`));
  }
  return out.sort();
}

test('task set: unique ids, at least a quarter negatives, both languages', () => {
  const ids = TASKS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  const negatives = TASKS.filter((t) => t.kind === 'negative').length;
  assert.ok(negatives / TASKS.length >= 0.25, `${negatives} of ${TASKS.length} are negative`);
  assert.ok(TASKS.length >= 110 && TASKS.length <= 145, `${TASKS.length} tasks`);
  assert.ok(TASKS.some((t) => t.lang === 'de') && TASKS.some((t) => t.lang === 'en'));
});

test('task set: every tool a task names exists in the registry', () => {
  const names = new Set(fullRegistry().getTools(OPTIONS).map((t) => t.function.name));
  for (const task of TASKS) {
    if (task.kind === 'negative') {
      for (const entry of task.forbid) {
        assert.ok(entry === 'any' || GROUPS[entry] || names.has(entry), `${task.id}: unknown ${entry}`);
      }
      continue;
    }
    for (const spec of specsOf(task.expect).specs) {
      for (const tool of toolsOf(spec)) assert.ok(names.has(tool), `${task.id}: unknown tool ${tool}`);
    }
  }
  for (const group of Object.values(GROUPS)) for (const tool of group) assert.ok(names.has(tool), tool);
});

test('uncut arm: same tools and parameters, only texts and limit keywords differ', () => {
  const registry = fullRegistry();
  const current = registry.getTools(OPTIONS);
  const uncut = wrapRegistryForArm(registry, 'uncut').getTools(OPTIONS);
  assert.deepEqual(uncut.map((t) => t.function.name), current.map((t) => t.function.name));
  for (let i = 0; i < current.length; i += 1) {
    const name = current[i].function.name;
    assert.deepEqual(
      propertyPaths(uncut[i].function.parameters),
      propertyPaths(current[i].function.parameters),
      `${name}: parameters differ`
    );
    assert.deepEqual(uncut[i].function.parameters.required, current[i].function.parameters.required, name);
    if (UNCUT_TOOLS[name]) {
      const text = JSON.stringify(uncut[i].function.parameters);
      assert.doesNotMatch(text, /"(default|maximum|maxItems|maxLength)":/, `${name}: limit keyword left`);
    } else {
      assert.deepEqual(uncut[i].function, current[i].function, `${name} must be identical in both arms`);
    }
  }
  // The arm does not touch the registry it wraps.
  assert.deepEqual(registry.getTools(OPTIONS), current);
});

test('uncut arm: every overlaid parameter exists, and the prompt lists every tool', () => {
  const registry = fullRegistry();
  const byName = new Map(registry.getTools(OPTIONS).map((t) => [t.function.name, t.function]));
  for (const [name, overlay] of Object.entries(UNCUT_TOOLS)) {
    assert.ok(byName.has(name), `${name} is gone from the registry`);
    for (const dotted of Object.keys(overlay.params || {})) {
      assert.ok(propertyAt(byName.get(name).parameters, dotted), `${name}.${dotted} is gone`);
    }
  }
  const prompt = wrapRegistryForArm(registry, 'uncut').buildSystemPrompt(OPTIONS);
  for (const name of byName.keys()) {
    assert.ok(UNCUT_PROMPT_LINES[name], `no prompt line for ${name}`);
    assert.match(prompt, new RegExp(`^- ${name}: `, 'm'));
  }
  assert.doesNotMatch(prompt, /sparingly|zurückhaltend/, 'the write caveat removed by #269 stays out');
});

test('score: paths are normalised, regexes and functions match, allOf needs every call', () => {
  assert.equal(normalisePath('./src/'), 'src');
  assert.equal(normalisePath('.'), '');
  const task = TASKS.find((t) => t.id === 'lines-events-range');
  const ok = scoreTask(task, {
    calls: [{ tool: 'read_file_lines', args: { relative_path: './data/events.txt', start_line: 300, end_line: 320 } }],
  });
  assert.deepEqual([ok.toolChoice, ok.params, ok.correct], [true, true, true]);
  const wrongArgs = scoreTask(task, {
    calls: [{ tool: 'read_file_lines', args: { relative_path: 'data/events.txt', start_line: 1 } }],
  });
  assert.deepEqual([wrongArgs.toolChoice, wrongArgs.params, wrongArgs.correct], [true, false, false]);

  const both = TASKS.find((t) => t.id === 'web-then-fetch');
  assert.equal(scoreTask(both, { calls: [{ tool: 'web_search', args: {} }] }).correct, false);
  assert.equal(
    scoreTask(both, { calls: [{ tool: 'fetch_url', args: {} }, { tool: 'web_search', args: {} }] }).correct,
    true
  );
});

test('score: a negative task fails on a forbidden call, reads stay allowed where only writes are forbidden', () => {
  const noWrite = TASKS.find((t) => t.id === 'neg-explain-change');
  assert.equal(scoreTask(noWrite, { calls: [{ tool: 'read_file_text', args: {} }] }).correct, true);
  const failed = scoreTask(noWrite, { calls: [{ tool: 'edit_file', args: {} }] });
  assert.equal(failed.correct, false);
  assert.deepEqual(failed.forbiddenCalls, ['edit_file']);
  const none = TASKS.find((t) => t.id === 'neg-capital');
  assert.equal(scoreTask(none, { calls: [{ tool: 'web_search', args: {} }] }).correct, false);
});

test('score: an unexpected write is flagged on a read task', () => {
  const task = TASKS.find((t) => t.id === 'read-parser');
  const result = scoreTask(task, {
    calls: [
      { tool: 'read_file_text', args: { relative_path: 'src/parser.js' } },
      { tool: 'write_file_text', args: {} },
    ],
  });
  assert.equal(result.correct, true);
  assert.equal(result.unexpectedWrite, true);
});

test('harness: a write call is approved and executed, not silently denied', async () => {
  const task = TASKS.find((t) => t.id === 'write-faq');
  const observation = await runTask({
    task,
    arm: 'current',
    chatId: 'test-write',
    makeLlm: () => createScriptedLlm([
      { toolCalls: [{ name: 'write_file_text', args: { relative_path: 'docs/faq.md', content: '# FAQ\n' } }] },
      { text: 'Done.' },
    ]),
  });
  assert.equal(observation.result.error, null);
  assert.equal(observation.calls.length, 1);
  // Asked, answered "allow once", run — the audit entry keeps the final decision.
  assert.equal(observation.calls[0].decision, 'allow');
  assert.deepEqual(observation.approvals.length, 1);
  assert.equal(observation.files['docs/faq.md'], '# FAQ\n');
  assert.equal(observation.rounds.length, 2);
  assert.equal(scoreTask(task, observation).correct, true);
});

test('harness: the fixture has its hidden and ignored files, and apply_patch works on it', async () => {
  const task = TASKS.find((t) => t.id === 'edit-hidden-ci');
  const observation = await runTask({
    task,
    arm: 'uncut',
    chatId: 'test-patch',
    makeLlm: () => createScriptedLlm([
      {
        toolCalls: [{
          name: 'apply_patch',
          args: {
            relative_path: '.github/workflows/ci.yml',
            edits: [{ old_string: 'node-version: 20', new_string: 'node-version: 22' }],
          },
        }],
      },
      { text: 'Done.' },
    ]),
  });
  assert.equal(observation.result.error, null);
  assert.match(observation.files['.github/workflows/ci.yml'], /node-version: 22/);
  assert.equal(scoreTask(task, observation).correct, true);
});

test('harness: a call the tool rejects is marked, and its arguments do not count as right', async () => {
  const task = TASKS.find((t) => t.id === 'lines-events-range');
  const observation = await runTask({
    task,
    arm: 'current',
    chatId: 'test-error',
    makeLlm: () => createScriptedLlm([
      // Line and byte mode at once — what gpt-6-luna sent in the first probe.
      {
        toolCalls: [{
          name: 'read_file_lines',
          args: { relative_path: 'data/events.txt', start_line: 300, end_line: 320, start_byte: 0, length: 16000 },
        }],
      },
      { text: 'Sorry.' },
    ]),
  });
  assert.match(observation.calls[0].error, /not both/);
  const score = scoreTask(task, observation);
  assert.deepEqual([score.toolChoice, score.params, score.correct], [true, false, false]);
});

test('harness: the stubbed tools answer without leaving the machine', async () => {
  const task = TASKS.find((t) => t.id === 'shell-tests');
  const llm = createScriptedLlm([
    { toolCalls: [{ name: 'shell_execute', args: { command: 'npm test' } }] },
    { text: 'All green.' },
  ]);
  const observation = await runTask({ task, arm: 'current', chatId: 'test-shell', makeLlm: () => llm });
  assert.equal(observation.result.error, null);
  const toolMessage = llm.requests[1].messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /"exit_code":0/);
  assert.equal(scoreTask(task, observation).correct, true);
});

test('report: exact McNemar and paired flips', () => {
  assert.equal(mcnemarExact(0, 0), 1);
  assert.equal(mcnemarExact(0, 5), 0.0625);
  assert.equal(mcnemarExact(3, 3), 1);
  const rec = (id, correct) => ({
    id, rep: 1, kind: 'positive', probes: null, aborted: false, rounds: 2, calls: [],
    score: { correct, toolChoice: correct, unexpectedWrite: false },
    tokens: { prompt: 100, firstRoundPrompt: 50 },
  });
  const comparison = comparePaired([rec('a', true), rec('b', true)], [rec('a', true), rec('b', false)]);
  const overall = comparison.binary[0];
  assert.deepEqual([overall.n, overall.onlyA, overall.onlyB, overall.flipRate], [2, 1, 0, 0.5]);
});
