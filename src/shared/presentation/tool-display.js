/**
 * Workspace tool display lines (stage 5 — tool presentation).
 *
 * Single source of truth for the tool lines in the chat. Used by the ToolPort
 * adapter in the main process; the renderer only ever shows `line`.
 *
 * The wording comes from the catalogue (epic #277). This module runs in the
 * main process, so it cannot reach for the renderer's `t()` — it binds a
 * translator to the locale it is handed. That locale has been threaded through
 * since #289; until #290 nothing looked at it.
 */
'use strict';

const { parseQualifiedMcpToolName } = require('../contracts/mcp');
const { parseSkillPath } = require('../runtime/skill-path');
const { LOAD_SKILL_TOOL } = require('../contracts/skills');
const { DEFAULT_LOCALE, createTranslator } = require('../i18n');

function truncateToolLabel(value, max = 48) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Path label of a tool line. A skill path (`skill:name/rest`, issue #61) is
 * resolved into something readable, so that the chat still shows a read came
 * out of a skill directory rather than out of the project folder.
 */
function formatRelativePathForLabel(relativePath, t) {
  const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
  if (!raw || raw === '.') return null;
  const skill = parseSkillPath(raw);
  if (skill) {
    const name = truncateToolLabel(skill.name, 24);
    if (!skill.rest || skill.rest === '.') return t('tools.path.skill', { name });
    return t('tools.path.skillFile', { path: truncateToolLabel(skill.rest), name });
  }
  return truncateToolLabel(raw);
}

/**
 * Base key per tool. The four sentences of a line — start and done, each with
 * and without a target — hang below it. They sit in a table rather than at the
 * call sites because the alternative is the same five lines fourteen times
 * over; `test/i18n-keys.test.js` walks this table the way it walks the key
 * tables of the contract layer (#293), so nothing escapes the check.
 */
const TOOL_LINE_KEYS = Object.freeze({
  list_directory: 'tools.line.listDirectory',
  read_file_text: 'tools.line.readFileText',
  read_file_lines: 'tools.line.readFileLines',
  write_file_text: 'tools.line.writeFileText',
  edit_file: 'tools.line.editFile',
  apply_patch: 'tools.line.applyPatch',
  search_in_files: 'tools.line.searchInFiles',
  find_files: 'tools.line.findFiles',
  stat_path: 'tools.line.statPath',
  outline_file: 'tools.line.outlineFile',
  list_directory_tree: 'tools.line.listDirectoryTree',
  run_python: 'tools.line.runPython',
  shell_execute: 'tools.line.shellExecute',
  web_search: 'tools.line.webSearch',
  fetch_url: 'tools.line.fetchUrl',
});

/** The four suffixes every entry of TOOL_LINE_KEYS carries. */
const LINE_VARIANTS = Object.freeze(['start', 'done', 'start.plain', 'done.plain']);

/**
 * One tool line: the sentence with a target, or the one without when the
 * target is missing. Which of the two applies is all the callers decide — the
 * wording is entirely in the catalogue, so that German word order is never
 * assembled out of English parts (#290).
 */
function lineFor(t, tool, isDone, params) {
  const base = TOOL_LINE_KEYS[tool];
  const phase = isDone ? 'done' : 'start';
  const plain = !params || Object.values(params).every((value) => !value);
  return plain ? t(`${base}.${phase}.plain`) : t(`${base}.${phase}`, params);
}

function summarizeToolCall(toolName, args, phase = 'start', locale = DEFAULT_LOCALE) {
  const t = createTranslator(locale);
  const isDone = phase === 'done';
  const pathOf = () => formatRelativePathForLabel(args?.relative_path, t);
  // Ahead of the file tools: loading an instruction should read as a skill step
  // in the log, not as "file read" (issue #173).
  if (toolName === LOAD_SKILL_TOOL) {
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    return isDone
      ? (name ? t('tools.line.loadSkill.done', { name: truncateToolLabel(name, 24) }) : t('tools.line.loadSkill.done.plain'))
      : (name ? t('tools.line.loadSkill.start', { name: truncateToolLabel(name, 24) }) : t('tools.line.loadSkill.start.plain'));
  }
  if (toolName === 'list_directory') return lineFor(t, 'list_directory', isDone, { path: pathOf() });
  if (toolName === 'read_file_text') return lineFor(t, 'read_file_text', isDone, { path: pathOf() });
  if (toolName === 'read_file_lines') {
    const start = Number.isFinite(args?.start_line) ? Math.floor(args.start_line) : null;
    const end = Number.isFinite(args?.end_line) ? Math.floor(args.end_line) : null;
    let range = '';
    if (start !== null && end !== null) range = t('tools.line.readFileLines.range', { start, end });
    else if (start !== null) range = t('tools.line.readFileLines.rangeFrom', { start });
    // Path and range in that order in both languages; the word "file" and the
    // rest of the sentence around them come from the catalogue.
    const target = [pathOf(), range].filter(Boolean).join(' ');
    return lineFor(t, 'read_file_lines', isDone, { target });
  }
  if (toolName === 'write_file_text') return lineFor(t, 'write_file_text', isDone, { path: pathOf() });
  if (toolName === 'edit_file') return lineFor(t, 'edit_file', isDone, { path: pathOf() });
  if (toolName === 'apply_patch') return lineFor(t, 'apply_patch', isDone, { path: pathOf() });
  if (toolName === 'search_in_files') {
    const raw = typeof args?.query === 'string' ? args.query.trim() : '';
    return lineFor(t, 'search_in_files', isDone, { query: raw ? truncateToolLabel(raw, 32) : '' });
  }
  if (toolName === 'find_files') {
    const raw = typeof args?.pattern === 'string' ? args.pattern.trim() : '';
    return lineFor(t, 'find_files', isDone, { pattern: raw ? truncateToolLabel(raw, 32) : '' });
  }
  if (toolName === 'stat_path') return lineFor(t, 'stat_path', isDone, { path: pathOf() });
  if (toolName === 'outline_file') return lineFor(t, 'outline_file', isDone, { path: pathOf() });
  if (toolName === 'list_directory_tree') return lineFor(t, 'list_directory_tree', isDone, { path: pathOf() });
  if (toolName === 'run_python') {
    const count = String(args?.code ?? '').split('\n').filter((line) => line.trim()).length;
    // Spelled out rather than through `t.plural`, so that both forms stay
    // visible to the key scan in `test/i18n-keys.test.js`.
    const lines = count === 1
      ? t('tools.line.runPython.lines.one', { count })
      : t('tools.line.runPython.lines.other', { count });
    return lineFor(t, 'run_python', isDone, { lines: count > 0 ? lines : '' });
  }
  if (toolName === 'shell_execute') {
    // The command itself is the information — shortened so the line holds.
    const raw = typeof args?.command === 'string' ? args.command.trim().split('\n')[0] : '';
    return lineFor(t, 'shell_execute', isDone, { command: raw ? truncateToolLabel(raw, 48) : '' });
  }
  if (toolName === 'web_search') {
    const raw = typeof args?.query === 'string' ? args.query.trim() : '';
    return lineFor(t, 'web_search', isDone, { query: raw ? truncateToolLabel(raw, 40) : '' });
  }
  if (toolName === 'fetch_url') {
    // The host is enough: the full address blows up any line (issue #95).
    const raw = typeof args?.url === 'string' ? args.url.trim() : '';
    let host = '';
    if (raw) {
      try {
        host = new URL(raw).hostname || '';
      } catch {
        host = truncateToolLabel(raw, 40);
      }
    }
    return lineFor(t, 'fetch_url', isDone, { host });
  }
  // MCP tools (issue #107): the namespace `mcp__<server>__<tool>` is an
  // internal affair — in the log the server stands in front of the tool, so
  // that one can see whose tool is running without reading the machinery.
  const mcp = parseQualifiedMcpToolName(toolName);
  if (mcp) {
    const params = { server: truncateToolLabel(mcp.serverId), name: truncateToolLabel(mcp.name) };
    return isDone ? t('tools.line.mcp.done', params) : t('tools.line.mcp.start', params);
  }
  const name = toolName ? truncateToolLabel(toolName) : t('tools.line.generic.fallbackName');
  return isDone ? t('tools.line.generic.done', { name }) : t('tools.line.generic.start', { name });
}

/**
 * Addition from the permission audit (issue #66): a denial or a pending
 * approval should be recognisable in the chat without the renderer having to
 * interpret the decision itself.
 */
function permissionSuffix(entry, phase, t) {
  const permission = entry?.permission;
  if (!permission || typeof permission !== 'object') return '';
  if (phase === 'done' && permission.status === 'denied') {
    return permission.reason === 'user_denied'
      ? t('tools.line.suffix.denied')
      : t('tools.line.suffix.blocked');
  }
  if (phase !== 'done' && permission.status === 'awaiting-approval') {
    return t('tools.line.suffix.awaiting');
  }
  return '';
}

/**
 * Formats a tool trace entry into a display line. Strings that are already
 * formatted (persisted older sessions) pass through unchanged.
 */
function formatToolDisplayLine(entry, phase = 'start', locale = DEFAULT_LOCALE) {
  if (typeof entry === 'string') return entry;
  const t = createTranslator(locale);
  const parts = [summarizeToolCall(entry?.tool, entry?.args, phase, locale)];
  const suffix = permissionSuffix(entry, phase, t);
  if (suffix) parts.push(suffix);
  if (entry?.noWorkspace) parts.push(t('tools.line.suffix.noWorkspace'));
  return parts.join(' · ');
}

module.exports = {
  LINE_VARIANTS,
  TOOL_LINE_KEYS,
  truncateToolLabel,
  formatToolDisplayLine,
  summarizeToolCall,
};
