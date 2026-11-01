'use strict';

/**
 * Hints for memory and rules files (#1279): the review *Settings › Knowledge*
 * shows next to the entries, without a model call
 * (`docs/concepts/memory-and-rules-concept.md`, *Review and migration › Hints
 * in the settings*).
 *
 * Pure functions over the memory files and the rules files of both levels.
 * What a single entry reads like — a rule, a procedure, an episode — is the
 * judgement `remember` gives on its result (`shared/contracts/knowledge-hints.js`,
 * #1277), so both say the same about the same text. What needs more than one
 * entry is decided here: nearly the same, similar topic names, the age of an
 * entry and how full a file is.
 *
 * Deliberately cautious, like the hints of `remember`: a hint only points at a
 * candidate, and one that is wrong is dismissed for that entry. Every hint
 * carries a `key` that stays the same as long as the entry's words and place
 * do; the caller keeps the dismissed keys.
 */

const { knowledgeHints, KNOWLEDGE_HINTS } = require('../../shared/contracts/knowledge-hints');
const { parseMemoryEntries, MAX_MEMORY_CHARS, MEMORY_SCOPES } = require('../../shared/contracts/memory');
const { parseRuleEntries, RULE_LIMITS } = require('../../shared/contracts/rules');

const REVIEW_HINTS = Object.freeze({
  ...KNOWLEDGE_HINTS,
  NEARLY_THE_SAME: 'nearlyTheSame',
  SIMILAR_TOPIC_NAMES: 'similarTopicNames',
  NOTED_A_WHILE_AGO: 'notedAWhileAgo',
  CLOSE_TO_LIMIT: 'closeToLimit',
});

