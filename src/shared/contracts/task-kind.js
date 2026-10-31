/**
 * The kind of task a chat is about (#1281, concept `docs/concepts/task-kinds-concept.md`).
 *
 * Every chat gets one of seven fixed kinds, so that the usage report can say
 * what the money was spent on. What is stored is the id, never a label:
 *
 *   taskKind: { id: 'coding', source: 'model', at: '2026-10-25T14:20:10.000Z' }
 *
 * A chat without the field is unclassified. *Unclassified* is the report's
 * word for that, not a kind, and never offered as a choice.
 *
 * Where a kind came from decides what may replace it: `user` > `model` >
 * `estimate`. A user's choice is never overwritten.
 */
'use strict';

/** @typedef {'coding' | 'writing' | 'research' | 'data' | 'planning' | 'organisation' | 'other'} TaskKindId */
/** @typedef {'model' | 'estimate' | 'user'} TaskKindSource */

/**
 * A chat's kind as it is stored. `id` and `source` may be ones this version
 * does not know — written by a newer one; such a kind counts as unclassified
 * and is kept as it is.
 *
 * @typedef {Object} TaskKind
 * @property {string} id
 * @property {string} source
 * @property {string} at  when it was set, as an ISO time
 */

/** @type {readonly TaskKindId[]} */
const TASK_KIND_IDS = Object.freeze(['coding', 'writing', 'research', 'data', 'planning', 'organisation', 'other']);

/** @type {readonly TaskKindSource[]} */
const TASK_KIND_SOURCES = Object.freeze(['model', 'estimate', 'user']);

/**
 * The definitions the classifier works from — the model channel, so English
 * (#276). The user reads the same definitions from the i18n catalogues
 * (`taskKind.<id>.definition`).
 *
 * @type {Readonly<Record<TaskKindId, string>>}
 */
const TASK_KIND_DEFINITIONS = Object.freeze({
  coding: 'Writing, changing, reviewing or debugging code, scripts and configuration.',
  writing: 'Drafting, revising, shortening or translating prose: mails, documents, posts.',
  research: 'Looking something up, having something explained, searching the web or a folder for an answer.',
  data: 'Evaluating data, tables or logs, calculating, building charts.',
  planning: 'Working out a concept, an architecture, a plan or a decision between options — what to build and how, not managing tasks or time.',
  organisation:
    'Managing tasks, time and files: booking hours, keeping to-dos, tickets and calendars up to date, sorting mail, restructuring folders or a workspace.',
  other: 'Anything that fits none of the above.',
});

/** How much each source counts: a source may replace one that counts the same or less. */
const SOURCE_RANK = Object.freeze({ estimate: 1, model: 2, user: 3 });

/** What an id or a source from disk may look like, known or not. */
const STORED_WORD = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * @param {unknown} id
 * @returns {id is TaskKindId}
 */
function isTaskKindId(id) {
  return typeof id === 'string' && /** @type {readonly string[]} */ (TASK_KIND_IDS).includes(id);
}

/**
 * @param {unknown} source
 * @returns {source is TaskKindSource}
 */
function isTaskKindSource(source) {
  return typeof source === 'string' && /** @type {readonly string[]} */ (TASK_KIND_SOURCES).includes(source);
}

/**
 * A kind as the history keeps it, or null when it is none. An id or a source
 * this version does not know is kept, as long as it looks like one.
 *
 * @param {unknown} raw
 * @returns {TaskKind|null}
 */
function normalizeTaskKind(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { id, source, at } = /** @type {Record<string, unknown>} */ (raw);
  if (typeof id !== 'string' || !STORED_WORD.test(id)) return null;
  if (typeof source !== 'string' || !STORED_WORD.test(source)) return null;
  const time = typeof at === 'string' ? Date.parse(at) : NaN;
  return { id, source, at: Number.isFinite(time) ? new Date(time).toISOString() : new Date(0).toISOString() };
}

/**
 * The kind a chat counts under, or null for an unclassified one — none, or
 * one this version does not know.
 *
 * @param {unknown} raw  a stored kind
 * @returns {TaskKindId|null}
 */
function classifiedTaskKindId(raw) {
  const kind = normalizeTaskKind(raw);
  return kind && isTaskKindId(kind.id) && isTaskKindSource(kind.source) ? kind.id : null;
}

/**
 * Whether a kind from `source` may take the place of the one a chat has.
 * A kind this version does not understand is left alone: a newer version
 * wrote it, and this one cannot tell what it outranks.
 *
 * @param {unknown} existing  the chat's stored kind
 * @param {TaskKindSource} source
 */
function mayReplaceTaskKind(existing, source) {
  const kind = normalizeTaskKind(existing);
  if (!kind) return true;
  if (!isTaskKindId(kind.id) || !isTaskKindSource(kind.source)) return false;
  return SOURCE_RANK[source] >= SOURCE_RANK[kind.source];
}

/**
 * Whether the chat's model should still be asked for a kind: there is none,
 * or only Snotra's estimate, which a model answer replaces.
 *
 * @param {unknown} existing
 */
function wantsModelTaskKind(existing) {
  const kind = normalizeTaskKind(existing);
  return !kind || (isTaskKindId(kind.id) && kind.source === 'estimate');
}

/**
 * The id a model named, from the lines of its answer — `coding`, `Kind: data`,
 * `` `research` `` —, or null when none of them is one of the six.
 *
 * @param {unknown} text
 * @returns {TaskKindId|null}
 */
function parseTaskKindAnswer(text) {
  if (typeof text !== 'string') return null;
  for (const line of text.split('\n')) {
    const word = line
      .trim()
      .replace(/^(?:task\s*kind|kind|category)\s*:\s*/i, '')
      .replace(/[^a-z]/gi, '')
      .toLowerCase();
    if (isTaskKindId(word)) return word;
  }
  return null;
}

/**
 * The six kinds as the classifier's prompt lists them.
 */
function taskKindPromptList() {
  return TASK_KIND_IDS.map((id) => `- ${id}: ${TASK_KIND_DEFINITIONS[id]}`).join('\n');
}

module.exports = {
  TASK_KIND_IDS,
  TASK_KIND_SOURCES,
  TASK_KIND_DEFINITIONS,
  isTaskKindId,
  isTaskKindSource,
  normalizeTaskKind,
  classifiedTaskKindId,
  mayReplaceTaskKind,
  wantsModelTaskKind,
  parseTaskKindAnswer,
  taskKindPromptList,
};
