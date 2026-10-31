/**
 * Writing knowledge with `remember` (#1276): what it is — a fact, a rule or a
 * procedure — and who reads it — the user, Snotra in this folder, or every
 * tool in this folder through `AGENTS.md`. The concept:
 * `docs/concepts/memory-and-rules-concept.md`, sections *Where knowledge goes*
 * and *Writing: remember*.
 *
 * Pure text functions over the files, shared by main (the writer) and the
 * tests. CommonJS, like every contract.
 */
'use strict';

const { APP_LOCALES } = require('./enums');
const { formatMemoryEntryLine, parseMemoryEntries } = require('./memory');
const { RULE_LIMITS } = require('./rules');

/** @typedef {typeof KNOWLEDGE_KINDS[keyof typeof KNOWLEDGE_KINDS]} KnowledgeKind */
/**
 * What a `remember` card shows (#1276): the proposal, what the writer found,
 * and what only the run knows.
 *
 * @typedef {Object} KnowledgeCard
 * @property {string} kind
 * @property {string} scope
 * @property {string} entry
 * @property {string} origin
 * @property {string} [topic]
 * @property {string} [description]  a new description, for a rule
 * @property {boolean} [always]
 * @property {{ path: string, exists: boolean, file: string }|null} target
 * @property {{ description: string, always: boolean }} [ruleFile]  the existing rules file
 * @property {{ text: string, where: string, count: number }} [replaced]
 * @property {Record<string, Record<string, { path: string, exists: boolean, file: string }|null>>} alternatives
 * @property {{ agentsMd: boolean, rulesFiles: number }} folderInstructions
 * @property {boolean} [switchedOff]
 * @property {boolean} [alwaysOverBudget]
 */
/** @typedef {typeof KNOWLEDGE_READERS[keyof typeof KNOWLEDGE_READERS]} KnowledgeReader */

const KNOWLEDGE_KINDS = Object.freeze({
  FACT: 'fact',
  RULE: 'rule',
  INSTRUCTION: 'instruction',
});

const KNOWLEDGE_READERS = Object.freeze({
  USER: 'user',
  WORKSPACE: 'workspace',
  TEAM: 'team',
});

/** @type {readonly KnowledgeKind[]} */
const KNOWLEDGE_KIND_ORDER = Object.freeze([KNOWLEDGE_KINDS.FACT, KNOWLEDGE_KINDS.RULE, KNOWLEDGE_KINDS.INSTRUCTION]);
/** @type {readonly KnowledgeReader[]} */
const KNOWLEDGE_READER_ORDER = Object.freeze([KNOWLEDGE_READERS.USER, KNOWLEDGE_READERS.WORKSPACE, KNOWLEDGE_READERS.TEAM]);

/** @param {unknown} value @returns {value is KnowledgeKind} */
function isKnowledgeKind(value) {
  return KNOWLEDGE_KIND_ORDER.some((kind) => kind === value);
}

/** @param {unknown} value @returns {value is KnowledgeReader} */
function isKnowledgeReader(value) {
  return KNOWLEDGE_READER_ORDER.some((reader) => reader === value);
}

/**
 * The heading of Snotra's own section at the end of `AGENTS.md`, in the
 * interface language. What the team wrote above it is never touched.
 */
const SNOTRA_SECTION_HEADINGS = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  [APP_LOCALES.EN]: '## Added by Snotra',
  [APP_LOCALES.DE]: '## Von Snotra ergänzt',
}));

/** @param {string} line */
function isSnotraHeading(line) {
  const trimmed = line.trim();
  return Object.values(SNOTRA_SECTION_HEADINGS).some((heading) => heading === trimmed);
}

/**
 * `AGENTS.md` with one more line in Snotra's section — the section created at
 * the end when missing, the file created when empty.
 *
 * @param {unknown} currentText
 * @param {string} line  a formatted entry line
 * @param {unknown} locale
 */
