/**
 * Workspace tool display lines (stage 5 — tool presentation).
 *
 * Formats the tool lines in the chat. Which sentence a tool gets is part of its
 * descriptor (#1008): the registry definition names a catalogue key and one of
 * the TOOL_LINE_TARGETS below. Used by the ToolPort adapter in the main
 * process; the renderer only ever shows `line`.
 *
 * The wording comes from the catalogue (epic #277). This module runs in the
 * main process, so it cannot reach for the renderer's `t()` — it binds a
 * translator to the locale it is handed. That locale has been threaded through
 * since #289; until #290 nothing looked at it.
 */
'use strict';

const { parseQualifiedMcpToolName } = require('../contracts/mcp');
const { parseSkillPath } = require('../runtime/skill-path');
const { workspaceSkillOfPath } = require('../contracts/skills');
const { isRecord } = require('../runtime/is-record');
const { DEFAULT_LOCALE, createTranslator } = require('../i18n');

/**
 * @typedef {import('../../application/ports/tool-port').ToolTraceEntry} ToolTraceEntry
 * @typedef {import('../../application/ports/tool-port').ToolArguments} ToolArguments
 * @typedef {(key: string, params?: Record<string, unknown>) => string} Translate
 */

/**
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
function truncateToolLabel(value, max = 48) {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/**
 * Path label of a tool line. A skill path (`skill:name/rest`, issue #61) is
 * resolved into something readable, so that the chat still shows a read came
 * out of a skill directory rather than out of the project folder.
 *
 * @param {unknown} relativePath
 * @param {Translate} t
 * @returns {string|null}
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
 * Path label of a writing tool. A file of a skill in the open folder
 * (`.agents/skills/<name>/…`) reads as part of that skill, so writing a skill
 * shows up as such in the log rather than as one more file (#160).
 *
 * @param {unknown} relativePath
 * @param {Translate} t
 * @returns {string|null}
 */
function formatWrittenPathForLabel(relativePath, t) {
  const skill = typeof relativePath === 'string' ? workspaceSkillOfPath(relativePath) : null;
  if (skill) {
    return t('tools.path.skillFile', { path: truncateToolLabel(skill.file), name: truncateToolLabel(skill.name, 24) });
  }
  return formatRelativePathForLabel(relativePath, t);
}

/**
 * What a tool line names besides the step itself (#1008). A tool's descriptor
 * (`display: { key, target }` on its registry definition) picks one of these;
 * the extraction lives here, once, because several tools share each kind.
 */
const TOOL_LINE_TARGETS = Object.freeze({
  /** Nothing to name but the step (#773): `<key>.start` / `<key>.done`. */
  NONE: 'none',
  /** The path the tool reads or looks at. */
  PATH: 'path',
  /** The path a writing tool writes; a skill file reads as part of its skill (#160). */
  WRITTEN_PATH: 'written-path',
  /** Path and line range of a partial read. */
  LINE_RANGE: 'line-range',
  /** A text search, shortened to 32 characters. */
  SEARCH_QUERY: 'search-query',
  /** A file name pattern, shortened to 32 characters. */
  FILE_PATTERN: 'file-pattern',
  /** How many lines a program has. */
  CODE_LINES: 'code-lines',
  /** The first line of a shell command. */
  COMMAND: 'command',
  /** A search query, shortened to 40 characters. */
  QUERY: 'query',
  /** A page of the manual and its section (#947). */
  MANUAL_PAGE: 'manual-page',
  /** Where a memory entry went (#555). */
  MEMORY_SCOPE: 'memory-scope',
  /** The host of an address (#95). */
  HOST: 'host',
  /** The skill whose instructions are loaded (#173). */
  SKILL_NAME: 'skill-name',
  /** The rule that is fetched, and its level (#1275). */
  RULE_NAME: 'rule-name',
  /** A proposal and how it ended (#774); the entry carries the outcome. */
  CONFIG_PROPOSAL: 'config-proposal',
});

/** The four suffixes below a line key whose target can be missing. */
const LINE_VARIANTS = Object.freeze(['start', 'done', 'start.plain', 'done.plain']);

/** @type {Set<unknown>} */
const TARGET_VALUES = new Set(Object.values(TOOL_LINE_TARGETS));

/**
 * Whether a descriptor's `display` names a key and a known target.
 *
 * @typedef {{ key: string, target: string }} ToolLineDisplay
 * @param {unknown} display
 * @returns {display is ToolLineDisplay}
 */
function isToolLineDisplay(display) {
  return isRecord(display)
    && typeof display.key === 'string'
    && /^tools\.line\.[\w.]+$/.test(display.key)
    && TARGET_VALUES.has(display.target);
}

/**
 * The catalogue keys a display needs — for the key test, which cannot see
 * keys that are put together (#293). A proposal's keys are written out in
 * `proposalLine` and seen by the text scan.
 *
 * @param {unknown} display
 * @returns {string[]}
 */
