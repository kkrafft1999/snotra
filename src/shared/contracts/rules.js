/**
 * Rules files (#1275): the home of **rules** — statements of the form
 * *when X, then Y* — in the knowledge concept
 * (`docs/concepts/memory-and-rules-concept.md`).
 *
 * A rules file is a flat `.md` file in one of three folders, in skill order:
 * `<folder>/.agents/rules/`, `~/.snotra/rules/`, `~/.agents/rules/` (read only).
 * Its name is its file name. The front matter carries a `description` — the
 * condition under which the rule applies — and `always`, for rules whose
 * condition holds in every turn. An `always` file goes into the prompt in
 * full; every other one is listed with its description and loaded on demand
 * with `load_rule`, like a skill.
 *
 * CommonJS, so that main (require) and renderer (generated ESM bundle) read the
 * same rules.
 */
'use strict';

const { isRecord } = require('../runtime/is-record');
const { splitFrontmatter, parseFrontmatterLines } = require('../runtime/skill-frontmatter');
const { parseMemoryEntries } = require('./memory');

/** @typedef {typeof RULE_SOURCES[keyof typeof RULE_SOURCES]} RuleSource */
/** @typedef {typeof RULE_LEVELS[keyof typeof RULE_LEVELS]} RuleLevel */

const RULES_DIR = 'rules';

/** The tool that fetches the body of a rule from the catalogue. */
const LOAD_RULE_TOOL = 'load_rule';
const RULE_FILE_EXTENSION = '.md';

const RULE_SOURCES = Object.freeze({
  WORKSPACE: 'workspace',
  USER_SNOTRA: 'user-snotra',
  USER_AGENTS: 'user-agents',
});

/** Reading order — the order of the skill folders (#251). */
/** @type {readonly RuleSource[]} */
const RULE_SOURCE_ORDER = Object.freeze([
  RULE_SOURCES.WORKSPACE,
  RULE_SOURCES.USER_SNOTRA,
  RULE_SOURCES.USER_AGENTS,
]);

/** Who a rule speaks for: the open folder, or the user everywhere. */
const RULE_LEVELS = Object.freeze({
  WORKSPACE: 'workspace',
  USER: 'user',
});

/** @type {Readonly<Record<RuleSource, RuleLevel>>} */
const RULE_SOURCE_LEVELS = Object.freeze({
  [RULE_SOURCES.WORKSPACE]: RULE_LEVELS.WORKSPACE,
  [RULE_SOURCES.USER_SNOTRA]: RULE_LEVELS.USER,
  [RULE_SOURCES.USER_AGENTS]: RULE_LEVELS.USER,
});

/** The folder of each source, as it is shown: in the folder, or under the home folder. */
/** @type {Readonly<Record<RuleSource, string>>} */
const RULE_SOURCE_PATHS = Object.freeze({
  [RULE_SOURCES.WORKSPACE]: '.agents/rules',
  [RULE_SOURCES.USER_SNOTRA]: '~/.snotra/rules',
  [RULE_SOURCES.USER_AGENTS]: '~/.agents/rules',
});

/** How a level is named in the prompt — English, like the rest of it. */
/** @type {Readonly<Record<RuleLevel, string>>} */
const RULE_LEVEL_PROMPT_LABELS = Object.freeze({
  [RULE_LEVELS.WORKSPACE]: 'project',
  [RULE_LEVELS.USER]: 'global',
});

const RULE_LIMITS = Object.freeze({
  /** Files read per source; past that the rest is reported, not read. */
  FILES_PER_SOURCE: 50,
  NAME_CHARS: 64,
  DESCRIPTION_CHARS: 200,
  /** A body longer than this is cut visibly. */
  BODY_CHARS: 20_000,
  /** The `always` bodies of one level together — on top of memory's 8,000. */
  ALWAYS_CHARS_PER_LEVEL: 8_000,
  /** Beyond this many catalogue lines per level, the catalogue may drop descriptions. */
  CATALOGUE_ENTRIES_WITH_DESCRIPTION: 40,
});

const RULE_NAME_PATTERN = /^[a-z0-9-]+$/;

/** @param {unknown} name */
function isValidRuleName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= RULE_LIMITS.NAME_CHARS && RULE_NAME_PATTERN.test(name);
}

/** @param {unknown} value @returns {value is RuleSource} */
function isRuleSource(value) {
  return RULE_SOURCE_ORDER.some((source) => source === value);
}

/** @param {unknown} value @returns {value is RuleLevel} */
function isRuleLevel(value) {
  return value === RULE_LEVELS.WORKSPACE || value === RULE_LEVELS.USER;
}

/**
 * The rule name of a file name, or null when the file is not a rules file:
 * `answer-in-german.md` → `answer-in-german`.
 *
 * @param {unknown} fileName
 */
function ruleNameOfFile(fileName) {
  if (typeof fileName !== 'string' || !fileName.endsWith(RULE_FILE_EXTENSION)) return null;
  const name = fileName.slice(0, -RULE_FILE_EXTENSION.length);
  return isValidRuleName(name) ? name : null;
}