function appendToSnotraSection(currentText, line, locale) {
  const text = typeof currentText === 'string' ? currentText.replace(/\s+$/, '') : '';
  const heading = SNOTRA_SECTION_HEADINGS[locale === APP_LOCALES.DE ? APP_LOCALES.DE : APP_LOCALES.EN];
  const lines = text ? text.split(/\r?\n/) : [];
  const at = lines.findIndex(isSnotraHeading);
  if (at === -1) return `${text ? `${text}\n\n` : ''}${heading}\n\n${line}\n`;
  // The section runs to the next heading of the same or a higher level, or the end.
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let insert = end;
  while (insert > at + 1 && !lines[insert - 1].trim()) insert -= 1;
  lines.splice(insert, 0, line);
  return `${lines.join('\n')}\n`;
}

/**
 * The text of a new rules file: front matter with the description and, when
 * set, `always`, then the first entry.
 *
 * @param {{ description: string, always?: boolean, line: string }} file
 */
function newRuleFileText({ description, always = false, line }) {
  const head = ['---', `description: ${description.replace(/\s+/g, ' ').trim()}`];
  if (always) head.push('always: true');
  head.push('---');
  return `${head.join('\n')}\n\n${line}\n`;
}

/**
 * A rules file with one more entry, and — when given — a new description in
 * its front matter. `always` is not changed: an existing file keeps it.
 *
 * @param {string} currentText
 * @param {{ line: string, description?: string }} change
 */
function appendRuleEntry(currentText, { line, description }) {
  let text = currentText.replace(/\s+$/, '');
  if (description) {
    const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    const value = description.replace(/\s+/g, ' ').trim();
    if (fence) {
      const head = fence[1].split(/\r?\n/);
      const at = head.findIndex((entry) => /^description\s*:/.test(entry));
      if (at === -1) head.unshift(`description: ${value}`);
      else head[at] = `description: ${value}`;
      text = `---\n${head.join('\n')}\n---${text.slice(fence[0].length)}`;
    } else {
      text = `---\ndescription: ${value}\n---\n\n${text}`;
    }
  }
  return `${text}\n${line}\n`;
}

/**
 * Removes the list items whose entry text is exactly `entry` — dated or not,
 * with or without origin marker. Front matter and headings are never matched.
 *
 * @param {unknown} currentText
 * @param {string} entry
 * @returns {{ text: string, removed: number }}
 */
function removeEntriesByText(currentText, entry) {
  const text = typeof currentText === 'string' ? currentText : '';
  const wanted = entry.replace(/\s+/g, ' ').trim();
  if (!text || !wanted) return { text, removed: 0 };
  const lines = text.split(/\r?\n/);
  const drop = new Set(parseMemoryEntries(text).filter((item) => item.text.replace(/\s+/g, ' ').trim() === wanted).map((item) => item.line));
  if (drop.size === 0) return { text, removed: 0 };
  return { text: lines.filter((_, index) => !drop.has(index)).join('\n'), removed: drop.size };
}

/**
 * How many list items carry exactly this entry text.
 *
 * @param {unknown} currentText
 * @param {string} entry
 */
function countEntries(currentText, entry) {
  const wanted = entry.replace(/\s+/g, ' ').trim();
  return typeof currentText === 'string' && wanted
    ? parseMemoryEntries(currentText).filter((item) => item.text.replace(/\s+/g, ' ').trim() === wanted).length
    : 0;
}

/** The line an entry is written as — the memory format, shared by rules and `AGENTS.md`. */
const formatKnowledgeLine = formatMemoryEntryLine;

module.exports = {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_READERS,
  KNOWLEDGE_KIND_ORDER,
  KNOWLEDGE_READER_ORDER,
  SNOTRA_SECTION_HEADINGS,
  RULE_FILE_LIMIT: RULE_LIMITS.BODY_CHARS,
  isKnowledgeKind,
  isKnowledgeReader,
  appendToSnotraSection,
  newRuleFileText,
  appendRuleEntry,
  removeEntriesByText,
  countEntries,
  formatKnowledgeLine,
};