function lineKeysOf(display) {
  if (!isToolLineDisplay(display) || display.target === TOOL_LINE_TARGETS.CONFIG_PROPOSAL) return [];
  if (display.target === TOOL_LINE_TARGETS.NONE) return [`${display.key}.start`, `${display.key}.done`];
  return LINE_VARIANTS.map((variant) => `${display.key}.${variant}`);
}

/**
 * @param {ToolArguments|null|undefined} args
 * @param {string} name
 * @returns {string}
 */
function trimmedArg(args, name) {
  const value = args?.[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * The placeholders of a line per target. Each returns the values the
 * sentence with a target needs; all of them empty means the plain sentence.
 *
 * @type {Readonly<Record<string, (args: ToolArguments|null|undefined, t: Translate) => Record<string, unknown>>>}
 */
const TARGET_PARAMS = Object.freeze({
  [TOOL_LINE_TARGETS.PATH]: (args, t) => ({ path: formatRelativePathForLabel(args?.relative_path, t) }),
  [TOOL_LINE_TARGETS.WRITTEN_PATH]: (args, t) => ({ path: formatWrittenPathForLabel(args?.relative_path, t) }),
  [TOOL_LINE_TARGETS.LINE_RANGE]: (args, t) => {
    const start = Number.isFinite(args?.start_line) ? Math.floor(args?.start_line) : null;
    const end = Number.isFinite(args?.end_line) ? Math.floor(args?.end_line) : null;
    let range = '';
    if (start !== null && end !== null) range = t('tools.line.readFileLines.range', { start, end });
    else if (start !== null) range = t('tools.line.readFileLines.rangeFrom', { start });
    // Path and range in that order in both languages; the word "file" and the
    // rest of the sentence around them come from the catalogue.
    return { target: [formatRelativePathForLabel(args?.relative_path, t), range].filter(Boolean).join(' ') };
  },
  [TOOL_LINE_TARGETS.SEARCH_QUERY]: (args) => {
    const raw = trimmedArg(args, 'query');
    return { query: raw ? truncateToolLabel(raw, 32) : '' };
  },
  [TOOL_LINE_TARGETS.FILE_PATTERN]: (args) => {
    const raw = trimmedArg(args, 'pattern');
    return { pattern: raw ? truncateToolLabel(raw, 32) : '' };
  },
  [TOOL_LINE_TARGETS.CODE_LINES]: (args, t) => {
    const count = String(args?.code ?? '').split('\n').filter((line) => line.trim()).length;
    // Spelled out rather than through `t.plural`, so that both forms stay
    // visible to the key scan in `test/i18n-keys.test.js`.
    const lines = count === 1
      ? t('tools.line.runPython.lines.one', { count })
      : t('tools.line.runPython.lines.other', { count });
    return { lines: count > 0 ? lines : '' };
  },
  [TOOL_LINE_TARGETS.COMMAND]: (args) => {
    // The command itself is the information — shortened so the line holds.
    const raw = typeof args?.command === 'string' ? args.command.trim().split('\n')[0] : '';
    return { command: raw ? truncateToolLabel(raw, 48) : '' };
  },
  [TOOL_LINE_TARGETS.QUERY]: (args) => {
    const raw = trimmedArg(args, 'query');
    return { query: raw ? truncateToolLabel(raw, 40) : '' };
  },
  [TOOL_LINE_TARGETS.MANUAL_PAGE]: (args) => {
    // The slug names the page in both languages; the section, when there is
    // one, is what the model was after (#947).
    const slug = trimmedArg(args, 'slug');
    const anchor = trimmedArg(args, 'anchor').replace(/^#/, '');
    return { page: slug ? truncateToolLabel(anchor ? `${slug}#${anchor}` : slug, 48) : '' };
  },
  [TOOL_LINE_TARGETS.MEMORY_SCOPE]: (args, t) => {
    // Where the entry went, not that a tool ran (#555): it goes along with
    // every request from now on. Literal keys, so the key scan sees them; a
    // rule goes into the rules files, `team` into AGENTS.md (#1276).
    const rule = args?.kind === 'rule';
    let scope = '';
    if (args?.scope === 'team') scope = t('tools.line.remember.scope.team');
    else if (args?.scope === 'user') scope = rule ? t('tools.line.remember.scope.userRules') : t('tools.line.remember.scope.user');
    else if (args?.scope === 'workspace') scope = rule ? t('tools.line.remember.scope.workspaceRules') : t('tools.line.remember.scope.workspace');
    return { scope };
  },
  [TOOL_LINE_TARGETS.HOST]: (args) => {
    // The host is enough: the full address blows up any line (issue #95).
    const raw = trimmedArg(args, 'url');
    let host = '';
    if (raw) {
      try {
        host = new URL(raw).hostname || '';
      } catch {
        host = truncateToolLabel(raw, 40);
      }
    }
    return { host };
  },
  [TOOL_LINE_TARGETS.SKILL_NAME]: (args) => {
    const name = trimmedArg(args, 'name');
    return { name: name ? truncateToolLabel(name, 24) : '' };
  },
  [TOOL_LINE_TARGETS.RULE_NAME]: (args, t) => {
    const name = trimmedArg(args, 'name');
    if (!name) return { name: '', level: '' };
    // Two literal keys, so the key scan sees both.
    const level = args?.scope === 'user' ? t('tools.line.loadRule.level.user') : t('tools.line.loadRule.level.workspace');
    return { name: truncateToolLabel(name, 24), level };
  },
});

/**
 * One tool line: the sentence with a target, or the one without when the
 * target is missing. Which of the two applies is all the callers decide — the
 * wording is entirely in the catalogue, so that German word order is never
 * assembled out of English parts (#290).
 *
 * @param {Translate} t
 * @param {string} base
 * @param {boolean} isDone
 * @param {Record<string, unknown>} [params]
 * @returns {string}
 */
function lineFor(t, base, isDone, params) {
  const phase = isDone ? 'done' : 'start';
  const plain = !params || Object.values(params).every((value) => !value);
  return plain ? t(`${base}.${phase}.plain`) : t(`${base}.${phase}`, params);
}

/**
 * The line of one call. `display` is the tool's descriptor entry; without one
 * the tool is an MCP tool or unknown, and the line names it as such.
 *
 * @param {unknown} toolName
 * @param {ToolArguments|null|undefined} args
 * @param {string} [phase]
 * @param {unknown} [locale]
 * @param {ToolLineDisplay | null} [display]
 * @returns {string}
 */
function summarizeToolCall(toolName, args, phase = 'start', locale = DEFAULT_LOCALE, display = null) {
  const t = createTranslator(locale);
  const isDone = phase === 'done';
  if (isToolLineDisplay(display) && display.target !== TOOL_LINE_TARGETS.CONFIG_PROPOSAL) {
    if (display.target === TOOL_LINE_TARGETS.NONE) return t(`${display.key}.${isDone ? 'done' : 'start'}`);
    return lineFor(t, display.key, isDone, TARGET_PARAMS[display.target](args, t));
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
 *
 * @param {ToolTraceEntry|null|undefined} entry
 * @param {string} phase
 * @param {Translate} t
 * @returns {string}
 */
function permissionSuffix(entry, phase, t) {
  const permission = entry?.permission;
  if (!isRecord(permission)) return '';
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
/**
 * A proposal's line (#774) says what was proposed and, once done, how it
 * ended — the engine records the outcome on the entry. A refused proposal
 * drops the name: it may be one the catalogue does not know.
 *
 * @param {ToolTraceEntry|null|undefined} entry
 * @param {string} phase
 * @param {Translate} t
 * @returns {string}
 */
function proposalLine(entry, phase, t) {
  const args = entry?.args || {};
  const name = typeof args.name === 'string' ? truncateToolLabel(args.name.trim(), 32) : '';
  const direction = args.enable === false ? 'off' : 'on';
  if (phase !== 'done') {
    if (!name) return t('tools.line.proposeConfig.refused');
    return direction === 'off'
      ? t('tools.line.proposeConfig.start.off', { name })
      : t('tools.line.proposeConfig.start.on', { name });
  }
  const outcome = entry?.configProposal?.outcome;
  if (outcome === 'accepted') {
    return direction === 'off'
      ? t('tools.line.proposeConfig.accepted.off', { name })
      : t('tools.line.proposeConfig.accepted.on', { name });
  }
  if (outcome === 'declined') {
    return direction === 'off'
      ? t('tools.line.proposeConfig.declined.off', { name })
      : t('tools.line.proposeConfig.declined.on', { name });
  }
  if (outcome === 'suppressed') return t('tools.line.proposeConfig.suppressed', { name });
  return t('tools.line.proposeConfig.refused');
}

/**
 * @param {ToolTraceEntry|string} entry  a tool trace entry
 * @param {string} [phase]
 * @param {unknown} [locale]
 * @param {{ key: string, target: string }|null} [display]  the tool's descriptor entry
 * @returns {string}
 */
function formatToolDisplayLine(entry, phase = 'start', locale = DEFAULT_LOCALE, display = null) {
  if (typeof entry === 'string') return entry;
  const t = createTranslator(locale);
  if (display?.target === TOOL_LINE_TARGETS.CONFIG_PROPOSAL) return proposalLine(entry, phase, t);
  // A skill file reached by its absolute path is shown in the skill's own
  // spelling, which the planner worked out (#427).
  const args = typeof entry?.skillPath === 'string' && entry.skillPath
    ? { ...(entry.args || {}), relative_path: entry.skillPath }
    : entry?.args;
  const parts = [summarizeToolCall(entry?.tool, args, phase, locale, display)];
  const suffix = permissionSuffix(entry, phase, t);
  if (suffix) parts.push(suffix);
  if (entry?.noWorkspace) parts.push(t('tools.line.suffix.noWorkspace'));
  // The output was cut to fit the context budget (#169).
  if (phase === 'done' && entry?.shortened) parts.push(t('tools.line.suffix.shortened'));
  return parts.join(' · ');
}

module.exports = {
  LINE_VARIANTS,
  TOOL_LINE_TARGETS,
  isToolLineDisplay,
  lineKeysOf,
  truncateToolLabel,
  formatToolDisplayLine,
  summarizeToolCall,
};
