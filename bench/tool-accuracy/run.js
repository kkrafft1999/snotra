#!/usr/bin/env node
'use strict';

/**
 * Runs the tool-accuracy task set once against one arm (#186).
 *
 *   node --env-file=$HOME/env/openai/.env bench/tool-accuracy/run.js --arm current --label aa-1
 *
 * Writes one JSON line per task to out/bench/tool-accuracy/ (outside git) and
 * prints a summary. Compare two runs with compare.js. See README.md.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseArgs } = require('node:util');

const { ARMS } = require('./arms');
const { TASKS } = require('./tasks');
const { scoreTask } = require('./score');
const { createOpenAiLlm, createScriptedLlm, createBenchEngine, compactArgs, runTask } = require('./harness');
const { formatSummary, summarise } = require('./report');

const ROOT = path.resolve(__dirname, '..', '..');

const { values: opts } = parseArgs({
  options: {
    arm: { type: 'string' },
    model: { type: 'string', default: 'gpt-6-luna' },
    effort: { type: 'string', default: 'medium' },
    label: { type: 'string' },
    only: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    concurrency: { type: 'string', default: '4' },
    out: { type: 'string', default: path.join(ROOT, 'out', 'bench', 'tool-accuracy') },
    'print-prompt': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error(
    'Usage: node --env-file=<file with OPENAI_API_KEY> bench/tool-accuracy/run.js --arm <current|uncut>\n' +
      '         [--model gpt-6-luna] [--effort medium] [--label name] [--only id,id]\n' +
      '         [--repeat 1] [--concurrency 4] [--out dir]\n' +
      '       node bench/tool-accuracy/run.js --arm <arm> --print-prompt'
  );
  process.exit(message ? 2 : 0);
}

async function printPrompt(arm) {
  const llm = createScriptedLlm([{ text: 'ok' }]);
  const { prepareWorkspace, removeWorkspace } = require('./harness');
  const dir = await prepareWorkspace();
  try {
    await createBenchEngine({ arm, llm }).send({
      sessionId: 'print',
      payload: { messages: [{ role: 'user', content: 'Hello' }], workspaceRoot: dir, chatId: 'print' },
      onEvent: () => {},
    });
  } finally {
    await removeWorkspace(dir);
  }
  const [request] = llm.requests;
  const system = request.messages.find((m) => m.role === 'system')?.content ?? '';
  console.log(`# System prompt (${system.length} chars)\n\n${system}\n`);
  console.log(`# Tools (${JSON.stringify(request.tools).length} chars)\n`);
  console.log(JSON.stringify(request.tools, null, 2));
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function taskSetHash(tasks) {
  return createHash('sha256').update(JSON.stringify(tasks.map((t) => [t.id, t.prompt]))).digest('hex').slice(0, 12);
}

function toRecord({ task, rep, arm, observation }) {
  const score = scoreTask(task, observation);
  const usages = observation.rounds.map((r) => r.usage).filter(Boolean);
  const sum = (key) => usages.reduce((n, u) => n + (Number(u[key]) || 0), 0);
  return {
    type: 'run',
    id: task.id,
    kind: task.kind,
    lang: task.lang,
    probes: task.probes || null,
    rep,
    arm,
    score,
    calls: observation.calls.map((call) => ({ ...call, args: compactArgs(call.args) })),
    rounds: observation.rounds.length,
    finishReasons: observation.rounds.map((r) => r.finishReason),
    approvals: observation.approvals,
    aborted: Boolean(observation.result.error || observation.result.cancelled),
    code: observation.result.code,
    error: observation.result.error,
    tokens: {
      prompt: sum('prompt'),
      completion: sum('completion'),
      cached: sum('cached'),
      firstRoundPrompt: usages[0] ? Number(usages[0].prompt) || 0 : null,
    },
    toolErrors: observation.calls.filter((call) => call.error).length,
    schemaViolations: observation.calls.reduce(
      (n, call) => n + Object.values(call.schema || {}).reduce((m, paths) => m + paths.length, 0),
      0
    ),
    content: observation.result.content,
    durationMs: observation.durationMs,
    retries: observation.retries,
  };
}

async function pool(items, size, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.max(1, size) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function main() {
  if (opts.help) usage();
  if (!ARMS.includes(opts.arm)) usage(`--arm must be one of: ${ARMS.join(', ')}`);
  if (opts['print-prompt']) return printPrompt(opts.arm);

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    usage('OPENAI_API_KEY is not set. Pass a file with it via node --env-file=…');
  }

  const only = opts.only ? new Set(opts.only.split(',').map((s) => s.trim())) : null;
  const tasks = only ? TASKS.filter((t) => only.has(t.id)) : TASKS;
  if (only && tasks.length !== only.size) usage(`Unknown task id in --only: ${opts.only}`);
  const repeat = Math.max(1, Number(opts.repeat) || 1);
  const label = opts.label || opts.arm;

  fs.mkdirSync(opts.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(opts.out, `${stamp}-${label}.jsonl`);
  const meta = {
    type: 'meta',
    label,
    arm: opts.arm,
    model: opts.model,
    effort: opts.effort,
    repeat,
    tasks: tasks.length,
    taskSet: taskSetHash(TASKS),
    commit: gitCommit(),
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n`);

  const jobs = [];
  for (let rep = 1; rep <= repeat; rep += 1) for (const task of tasks) jobs.push({ task, rep });

  const records = [];
  let done = 0;
  await pool(jobs, Number(opts.concurrency) || 4, async ({ task, rep }) => {
    const observation = await runTask({
      task,
      arm: opts.arm,
      chatId: `bench-${label}-${task.id}-${rep}`,
      makeLlm: () => createOpenAiLlm({ model: opts.model, effort: opts.effort, apiKey }),
    });
    const record = toRecord({ task, rep, arm: opts.arm, observation });
    records.push(record);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    done += 1;
    const mark = record.aborted ? 'ABORT' : record.score.correct ? 'ok' : 'FAIL';
    process.stderr.write(
      `[${String(done).padStart(3)}/${jobs.length}] ${mark.padEnd(5)} ${task.id}` +
        `  ${record.calls.map((c) => c.tool).join(',') || '-'}` +
        `${record.error ? `  (${record.code}: ${record.error.slice(0, 120)})` : ''}\n`
    );
  });

  console.log(`\n${formatSummary(meta, summarise(records))}\n\nWritten to ${path.relative(ROOT, file)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