const REVIEW_LIMITS = Object.freeze({
  /** Share of words two entries have in common to count as nearly the same. */
  NEARLY_THE_SAME: 0.8,
  /** Days after which an entry's date earns "still true?". */
  NOTED_DAYS: 180,
  /** Share of a file's limit from which it is close to it. */
  CLOSE_TO_LIMIT: 0.8,
  /** Entries compared pairwise at most — beyond that the list is cut, not the app. */
  COMPARED_ENTRIES: 2000,
  /** Shortest name two topic names may differ in by one letter. */
  SIMILAR_NAME_MIN_CHARS: 5,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The words of a text, lower case, each once — letters and digits of any
 * script, so that the overlap does not depend on the language.
 *
 * @param {string} text
 * @returns {string[]}
 */
function wordsOf(text) {
  return [...new Set(String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
}

/**
 * The share of words two entries have in common, measured against the longer
 * one: "Answer in German." and "Always answer in German." share 3 of 4 words.
 * The longer one is the stricter reading — an entry that adds a condition is
 * not the same entry.
 *
 * @param {string[]} a  words, from wordsOf
 * @param {string[]} b
 */
function wordOverlap(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  const other = new Set(b);
  const shared = a.filter((word) => other.has(word)).length;
  return shared / Math.max(a.length, b.length);
}

/** FNV-1a, 32 bit: a short, stable fingerprint of an entry's words. */
function fingerprint(/** @type {string} */ text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** @param {string} a @param {string} b */
function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue; }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else { i += 1; j += 1; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * A topic name without what does not make it another topic: hyphens and a
 * plural `s` at the end of a part (`commit-messages` → `commitmessage`).
 *
 * @param {string} name
 */
function topicStem(name) {
  return name.split('-').map((part) => (part.length > 3 ? part.replace(/s$/, '') : part)).join('');
}

/**
 * Whether two rules file names differ only slightly: `commit` and `commits`,
 * `git-workflow` and `gitworkflow`, `regel` and `regeln`. Names with digits
 * only match after the stem — `api-v1` and `api-v2` are two topics.
 *
 * @param {string} a
 * @param {string} b
 */
function similarTopicNames(a, b) {
  if (a === b) return false;
  const stemA = topicStem(a);
  const stemB = topicStem(b);
  if (stemA === stemB) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  return Math.min(stemA.length, stemB.length) >= REVIEW_LIMITS.SIMILAR_NAME_MIN_CHARS && editDistanceAtMostOne(stemA, stemB);
}

/**
 * Days between an entry's `YYYY-MM-DD` and now; null without a date.
 *
 * @param {string|null} date
 * @param {Date} now
 */
function ageInDays(date, now) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '');
  if (!match) return null;
  const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(at) ? Math.floor((now.getTime() - at) / DAY_MS) : null;
}

/**
 * @typedef {Object} ReviewMemoryFile
 * @property {'workspace'|'user'} scope
 * @property {string} text
 * @property {string} key  where the file lives, stable per folder — part of every dismissal key
 *
 * @typedef {Object} ReviewRuleFile
 * @property {'workspace'|'user'} level
 * @property {string} source
 * @property {string} name
 * @property {string} body
 * @property {boolean} [always]
 * @property {boolean} [on]  switched on; only those count against the `always` budget
 * @property {boolean} [shadowed]
 * @property {boolean} [truncated]
 * @property {string} key  ruleSwitchKey of the file
 *
 * @typedef {{ kind: 'memory', scope: string, line: number, date: string|null, text: string }
 *   | { kind: 'rule', level: string, source: string, name: string, line: number, date: string|null, text: string }
 *   | { kind: 'memoryFile', scope: string }
 *   | { kind: 'ruleFile', level: string, source: string, name: string }
 *   | { kind: 'rulesLevel', level: string }} ReviewTarget
 *
 * `line` is the entry's line in the memory file, or in the rules file's body
 * (after the front matter) — the line and the text together name it, as
 * forgetting a memory entry does.
 *
 * @typedef {Object} ReviewHint
 * @property {string} id  a value of REVIEW_HINTS
 * @property {string} key  dismissal key
 * @property {boolean} dismissible  false for a state that has no action (close to the limit)
 * @property {ReviewTarget} at
 * @property {ReviewTarget} [with]  the other entry or file (nearly the same, similar topic names)
 * @property {boolean} [alsoGlobal]  nearly the same as an entry of the global level
 * @property {string} [date]  noted a while ago: the entry's date
 * @property {number} [share]  close to the limit: the share of the file's limit used, 0…1+
 * @property {boolean} [budgetUsedUp]  close to the limit: the level's `always` budget
 */

/**
 * Every hint for the memory and rules files of both levels.
 *
 * @param {Object} input
 * @param {ReviewMemoryFile[]} [input.memory]
 * @param {ReviewRuleFile[]} [input.rules]
 * @param {Date} [input.now]
 * @param {Iterable<string>} [input.dismissed]  keys of hints dismissed before
 * @returns {ReviewHint[]}
 */
function reviewKnowledge({ memory = [], rules = [], now = new Date(), dismissed = [] } = {}) {
  /** @type {ReviewHint[]} */
  const hints = [];
  /** @type {Array<{ at: any, level: string, words: string[], key: string, file: string }>} */
  const entries = [];

  for (const file of memory) {
    for (const entry of parseMemoryEntries(file.text)) {
      const at = { kind: 'memory', scope: file.scope, line: entry.line, date: entry.date, text: entry.text };
      entries.push({ at, level: file.scope, words: wordsOf(entry.text), key: '', file: file.key });
    }
    if (file.text.length >= REVIEW_LIMITS.CLOSE_TO_LIMIT * MAX_MEMORY_CHARS) {
      hints.push({
        id: REVIEW_HINTS.CLOSE_TO_LIMIT, key: `${REVIEW_HINTS.CLOSE_TO_LIMIT}|${file.key}`, dismissible: false,
        at: { kind: 'memoryFile', scope: file.scope }, share: file.text.length / MAX_MEMORY_CHARS,
      });
    }
  }

  /** @type {Map<string, number>} */
  const alwaysChars = new Map();
  for (const file of rules) {
    if (!file.shadowed) {
      for (const entry of parseRuleEntries(file.body)) {
        const at = { kind: 'rule', level: file.level, source: file.source, name: file.name, line: entry.line, date: entry.date, text: entry.text };
        entries.push({ at, level: file.level, words: wordsOf(entry.text), key: '', file: file.key });
      }
      if (file.always && file.on !== false) alwaysChars.set(file.level, (alwaysChars.get(file.level) || 0) + file.body.length);
    }
    if (file.truncated || file.body.length >= REVIEW_LIMITS.CLOSE_TO_LIMIT * RULE_LIMITS.BODY_CHARS) {
      hints.push({
        id: REVIEW_HINTS.CLOSE_TO_LIMIT, key: `${REVIEW_HINTS.CLOSE_TO_LIMIT}|${file.key}`, dismissible: false,
        at: { kind: 'ruleFile', level: file.level, source: file.source, name: file.name }, share: file.body.length / RULE_LIMITS.BODY_CHARS,
      });
    }
  }
  for (const [level, chars] of alwaysChars) {
    if (chars >= RULE_LIMITS.ALWAYS_CHARS_PER_LEVEL) {
      hints.push({
        id: REVIEW_HINTS.CLOSE_TO_LIMIT, key: `${REVIEW_HINTS.CLOSE_TO_LIMIT}|rules:${level}`, dismissible: false,
        at: { kind: 'rulesLevel', level }, share: chars / RULE_LIMITS.ALWAYS_CHARS_PER_LEVEL, budgetUsedUp: true,
      });
    }
  }

  for (const entry of entries) entry.key = `${entry.file}#${fingerprint(entry.words.join(' '))}`;

  // What a single entry reads like, and how old it is.
  for (const entry of entries) {
    const kind = entry.at.kind === 'memory' ? 'fact' : 'rule';
    for (const id of knowledgeHints({ kind, text: entry.at.text })) {
      hints.push({ id, key: `${id}|${entry.key}`, dismissible: true, at: entry.at });
    }
    const age = ageInDays(entry.at.date, now);
    if (age !== null && age > REVIEW_LIMITS.NOTED_DAYS) {
      hints.push({ id: REVIEW_HINTS.NOTED_A_WHILE_AGO, key: `${REVIEW_HINTS.NOTED_A_WHILE_AGO}|${entry.key}`, dismissible: true, at: entry.at, date: entry.at.date });
    }
  }

  // Nearly the same: within a level both entries are marked, under one key, so
  // that dismissing it on one dismisses it on both. Across levels only the
  // folder's entry is — the global one already covers it.
  const compared = entries.slice(0, REVIEW_LIMITS.COMPARED_ENTRIES);
  for (let i = 0; i < compared.length; i += 1) {
    for (let j = i + 1; j < compared.length; j += 1) {
      const a = compared[i];
      const b = compared[j];
      if (wordOverlap(a.words, b.words) < REVIEW_LIMITS.NEARLY_THE_SAME) continue;
      const key = `${REVIEW_HINTS.NEARLY_THE_SAME}|${[a.key, b.key].sort().join('|')}`;
      if (a.level === b.level) {
        hints.push({ id: REVIEW_HINTS.NEARLY_THE_SAME, key, dismissible: true, at: a.at, with: b.at });
        hints.push({ id: REVIEW_HINTS.NEARLY_THE_SAME, key, dismissible: true, at: b.at, with: a.at });
        continue;
      }
      const [local, global] = a.level === MEMORY_SCOPES.WORKSPACE ? [a, b] : [b, a];
      hints.push({ id: REVIEW_HINTS.NEARLY_THE_SAME, key, dismissible: true, at: local.at, with: global.at, alsoGlobal: true });
    }
  }

  // Similar topic names, within a level — both files, under one key.
  const files = rules.filter((file) => !file.shadowed);
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      const a = files[i];
      const b = files[j];
      if (a.level !== b.level || !similarTopicNames(a.name, b.name)) continue;
      const key = `${REVIEW_HINTS.SIMILAR_TOPIC_NAMES}|${[a.key, b.key].sort().join('|')}`;
      const fileA = /** @type {ReviewTarget} */ ({ kind: 'ruleFile', level: a.level, source: a.source, name: a.name });
      const fileB = /** @type {ReviewTarget} */ ({ kind: 'ruleFile', level: b.level, source: b.source, name: b.name });
      hints.push({ id: REVIEW_HINTS.SIMILAR_TOPIC_NAMES, key, dismissible: true, at: fileA, with: fileB });
      hints.push({ id: REVIEW_HINTS.SIMILAR_TOPIC_NAMES, key, dismissible: true, at: fileB, with: fileA });
    }
  }

  const gone = new Set(dismissed);
  return /** @type {ReviewHint[]} */ (hints.filter((hint) => !hint.dismissible || !gone.has(hint.key)));
}

module.exports = {
  REVIEW_HINTS,
  REVIEW_LIMITS,
  reviewKnowledge,
  wordOverlap,
  wordsOf,
  similarTopicNames,
};
