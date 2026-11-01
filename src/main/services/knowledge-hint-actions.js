'use strict';

/**
 * The actions behind the hints of *Settings › Knowledge* (#1279): *Remove*,
 * *Edit*, *Move to rules…*, *Create a skill…* and *Merge…*.
 *
 * Every action takes a hint as the review gave it in main — never a path, a
 * line or a text from the renderer — and changes nothing but what that hint
 * points at. Rules and skills are written through the knowledge writer, like
 * `remember` writes them; what it does not cover (removing one entry, merging
 * two files) is written contained here. Every change lands in the journal,
 * with *Undo*, as `settings`.
 *
 * *Distil…* (#1316) is not here yet: it starts the distillation of a chat,
 * which does not exist so far. Its place is next to `remove` for an episode.
 */

const { createEmbeddedTextFiles } = require('./embedded-text-file');
const { KNOWLEDGE_KINDS, countEntries } = require('../../shared/contracts/knowledge-write');
const { parseMemoryEntries, MEMORY_SCOPES } = require('../../shared/contracts/memory');
const { RULE_LEVELS, RULE_SOURCES, RULE_LIMITS, isRuleLevel, isValidRuleName, parseRuleFile, parseRuleEntries } = require('../../shared/contracts/rules');
const { isValidSkillName } = require('../../shared/contracts/skills');
const { REVIEW_HINTS } = require('../../application/chat/knowledge-review');

const JOURNAL_SOURCE = 'settings';

/**
 * Which action each hint offers — the issue's table.
 *
 * @type {Readonly<Record<string, string[]>>}
 */
const HINT_ACTIONS = Object.freeze({
  [REVIEW_HINTS.FACT_LOOKS_LIKE_RULE]: ['moveToRules'],
  [REVIEW_HINTS.FACT_LOOKS_LIKE_PROCEDURE]: ['createSkill'],
  [REVIEW_HINTS.LOOKS_LIKE_EPISODE]: ['remove'],
  [REVIEW_HINTS.NEARLY_THE_SAME]: ['remove', 'edit'],
  [REVIEW_HINTS.SIMILAR_TOPIC_NAMES]: ['merge'],
  [REVIEW_HINTS.NOTED_A_WHILE_AGO]: ['remove', 'edit'],
  [REVIEW_HINTS.CLOSE_TO_LIMIT]: [],
});

/** Sources Snotra writes to; `~/.agents/rules` belongs to the other tools. */
const WRITABLE_RULE_SOURCES = new Set([RULE_SOURCES.WORKSPACE, RULE_SOURCES.USER_SNOTRA]);

/** A refusal the page says in words: a catalogue key and its values. */
class HintActionError extends Error {
  /** @param {string} key @param {Record<string, unknown>} [params] */
  constructor(key, params = {}) {
    super(key);
    this.key = key;
    this.params = params;
  }
}

/**
 * The actions a hint offers, as the page shows them. A hint on a file Snotra
 * does not write to offers what does not write.
 *
 * @param {any} hint
 * @returns {string[]}
 */
function actionsOf(hint) {
  const actions = HINT_ACTIONS[hint.id] || [];
  const writable = (/** @type {any} */ at) => at.kind !== 'rule' && at.kind !== 'ruleFile' ? true : WRITABLE_RULE_SOURCES.has(at.source);
  return actions.filter((/** @type {string} */ action) => {
    if (action === 'edit') return true;
    if (action === 'merge') return writable(hint.at) && writable(hint.with);
    return writable(hint.at);
  });
}

/**
 * Removes the n-th list item with this text, where n is the place of the
 * entry among the items of the same text — exact copies stay apart.
 *
 * @param {string} fileText
 * @param {string} body  the body the review read the entry from
 * @param {number} bodyLine
 * @param {string} text
 * @returns {string|null}  the new text, or null when the entry is not there any more
 */
function removeNthEntry(fileText, body, bodyLine, text) {
  const same = (/** @type {{ text: string }} */ entry) => entry.text === text;
  const nth = parseRuleEntries(body).filter(same).findIndex((entry) => entry.line === bodyLine);
  const target = parseMemoryEntries(fileText).filter(same)[nth];
  if (nth === -1 || !target) return null;
  return fileText.split(/\r?\n/).filter((_, index) => index !== target.line).join('\n');
}

/**
 * The other file's body below the kept one, without the entries the kept file
 * already has. Nothing else is dropped: headings and prose move along.
 *
 * @param {string} keptText
 * @param {string} otherText
 */
function mergedText(keptText, otherText) {
  const other = parseRuleFile(otherText);
  if (!other) return keptText;
  const entries = new Map(parseRuleEntries(other.body).map((entry) => [entry.line, entry.text]));
  const lines = other.body.split(/\r?\n/).filter((_, index) => {
    const text = entries.get(index);
    return text === undefined || countEntries(keptText, text) === 0;
  });
  const added = lines.join('\n').trim();
  return added ? `${keptText.replace(/\s+$/, '')}\n\n${added}\n` : keptText;
}

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {string} deps.homeDir
 * @param {any} deps.rules  rules port, for the folder of a source
 * @param {any} deps.memory  memory port: forget, paths
 * @param {any} deps.knowledgeWriter
 * @param {any} [deps.journal]
 */