/** @param {string} value @param {number} max */
function clip(value, max) {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * A description for a file that has none (review 2026-10-31): its first
 * heading, without one its first line that is not empty.
 *
 * @param {string} body
 */
function deriveRuleDescription(body) {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const heading = lines.find((line) => /^#{1,6}\s+\S/.test(line));
  const source = heading ? heading.replace(/^#{1,6}\s+/, '') : (lines[0] || '').replace(/^[-*+]\s+/, '');
  return clip(source, RULE_LIMITS.DESCRIPTION_CHARS);
}

/**
 * @typedef {Object} ParsedRuleFile
 * @property {string} description
 * @property {boolean} descriptionDerived  the file had no `description`
 * @property {boolean} always
 * @property {string} body  the text after the front matter
 */

/**
 * Reads a rules file. A file without front matter is a body with a derived
 * description; unknown front-matter fields are ignored. Null for an empty file.
 *
 * @param {unknown} text
 * @returns {ParsedRuleFile|null}
 */
function parseRuleFile(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const split = splitFrontmatter(text);
  const frontmatter = split ? parseFrontmatterLines(split.frontmatterLines) : Object.create(null);
  const body = (split ? split.body : text.replace(/^﻿/, '')).replace(/^\n+/, '').trimEnd();
  const given = typeof frontmatter.description === 'string' ? clip(frontmatter.description, RULE_LIMITS.DESCRIPTION_CHARS) : '';
  const description = given || deriveRuleDescription(body);
  if (!description && !body.trim()) return null;
  const always = frontmatter.always === true || (typeof frontmatter.always === 'string' && frontmatter.always.trim().toLowerCase() === 'true');
  return { description, descriptionDerived: !given, always, body };
}

/**
 * The rules of a body: each list item one rule, with the date and the origin
 * marker a memory line carries. A hand-written line without a date stays valid.
 *
 * @param {unknown} body
 */
function parseRuleEntries(body) {
  return parseMemoryEntries(body);
}

/**
 * @typedef {Object} RuleFile
 * @property {RuleSource} source
 * @property {RuleLevel} level
 * @property {string} name
 * @property {string} description
 * @property {boolean} descriptionDerived
 * @property {boolean} always
 * @property {string} body
 * @property {boolean} truncated
 * @property {number} [mtimeMs]  when the file last changed; the newest `always` file gives way first
 * @property {boolean} [shadowed]  a file of the same name in an earlier source of the same level wins
 * @property {'masked'|'withheld'} [guard]
 * @property {Array<{kind: string, excerpt: string}>} [covertSignals]
 */

/**
 * One rules file as it comes from the port, checked. Null for anything that
 * is not a usable rule.
 *
 * @param {unknown} raw
 * @returns {RuleFile|null}
 */
function normalizeRuleFile(raw) {
  if (!isRecord(raw) || !isRuleSource(raw.source) || !isValidRuleName(raw.name)) return null;
  const body = typeof raw.body === 'string' ? raw.body : '';
  const description = typeof raw.description === 'string' ? clip(raw.description, RULE_LIMITS.DESCRIPTION_CHARS) : '';
  if (!description && !body.trim()) return null;
  /** @type {RuleFile} */
  const file = {
    source: raw.source,
    level: RULE_SOURCE_LEVELS[raw.source],
    name: raw.name,
    description,
    descriptionDerived: raw.descriptionDerived === true,
    always: raw.always === true,
    body,
    truncated: raw.truncated === true,
  };
  if (Number.isFinite(raw.mtimeMs)) file.mtimeMs = Number(raw.mtimeMs);
  if (raw.shadowed === true) file.shadowed = true;
  if (raw.guard === 'masked' || raw.guard === 'withheld') file.guard = raw.guard;
  if (Array.isArray(raw.covertSignals) && raw.covertSignals.length > 0) file.covertSignals = raw.covertSignals;
  return file;
}

/**
 * The files in reading order: source by source, alphabetically within one.
 * A reading order only — which rule wins in a contradiction, the prompt says.
 *
 * @param {unknown} raw
 * @returns {RuleFile[]}
 */
function normalizeRuleFiles(raw) {
  const list = Array.isArray(raw) ? raw.map(normalizeRuleFile).filter((file) => file !== null) : [];
  return list.sort((a, b) =>
    RULE_SOURCE_ORDER.indexOf(a.source) - RULE_SOURCE_ORDER.indexOf(b.source) || a.name.localeCompare(b.name));
}

/**
 * The id a switch and a context row know a file by.
 *
 * @param {{ source: string, name: string }} file
 */
function ruleFileId(file) {
  return `${file.source}:${file.name}`;
}

/**
 * The key a file is switched off by. A folder's file carries the folder, so
 * that switching off `deploy` in one project does not switch it off in all.
 *
 * @param {{ source: string, name: string }} file
 * @param {string|null|undefined} workspaceRoot
 */
function ruleSwitchKey(file, workspaceRoot) {
  return file.source === RULE_SOURCES.WORKSPACE ? `${file.source}:${workspaceRoot || ''}#${file.name}` : ruleFileId(file);
}

module.exports = {
  RULES_DIR,
  LOAD_RULE_TOOL,
  RULE_FILE_EXTENSION,
  RULE_SOURCES,
  RULE_SOURCE_ORDER,
  RULE_LEVELS,
  RULE_SOURCE_LEVELS,
  RULE_SOURCE_PATHS,
  RULE_LEVEL_PROMPT_LABELS,
  RULE_LIMITS,
  isValidRuleName,
  isRuleSource,
  isRuleLevel,
  ruleNameOfFile,
  deriveRuleDescription,
  parseRuleFile,
  parseRuleEntries,
  normalizeRuleFile,
  normalizeRuleFiles,
  ruleFileId,
  ruleSwitchKey,
};
