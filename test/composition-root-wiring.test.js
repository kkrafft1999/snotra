'use strict';

// The composition root holds wiring and nothing else (#508, #1005).
//
// #510 cut create-application.js down to wiring; a year of features grew it
// back past where it started, with decisions in it again — the #419 fallback,
// the MCP settings test, the watcher-warning rate limit. This guard keeps the
// next one out. It reads the source, drops comments and string contents, and
// fails on:
//
//  - a branch (`if`, `? :`) whose condition is anything but "was this
//    optional dependency handed in" — the list below;
//  - a loop, a `switch`, a `try`/`catch`/`.catch(`, an `else`, a comparison,
//    the clock or a timer;
//  - more lines than the budget.
//
// When it fails: the decision belongs in a module next to its topic — a
// service, an adapter, an IPC handler module — with tests of its own, and the
// composition root calls it. Only an optional dependency of `createApplication`
// itself goes on the list, and only a real growth in wiring raises the budget,
// in a pull request that says why.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { codeOnly } = require('./helpers/code-only');

const ROOT_FILE = path.join(__dirname, '..', 'src', 'main', 'composition', 'create-application.js');

/** 938 lines when #1005 landed; room for a few services more, not for a feature. */
const LINE_BUDGET = 1000;

/** The only conditions a branch may test: whether an optional dependency was handed in. */
const ALLOWED_CONDITIONS = new Set([
  'manual',
  'watchFile',
  "shell && typeof shell.trashItem === ''",
  'Menu && shell',
  'Menu',
  'session && WebContentsView && shell',
  'shell',
]);

const lineOf = (code, index) => code.slice(0, index).split('\n').length;
const squash = (text) => text.replace(/\s+/g, ' ').trim();

/** The text inside the parenthesis that opens at `open`. */
function parenthesised(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return { text: code.slice(open + 1, i), end: i + 1 };
    }
  }
  return { text: code.slice(open + 1), end: code.length };
}

/** The operand in front of a `?`: back to the assignment, bracket, comma or `return` it stands after. */
function ternaryCondition(code, question) {
  let depth = 0;
  for (let i = question - 1; i >= 0; i -= 1) {
    const c = code[i];
    if (c === ')' || c === ']' || c === '}') depth += 1;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0) return { start: i + 1, text: code.slice(i + 1, question) };
      depth -= 1;
    } else if (depth === 0 && (c === ',' || c === ';' || c === ':')) {
      return { start: i + 1, text: code.slice(i + 1, question) };
    } else if (depth === 0 && c === '=' && !'=!<>'.includes(code[i - 1]) && code[i + 1] !== '=' && code[i + 1] !== '>') {
      return { start: i + 1, text: code.slice(i + 1, question) };
    } else if (depth === 0 && /\breturn$/.test(code.slice(0, i + 1))) {
      return { start: i + 1, text: code.slice(i + 1, question) };
    }
  }
  return { start: 0, text: code.slice(0, question) };
}

