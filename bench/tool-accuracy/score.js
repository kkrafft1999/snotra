'use strict';

/**
 * Scores one run of one task (#186). Pure: the runner hands in the calls the
 * engine made and the content of the files the task looks at afterwards.
 */

const GROUPS = {
  write: ['write_file_text', 'edit_file', 'apply_patch', 'generate_image', 'remember'],
  execute: ['run_python', 'shell_execute'],
  network: ['web_search', 'fetch_url'],
};

// Keys whose values are paths, compared after normalisation: "./src/" = "src".
const PATH_KEYS = new Set(['relative_path', 'cwd']);

function normalisePath(value) {
  if (typeof value !== 'string') return value;
  let out = value.trim().replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  out = out.replace(/^\/+/, '').replace(/\/+$/, '');
  return out === '.' ? '' : out;
}

function matchValue(matcher, value, key, args) {
  if (typeof matcher === 'function') return matcher(value, args) === true;
  if (matcher instanceof RegExp) {
    if (value === undefined || value === null) return false;
    return matcher.test(typeof value === 'string' ? value : JSON.stringify(value));
  }
  if (PATH_KEYS.has(key) && typeof matcher === 'string') {
    return typeof value === 'string' && normalisePath(value) === normalisePath(matcher);
  }
  return value === matcher;
}

function toolsOf(spec) {
  return Array.isArray(spec.tool) ? spec.tool : [spec.tool];
}

function callHasTool(spec, call) {
  return toolsOf(spec).includes(call.tool);
}

function callHasArgs(spec, call) {
  const args = call.args && typeof call.args === 'object' ? call.args : {};
  return Object.entries(spec.args || {}).every(([key, matcher]) => matchValue(matcher, args[key], key, args));
}

function specsOf(expect) {
  if (expect.allOf) return { mode: 'all', specs: expect.allOf };
  if (expect.anyOf) return { mode: 'any', specs: expect.anyOf };
  return { mode: 'any', specs: [expect.call] };
}

function isForbidden(tool, forbid) {
  return forbid.some((entry) => {
    if (entry === 'any') return true;
    if (GROUPS[entry]) return GROUPS[entry].includes(tool);
    return entry === tool;
  });
}

function expectsWrite(task) {
  if (task.kind !== 'positive') return false;
  const { specs } = specsOf(task.expect);
  return specs.some((spec) => toolsOf(spec).some((tool) => GROUPS.write.includes(tool)));
}

/**
 * @param {object} task  an entry of tasks.js
 * @param {{ calls: Array<{tool: string, args: object, error?: string|null}>, files?: Record<string, string|null> }} run
 * @returns {{ toolChoice: boolean, params: boolean|null, files: boolean|null, correct: boolean,
 *   unexpectedWrite: boolean, forbiddenCalls: string[] }}
 */
function scoreTask(task, { calls = [], files = {} } = {}) {
  const writeExpected = expectsWrite(task);
  const unexpectedWrite = !writeExpected && calls.some((call) => GROUPS.write.includes(call.tool));

  if (task.kind === 'negative') {
    const forbiddenCalls = calls.filter((call) => isForbidden(call.tool, task.forbid)).map((call) => call.tool);
    const ok = forbiddenCalls.length === 0;
    return { toolChoice: ok, params: null, files: null, correct: ok, unexpectedWrite, forbiddenCalls };
  }

  const { mode, specs } = specsOf(task.expect);
  const pick = mode === 'all' ? 'every' : 'some';
  const toolChoice = specs[pick]((spec) => calls.some((call) => callHasTool(spec, call)));
  // Arguments the tool rejected are not right arguments, however well they match.
  const params = specs[pick]((spec) =>
    calls.some((call) => callHasTool(spec, call) && callHasArgs(spec, call) && !call.error));
  const fileChecks = Object.entries(task.expect.files || {});
  const filesOk = fileChecks.length === 0
    ? null
    : fileChecks.every(([relPath, check]) => {
      try {
        return check(files[relPath] ?? null) === true;
      } catch {
        return false;
      }
    });
  return {
    toolChoice,
    params,
    files: filesOk,
    correct: toolChoice && params && filesOk !== false,
    unexpectedWrite,
    forbiddenCalls: [],
  };
}

module.exports = { GROUPS, normalisePath, matchValue, scoreTask, specsOf, toolsOf };