function createKnowledgeHintActions({ fs, path, homeDir, rules, memory, knowledgeWriter, journal = null }) {
  const textFiles = createEmbeddedTextFiles({ fs, path });

  /** @param {string|null} workspaceRoot @param {string} source @param {string} name */
  function ruleFileOf(workspaceRoot, source, name) {
    const dir = rules.dirOf?.({ workspaceRoot, source });
    if (!dir || !isValidRuleName(name)) return null;
    return { file: path.join(dir, `${name}.md`), root: source === RULE_SOURCES.WORKSPACE ? workspaceRoot : null };
  }

  /** @param {string|null} workspaceRoot @param {string} scope */
  function memoryFileOf(workspaceRoot, scope) {
    const file = memory.paths?.({ workspaceRoot })?.[scope] || null;
    return file ? { file, root: scope === MEMORY_SCOPES.WORKSPACE ? workspaceRoot : null } : null;
  }

  /**
   * Runs a change and records what it did to these files in the journal.
   *
   * @template T
   * @param {string[]} files
   * @param {string|null} workspaceRoot
   * @param {() => Promise<T>} change
   */
  async function journaled(files, workspaceRoot, change) {
    const captured = journal ? await journal.capture(files) : null;
    const result = await change();
    if (captured) {
      try {
        await journal.commit(captured, { source: JOURNAL_SOURCE, workspaceRoot });
      } catch {
        // The journal is a convenience; the change stands either way.
      }
    }
    return result;
  }

  /** @param {any} hint @param {string} action */
  function expect(hint, action) {
    if (!hint || !actionsOf(hint).includes(action)) throw new HintActionError('settings.knowledge.error.invalid');
  }

  return {
    actionsOf,

    /** The file an entry's hint is in, for *Edit*. @param {any} hint @param {string|null} workspaceRoot */
    fileOf(hint, workspaceRoot) {
      expect(hint, 'edit');
      const target = hint.at.kind === 'memory' ? memoryFileOf(workspaceRoot, hint.at.scope) : ruleFileOf(workspaceRoot, hint.at.source, hint.at.name);
      if (!target) throw new HintActionError('settings.knowledge.error.open');
      return target.file;
    },

    /** *Remove*: the one entry the hint sits on. @param {any} hint @param {unknown} _choice @param {string|null} workspaceRoot */
    async remove(hint, _choice, workspaceRoot) {
      expect(hint, 'remove');
      const { at } = hint;
      if (at.kind === 'memory') {
        const target = memoryFileOf(workspaceRoot, at.scope);
        if (!target) throw new HintActionError('settings.knowledge.error.noFolder');
        const result = await journaled([target.file], workspaceRoot,
          () => memory.forget({ scope: at.scope, workspaceRoot, line: at.line, text: at.text }));
        if (!result?.removed) throw new HintActionError('settings.knowledge.hint.error.changed');
        return;
      }
      const target = ruleFileOf(workspaceRoot, at.source, at.name);
      if (!target) throw new HintActionError('settings.knowledge.error.noFolder');
      await journaled([target.file], workspaceRoot, async () => {
        const current = await textFiles.readForUpdate(target);
        const parsed = current === null ? null : parseRuleFile(current);
        const next = parsed ? removeNthEntry(current || '', parsed.body, at.line, at.text) : null;
        if (next === null) throw new HintActionError('settings.knowledge.hint.error.changed');
        await textFiles.write({ ...target, text: next });
      });
    },

    /**
     * *Move to rules…*: the fact becomes a rule of the chosen level and topic;
     * at the fact's own level the writer removes it with `replaces`, at the
     * other one it is forgotten after the rule is written — a duplicate at
     * worst, never a loss.
     *
     * @param {any} hint
     * @param {{ level?: unknown, topic?: unknown, description?: unknown, always?: unknown }} choice
     * @param {string|null} workspaceRoot
     */
    async moveToRules(hint, choice, workspaceRoot) {
      expect(hint, 'moveToRules');
      const { at } = hint;
      const level = choice.level;
      const topic = typeof choice.topic === 'string' ? choice.topic.trim() : '';
      const description = typeof choice.description === 'string' ? choice.description.trim().slice(0, RULE_LIMITS.DESCRIPTION_CHARS) : '';
      if (!isRuleLevel(level)) throw new HintActionError('settings.knowledge.error.invalid');
      if (!isValidRuleName(topic)) throw new HintActionError('settings.knowledge.error.name');
      if (level === RULE_LEVELS.WORKSPACE && !workspaceRoot) throw new HintActionError('settings.knowledge.error.noFolder');
      const sameLevel = level === at.scope;
      const target = ruleFileOf(workspaceRoot, level === RULE_LEVELS.WORKSPACE ? RULE_SOURCES.WORKSPACE : RULE_SOURCES.USER_SNOTRA, topic);
      let exists = false;
      try {
        exists = target ? (await textFiles.readForUpdate(target)) !== null : false;
      } catch {
        // A file that leads out of the folder is not one to add to; the writer refuses it below.
      }
      if (!exists && !description) throw new HintActionError('settings.knowledge.error.description');
      try {
        await knowledgeWriter.write({
          kind: KNOWLEDGE_KINDS.RULE, scope: level, topic, text: at.text, workspaceRoot,
          ...(description ? { description } : {}),
          ...(!exists && choice.always === true ? { always: true } : {}),
          origin: 'requested', source: JOURNAL_SOURCE,
          ...(sameLevel ? { replaces: at.text, replacesIn: 'memory' } : {}),
        });
      } catch (error) {
        throw new HintActionError('settings.knowledge.hint.error.write', { reason: error?.message || '' });
      }
      if (!sameLevel) {
        const memoryTarget = memoryFileOf(workspaceRoot, at.scope);
        if (memoryTarget) {
          await journaled([memoryTarget.file], workspaceRoot,
            () => memory.forget({ scope: at.scope, workspaceRoot, line: at.line, text: at.text }));
        }
      }
      return { topic };
    },

    /**
     * *Create a skill…*: the procedure becomes a skill of the fact's level and
     * leaves memory. An existing skill of that name is never written over.
     *
     * @param {any} hint
     * @param {{ name?: unknown, description?: unknown }} choice
     * @param {string|null} workspaceRoot
     */
    async createSkill(hint, choice, workspaceRoot) {
      expect(hint, 'createSkill');
      const { at } = hint;
      const name = typeof choice.name === 'string' ? choice.name.trim() : '';
      const description = typeof choice.description === 'string' ? choice.description.replace(/\s+/g, ' ').trim() : '';
      if (!isValidSkillName(name)) throw new HintActionError('settings.knowledge.hint.error.skillName');
      if (!description) throw new HintActionError('settings.knowledge.error.description');
      const file = at.scope === MEMORY_SCOPES.WORKSPACE
        ? (workspaceRoot ? path.join(workspaceRoot, '.agents', 'skills', name, 'SKILL.md') : null)
        : path.join(homeDir, '.snotra', 'skills', name, 'SKILL.md');
      if (!file) throw new HintActionError('settings.knowledge.error.noFolder');
      const taken = await fs.stat(path.dirname(file)).then(() => true, () => false);
      if (taken) throw new HintActionError('settings.knowledge.hint.error.skillExists', { name });
      try {
        await knowledgeWriter.write({
          kind: KNOWLEDGE_KINDS.INSTRUCTION, scope: at.scope, topic: name, description, body: at.text, text: '', workspaceRoot,
          origin: 'requested', source: JOURNAL_SOURCE, replaces: at.text, replacesIn: 'memory',
        });
      } catch (error) {
        throw new HintActionError('settings.knowledge.hint.error.write', { reason: error?.message || '' });
      }
      return { name };
    },

    /**
     * *Merge…*: the other file's rules move below the kept file's, without
     * the ones it already has, and the other file goes.
     *
     * @param {any} hint
     * @param {{ keep?: unknown }} choice
     * @param {string|null} workspaceRoot
     */
    async merge(hint, choice, workspaceRoot) {
      expect(hint, 'merge');
      const pair = [hint.at, hint.with];
      const kept = pair.find((file) => file.name === choice.keep);
      const other = pair.find((file) => file !== kept);
      if (!kept || !other) throw new HintActionError('settings.knowledge.error.invalid');
      const keptFile = ruleFileOf(workspaceRoot, kept.source, kept.name);
      const otherFile = ruleFileOf(workspaceRoot, other.source, other.name);
      if (!keptFile || !otherFile) throw new HintActionError('settings.knowledge.error.noFolder');
      await journaled([keptFile.file, otherFile.file], workspaceRoot, async () => {
        const keptText = await textFiles.readForUpdate(keptFile);
        const otherText = await textFiles.readForUpdate(otherFile);
        if (keptText === null || otherText === null) throw new HintActionError('settings.knowledge.hint.error.changed');
        const next = mergedText(keptText, otherText);
        if ((parseRuleFile(next)?.body.length || 0) > RULE_LIMITS.BODY_CHARS) {
          throw new HintActionError('settings.knowledge.hint.error.tooLong', { name: kept.name });
        }
        // Written first, removed second: a failure leaves both files, never a loss.
        await textFiles.write({ ...keptFile, text: next });
        await fs.rm(otherFile.file);
      });
      return { kept: kept.name, removed: other.name };
    },
  };
}

module.exports = { createKnowledgeHintActions, HintActionError, actionsOf, mergedText, removeNthEntry };