/** What makes a decision in `source`: each finding with its line. */
function findDecisions(source) {
  const code = codeOnly(source);
  const findings = [];
  // Spans already judged — an allowed condition may compare, the code around it may not.
  const judged = [];

  for (const match of code.matchAll(/\bif\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const { text, end } = parenthesised(code, open);
    const condition = squash(text);
    judged.push([open, end]);
    if (!ALLOWED_CONDITIONS.has(condition)) {
      findings.push({ line: lineOf(code, match.index), what: `if (${condition})` });
    }
  }
  for (const match of code.matchAll(/(?<![?])\?(?![.?])/g)) {
    const { start, text } = ternaryCondition(code, match.index);
    const condition = squash(text);
    judged.push([start, match.index + 1]);
    if (!ALLOWED_CONDITIONS.has(condition)) {
      findings.push({ line: lineOf(code, match.index), what: `${condition} ? …` });
    }
  }

  let rest = code;
  for (const [from, to] of judged) {
    rest = rest.slice(0, from) + rest.slice(from, to).replace(/[^\n]/g, ' ') + rest.slice(to);
  }
  rest = rest.replace(/=>/g, '  ');
  const forbidden = [
    [/(?<![.\w])(for|while|do|switch|try|catch|else)\b/g, (m) => `\`${m[0]}\``],
    [/\.catch\s*\(/g, () => '`.catch(`'],
    [/[!=]==?|[<>]=?/g, (m) => `comparison \`${m[0]}\``],
    [/\bDate\.now\b|\bnew Date\b|\bset(Timeout|Interval)\b/g, (m) => `\`${m[0]}\``],
  ];
  for (const [pattern, describe] of forbidden) {
    for (const match of rest.matchAll(pattern)) {
      findings.push({ line: lineOf(code, match.index), what: describe(match) });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

const report = (findings) => findings.map(({ line, what }) => `  create-application.js:${line}  ${what}`).join('\n');

test('the composition root makes no decisions of its own (#1005)', () => {
  const findings = findDecisions(fs.readFileSync(ROOT_FILE, 'utf8'));
  assert.deepEqual(
    findings,
    [],
    `The composition root wires; these look like decisions:\n${report(findings)}\n`
      + 'Move the logic into a module next to its topic and test it there (see the head of this test).',
  );
});

test(`the composition root stays within ${LINE_BUDGET} lines (#1005)`, () => {
  const lines = fs.readFileSync(ROOT_FILE, 'utf8').split('\n').length;
  assert.ok(lines <= LINE_BUDGET, `create-application.js has ${lines} lines, the budget is ${LINE_BUDGET}.`);
});

// The guard is only worth something if it catches what it is meant to. These
// are the pieces #1005 moved out, as they stood in the file.
test('the guard catches the decisions #1005 moved out', () => {
  const fallback = `
    applyMode: async (mode) => {
      const result = await toolPolicyStore.setMode(mode);
      if (!result?.ok && mode !== DEFAULT_TOOL_PERMISSION_MODE) await toolPolicyStore.setMode(DEFAULT_TOOL_PERMISSION_MODE);
    },`;
  assert.deepEqual(findDecisions(fallback).map((f) => f.what), [
    'if (!result?.ok && mode !== DEFAULT_TOOL_PERMISSION_MODE)',
  ]);

  const rateLimit = `
    return (error, dir) => {
      const now = Date.now();
      if (now - lastWarnedAt < WATCHER_WARNING_INTERVAL_MS) { heldBack += 1; return; }
      const more = heldBack > 0 ? \` (\${heldBack} more)\` : '';
    };`;
  assert.deepEqual(findDecisions(rateLimit).map((f) => f.what), [
    '`Date.now`',
    'if (now - lastWarnedAt < WATCHER_WARNING_INTERVAL_MS)',
    'heldBack > 0 ? …',
  ]);

  const mcpTest = `
    async function reloadMcpServers() {
      try { mcpService.setServers(await read()); } catch (error) { failed = true; throw error; }
    }`;
  assert.deepEqual(findDecisions(mcpTest).map((f) => f.what), ['`try`', '`catch`']);

  const defaults = `
    isEnabled: async () => (await uiPrefsStore.readUIPrefs()).approvalNotificationsEnabled !== false,
    start: () => migrate().catch(() => {}).then(() => reload()),`;
  assert.deepEqual(findDecisions(defaults).map((f) => f.what), ['comparison `!==`', '`.catch(`']);
});

test('the guard leaves wiring alone: optional dependencies, optional calls, fallbacks, comments and strings', () => {
  const wiring = `
    // if (this were code) it would count — but it is a comment, and so is: a ? b : c
    const notices = givenNotices || createAppNotices();
    const lookup = manual
      ? createManualLookup({ manual })
      : null;
    if (Menu) registerMenu({ Menu });
    const version = app?.getVersion?.() || '0.0.0';
    const started = () => updates.confirmInstallStarted?.() ?? Promise.resolve(false);
    const label = 'if (x) { for (;;) {} } a < b';
    const pattern = /a|b/;
    push(PUSH.SKILLS_CHANGED);
  `;
  assert.deepEqual(findDecisions(wiring), []);
});
