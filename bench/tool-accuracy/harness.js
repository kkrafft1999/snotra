'use strict';

/**
 * Drives the real chat engine headless for the tool-accuracy benchmark (#186).
 *
 * Built on `createChatEngine`, not on a single provider round: the extra round
 * a too-short description causes is the most expensive consequence of a cut,
 * and only the engine shows it. Policy and approvals are wired for real —
 * without them every write call ends in `decision: deny`, and a denied call
 * would still count as the right tool. Nothing here needs Electron.
 *
 * The file tools run for real against a throwaway copy of ./fixture. The tools
 * that would leave the machine, cost money or need a sandbox (run_python,
 * shell_execute, web_search, fetch_url, extract_document_text, generate_image,
 * remember) answer with canned results: the benchmark is about which tool the
 * model picks and with which arguments, not about what the tool returns.
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const src = (rel) => require(path.join(ROOT, 'src', rel));

const { createChatEngine } = src('application/chat/chat-engine');
const { createSessionGrants } = src('application/permissions/session-grants');
const { createWorkspaceToolRegistry } = src('main/tools/workspace-tool-registry');
const { createWorkspaceToolAdapter } = src('main/adapters/workspace-tool-adapter');
const { createNodeWorkspacePathAdapter } = src('main/adapters/workspace-path-adapter');
const { createFsService } = src('main/services/fs-service');
const { LIMITS } = src('shared/limits');
const { wrapRegistryForArm } = require('./arms');

const FIXTURE = path.join(__dirname, 'fixture');
// Stored under another name so that it does not hide the fixture's own files
// from git; restored when the fixture is copied.
const FIXTURE_RENAMES = { 'dot-gitignore': '.gitignore' };

const STUB_RESULTS = {
  run_python: () => ({
    exit_code: 0,
    stdout: '4217.3\n',
    stderr: '',
    isolated: true,
  }),
  shell_execute: (args) => ({
    command: args.command,
    exit_code: 0,
    stdout: '',
    stderr: '',
    isolated: true,
  }),
  web_search: (args) => ({
    query: args.query,
    results: [
      {
        title: 'Changelog — csv-parse',
        url: 'https://csv.js.org/parse/changelog/',
        snippet: 'Release notes of the csv-parse package, newest first.',
        date: '2026-09-01',
      },
      {
        title: 'Node.js — Previous Releases',
        url: 'https://nodejs.org/en/about/previous-releases',
        snippet: 'Major Node.js versions enter Active LTS status for 12 months.',
      },
    ],
  }),
  fetch_url: (args) => ({
    url: args.url,
    title: 'Changelog',
    text: '# Changelog\n\n## 5.6.0\n\n- New option `cast_date`.\n\n## 5.5.0\n\n- Fixed a parsing edge case.',
    truncated: false,
  }),
  extract_document_text: (args) => ({
    relative_path: args.relative_path,
    text: '--- Page 2 ---\nOffer total: 12,400 EUR, valid until 2026-12-31.',
    next_start_character: null,
  }),
  generate_image: (args) => ({ relative_path: args.relative_path, written: true }),
  remember: (args) => ({ stored: true, scope: args.scope }),
};

// A stub only has to make the registry offer the tool; it is never executed.
const AVAILABLE = { isAvailable: () => true, isConfigured: () => true };

/** The `error` of a tool result, or null — every tool answers `{ "error": … }` on failure. */
function resultError(result) {
  try {
    const parsed = JSON.parse(result);
    return parsed && typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

/** `executions` collects, in order, every approved call that ran and whether it failed. */
function createBenchRegistry(fsService, executions = []) {
  const registry = createWorkspaceToolRegistry({
    fsService,
    webSearch: AVAILABLE,
    pythonRunner: AVAILABLE,
    urlFetch: AVAILABLE,
    shellRunner: AVAILABLE,
    memory: AVAILABLE,
    documentText: AVAILABLE,
    imageGeneration: AVAILABLE,
  });
  return {
    ...registry,
    async execute(name, args, context = {}) {
      // Not approved: the registry's own refusal, unchanged and not counted.
      if (context.approved !== true) return registry.execute(name, args, context);
      const result = STUB_RESULTS[name]
        ? JSON.stringify(STUB_RESULTS[name](args || {}))
        : await registry.execute(name, args, context);
      executions.push({ tool: name, error: resultError(result) });
      return result;
    },
  };
}

/** The OpenAI provider through the app's own LLM adapter. */
function createOpenAiLlm({ model, effort, apiKey }) {
  const providers = src('main/providers');
  const { createProviderRuntimeAdapter } = src('main/adapters/provider-catalog-adapter');
  const { createProviderLlmAdapter } = src('main/adapters/provider-llm-adapter');
  return createProviderLlmAdapter({
    providerRuntime: createProviderRuntimeAdapter(providers),
    llmConfigStore: {
      readLLMConfig: async () => ({}),
      resolveChatModelTarget: () => ({ providerId: 'openai', model }),
    },
    providerSecrets: { getEffectiveProviderConfig: async () => ({ apiKey }) },
    reasoningLevelFor: async () => effort,
  });
}

/**
 * An LLM port without a model: each round answers with the next entry of
 * `replies` — `{ toolCalls: [{ name, args }] }` or `{ text }` — and records
 * what the engine sent. For the tests and for --print-prompt.
 */
function createScriptedLlm(replies = [{ text: 'ok' }]) {
  const requests = [];
  let index = 0;
  return {
    requests,
    async resolveChatTarget() {
      return { providerId: 'openai', model: 'scripted', providerOptions: {}, reasoningEffort: null };
    },
    async validateTarget() {
      return null;
    },
    async prepareSendBundle() {
      return { config: {}, model: 'scripted', providerName: 'Scripted', capabilities: { images: false } };
    },
    async streamRound({ messages, tools }) {
      requests.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (reply.toolCalls) {
        return {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: reply.toolCalls.map((call, i) => ({
              id: `call_${index}_${i}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
            })),
          },
          finishReason: 'tool_calls',
          usage: null,
        };
      }
      return { message: { role: 'assistant', content: reply.text ?? '' }, finishReason: 'stop', usage: null };
    },
    formatRoundError(err) {
      return String(err?.message || err);
    },
  };
}

/** Counts the rounds and keeps each round's usage and finish reason. */
function instrument(llm) {
  const rounds = [];
  return {
    rounds,
    llm: {
      ...llm,
      async streamRound(args) {
        const result = await llm.streamRound(args);
        rounds.push({
          finishReason: result?.finishReason ?? null,
          usage: result?.usage ?? null,
          toolCalls: Array.isArray(result?.message?.tool_calls) ? result.message.tool_calls.length : 0,
        });
        return result;
      },
    },
  };
}

function createBenchEngine({
  arm,
  llm,
  maxToolRounds = LIMITS.MAX_TOOL_ROUNDS,
  approvalLog = [],
  executions = [],
}) {
  const fsService = createFsService({
    fs: fsp,
    path,
    maxReadFileBytes: LIMITS.MAX_READ_FILE_BYTES,
    maxWriteFileBytes: LIMITS.MAX_WRITE_FILE_BYTES,
  });
  const registry = wrapRegistryForArm(createBenchRegistry(fsService, executions), arm);
  const tools = createWorkspaceToolAdapter(registry, { fsService, fs: fsp, path, protectedRoots: [] });
  return createChatEngine({
    llm,
    tools,
    preferences: { read: async () => ({ baseSystemPrompt: '', disabledTools: [] }) },
    workspacePaths: createNodeWorkspacePathAdapter({ path }),
    // The app's default mode: reads run, writes and commands ask.
    toolPolicy: {
      async read() {
        return { mode: 'smart', rules: [], sensitivePathPatterns: [], policyVersion: 'bench' };
      },
    },
    // Every question is answered "allow once", as a user who wants the task
    // done would — the benchmark judges the choice, the policy is not on trial.
    approvals: {
      isAvailable: () => true,
      async requestApproval({ request }) {
        approvalLog.push(request?.tool ?? request?.toolName ?? null);
        return { response: 'allow-once' };
      },
    },
    sessionGrants: createSessionGrants(),
    maxToolRounds,
  });
}

/**
 * A fresh copy of the fixture. The folder name reaches the system prompt, so
 * it is the same in every run — a random one would be noise of its own.
 */
async function prepareWorkspace() {
  const parent = await fsp.mkdtemp(path.join(os.tmpdir(), 'snotra-bench-'));
  const dir = path.join(parent, 'invoice-tool');
  await fsp.cp(FIXTURE, dir, { recursive: true });
  for (const [from, to] of Object.entries(FIXTURE_RENAMES)) {
    await fsp.rename(path.join(dir, from), path.join(dir, to));
  }
  return dir;
}

async function removeWorkspace(dir) {
  await fsp.rm(path.dirname(dir), { recursive: true, force: true });
}

async function readFilesFor(task, dir) {
  const out = {};
  for (const rel of Object.keys(task.expect?.files || {})) {
    try {
      out[rel] = await fsp.readFile(path.join(dir, rel), 'utf8');
    } catch {
      out[rel] = null;
    }
  }
  return out;
}

const TRANSIENT_CODES = new Set(['429', '500', '502', '503', '504', 'NETWORK']);

function compactArgs(args) {
  const out = {};
  for (const [key, value] of Object.entries(args || {})) {
    out[key] = typeof value === 'string' && value.length > 600 ? `${value.slice(0, 600)}…` : value;
  }
  return out;
}

/**
 * Runs one task once and returns the raw observation; scoring is separate.
 * `makeLlm` builds a fresh port per attempt.
 */
async function runTask({ task, arm, makeLlm, chatId, maxRetries = 4, sleep = defaultSleep }) {
  let retries = 0;
  for (;;) {
    const dir = await prepareWorkspace();
    try {
      const { llm, rounds } = instrument(makeLlm());
      const approvals = [];
      const executions = [];
      const engine = createBenchEngine({ arm, llm, approvalLog: approvals, executions });
      const started = Date.now();
      const result = await engine.send({
        sessionId: 'bench',
        payload: {
          messages: [{ role: 'user', content: task.prompt }],
          workspaceRoot: dir,
          chatId,
        },
        onEvent: () => {},
      });
      const code = result?.code ? String(result.code) : null;
      if (result?.error && TRANSIENT_CODES.has(code) && retries < maxRetries) {
        retries += 1;
        await sleep(2000 * 2 ** retries);
        continue;
      }
      const calls = (result?.toolTrace || []).map((entry) => ({
        tool: entry.tool,
        args: entry.args || {},
        round: entry.round ?? null,
        decision: entry.permission?.decision ?? null,
        // { kind: [paths] } since #187, e.g. { unknown: ['foo'] }.
        schema: entry.schema || null,
        // Denied before it ran: in the benchmark every card is allowed, so a
        // deny is the planner rejecting the arguments (or a hard limit).
        error: entry.permission?.decision === 'deny'
          ? `denied: ${entry.permission?.reason || 'unknown'}`
          : null,
      }));
      // The trace keeps no tool result; the executions run in the same order
      // as the allowed calls, so they are matched up by walking both.
      let next = 0;
      for (const call of calls) {
        if (call.decision !== 'allow' || executions[next]?.tool !== call.tool) continue;
        call.error = executions[next].error;
        next += 1;
      }
      return {
        calls,
        files: await readFilesFor(task, dir),
        rounds,
        approvals,
        result: {
          content: typeof result?.content === 'string' ? result.content.slice(0, 1500) : null,
          error: result?.error ? String(result.error?.text ?? result.error?.key ?? JSON.stringify(result.error)) : null,
          code,
          cancelled: result?.cancelled === true,
          usage: result?.usage ?? null,
        },
        durationMs: Date.now() - started,
        retries,
      };
    } finally {
      await removeWorkspace(dir);
    }
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  FIXTURE,
  STUB_RESULTS,
  compactArgs,
  createBenchEngine,
  createOpenAiLlm,
  createScriptedLlm,
  instrument,
  prepareWorkspace,
  removeWorkspace,
  runTask,
};
