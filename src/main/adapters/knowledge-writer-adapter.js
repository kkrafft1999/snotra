'use strict';

/**
 * Knowledge-writer port (#1276): the one place `remember` writes through.
 *
 * - A **fact** goes into the level's `memory.md` (through the memory port, so
 *   its limits and the switch for unprompted remembering hold), or — for the
 *   reader `team` — into Snotra's section at the end of the folder's `AGENTS.md`.
 * - A **rule** goes into a rules file, `<folder>/.agents/rules/<topic>.md` or
 *   `~/.snotra/rules/<topic>.md`, created with its front matter when new — or,
 *   for `team`, into the same section of `AGENTS.md`. Never `~/.agents/`, and
 *   never the global `AGENTS.md`.
 * - A **procedure** is a skill, written as a whole version (#1314):
 *   `<folder>/.agents/skills/<topic>/SKILL.md` or `~/.snotra/skills/<topic>/SKILL.md`,
 *   text only, replacing the version before it — never appended to, never a
 *   system skill, never `~/.agents/skills`, and never for `team`.
 * - `replaces` writes first and removes second: when the removal fails, both
 *   entries remain and the result says so — a duplicate, never a loss.
 *
 * The folder's files are written contained, like `AGENTS.md` and memory (#534).
 */

const {
  KNOWLEDGE_KINDS,
  KNOWLEDGE_READERS,
  isKnowledgeKind,
  isKnowledgeReader,
  appendToSnotraSection,
  newRuleFileText,
  appendRuleEntry,
  removeEntriesByText,
  countEntries,
  formatKnowledgeLine,
  SYSTEM_SKILL_PREFIX,
  skillDocumentText,
} = require('../../shared/contracts/knowledge-write');
const { MAX_SKILL_BODY_CHARS, isValidSkillName } = require('../../shared/contracts/skills');
const { parseSkillDocument } = require('../../shared/runtime/skill-frontmatter');
const { splitLines, diffLines } = require('../services/line-diff');
const { RULES_DIR, RULE_LIMITS, isValidRuleName, parseRuleFile, ruleNameOfFile } = require('../../shared/contracts/rules');
const { MEMORY_FILE, MEMORY_ORIGINS, MAX_MEMORY_ENTRY_CHARS, formatMemoryDate } = require('../../shared/contracts/memory');
const { PROJECT_INSTRUCTIONS_FILE } = require('../../shared/contracts/project-instructions');
const { createEmbeddedTextFiles } = require('../services/embedded-text-file');

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @param {import('../../application/ports/memory-port').MemoryPort} deps.memory
 * @param {() => Promise<boolean>} [deps.isSelfMemoryAllowed]
 * @param {() => string|undefined} [deps.getLocale]
 * @returns {import('../../application/ports/knowledge-writer-port').KnowledgeWriterPort}
 */
function createKnowledgeWriterAdapter({ fs, path, os, memory, isSelfMemoryAllowed, getLocale = () => undefined }) {
  const textFiles = createEmbeddedTextFiles({ fs, path });
  /** @type {Map<string, Promise<unknown>>} */
  const queues = new Map();

  function home() {
    try {
      const dir = os.homedir();
      return typeof dir === 'string' && dir ? path.resolve(dir) : null;
    } catch {
      // No home folder: only the open folder can be written.
      return null;
    }
  }

  /** @param {unknown} root */
  const folderOf = (root) => (typeof root === 'string' && root.trim() ? path.resolve(root) : null);

  /**
   * Where an entry of this kind for this reader goes; null when there is no
   * such place (no open folder, a procedure, a rule without a topic).
   *
   * @param {string} kind
   * @param {string} scope
   * @param {unknown} workspaceRoot
   * @param {string} [topic]
   * @returns {{ file: string, root: string|null, path: string, kind: 'memory'|'rules'|'agents'|'skills' }|null}
   */
  function targetOf(kind, scope, workspaceRoot, topic) {
    const folder = folderOf(workspaceRoot);
    const userHome = home();
    if (kind === KNOWLEDGE_KINDS.INSTRUCTION) {
      if (scope === KNOWLEDGE_READERS.TEAM || !isValidSkillName(topic) || String(topic).startsWith(SYSTEM_SKILL_PREFIX)) return null;
      if (scope === KNOWLEDGE_READERS.WORKSPACE) {
        return folder
          ? { file: path.join(folder, '.agents', 'skills', /** @type {string} */ (topic), 'SKILL.md'), root: folder, path: `.agents/skills/${topic}/SKILL.md`, kind: 'skills' }
          : null;
      }
      return userHome
        ? { file: path.join(userHome, '.snotra', 'skills', /** @type {string} */ (topic), 'SKILL.md'), root: null, path: `~/.snotra/skills/${topic}/SKILL.md`, kind: 'skills' }
        : null;
    }
    if (scope === KNOWLEDGE_READERS.TEAM) {
      if (!folder || kind === KNOWLEDGE_KINDS.INSTRUCTION) return null;
      return { file: path.join(folder, PROJECT_INSTRUCTIONS_FILE), root: folder, path: PROJECT_INSTRUCTIONS_FILE, kind: 'agents' };
    }
    const base = scope === KNOWLEDGE_READERS.WORKSPACE ? folder : userHome && path.join(userHome, '.snotra');
    if (!base) return null;
    const root = scope === KNOWLEDGE_READERS.WORKSPACE ? folder : null;
    const shown = scope === KNOWLEDGE_READERS.WORKSPACE ? '.agents' : '~/.snotra';
    const dir = scope === KNOWLEDGE_READERS.WORKSPACE ? path.join(base, '.agents') : base;
    if (kind === KNOWLEDGE_KINDS.FACT) return { file: path.join(dir, MEMORY_FILE), root, path: `${shown}/${MEMORY_FILE}`, kind: 'memory' };
    if (kind === KNOWLEDGE_KINDS.RULE && isValidRuleName(topic)) {
      return { file: path.join(dir, RULES_DIR, `${topic}.md`), root, path: `${shown}/${RULES_DIR}/${topic}.md`, kind: 'rules' };
    }
    return null;
  }

  /** @param {{ file: string, root: string|null }} target */
  async function read(target) {
    return textFiles.readForUpdate(target);
  }

  /**
   * One write after the other on the same file.
   * @template T
   * @param {string} file
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serialize(file, task) {
    const previous = queues.get(file) || Promise.resolve();
    const next = previous.catch(() => {
      // A failed task must not poison the chain for the next one.
    }).then(task);
    queues.set(file, next.catch(() => {
      // The caller gets the failure from `next`; the chain only waits.
    }));
    return next;
  }

  /**
   * The files of a level an entry `replaces` may be in: its memory, its rules
   * files and, in the open folder, Snotra's section of `AGENTS.md`.
   *
   * @param {string} scope
   * @param {unknown} workspaceRoot
   */
  async function filesOfLevel(scope, workspaceRoot) {
    const level = scope === KNOWLEDGE_READERS.USER ? KNOWLEDGE_READERS.USER : KNOWLEDGE_READERS.WORKSPACE;
    /** @type {Array<{ where: string, target: { file: string, root: string|null, path: string, kind: string } }>} */
    const out = [];
    const memoryTarget = targetOf(KNOWLEDGE_KINDS.FACT, level, workspaceRoot);
    if (memoryTarget) out.push({ where: 'memory', target: memoryTarget });
    const anyRule = targetOf(KNOWLEDGE_KINDS.RULE, level, workspaceRoot, 'x');
    if (anyRule) {
      /** @type {Array<string|null>} */
      let names = [];
      try {
        names = (await fs.readdir(path.dirname(anyRule.file))).map(ruleNameOfFile).filter((name) => name !== null);
      } catch {
        // No rules folder: no rules files to look in.
      }
      for (const name of names) {
        const target = targetOf(KNOWLEDGE_KINDS.RULE, level, workspaceRoot, /** @type {string} */ (name));
        if (target) out.push({ where: /** @type {string} */ (name), target });
      }
    }
    if (level === KNOWLEDGE_READERS.WORKSPACE) {
      const agents = targetOf(KNOWLEDGE_KINDS.FACT, KNOWLEDGE_READERS.TEAM, workspaceRoot);
      if (agents) out.push({ where: 'agents', target: agents });
    }
    return out;
  }

  /**
   * Where `replaces` points: one file, or why it cannot be removed.
   *
   * @param {import('../../application/ports/knowledge-writer-port').KnowledgeWriteRequest} request
   */
  async function findReplaced(request) {
    const wanted = typeof request.replaces === 'string' ? request.replaces.replace(/\s+/g, ' ').trim() : '';
    if (!wanted) return null;
    const files = (await filesOfLevel(request.scope, request.workspaceRoot))
      .filter((entry) => !request.replacesIn || entry.where === request.replacesIn);
    const hits = [];
    for (const entry of files) {
      const count = countEntries(await read(entry.target), wanted);
      if (count > 0) hits.push({ ...entry, count });
    }
    if (hits.length === 0) return { error: `The entry to replace was not found at this level: "${wanted}". Nothing was written.` };
    if (hits.length > 1) {
      return { error: `The entry to replace is in more than one file (${hits.map((hit) => hit.where).join(', ')}). `
        + 'Name the file with replaces_in. Nothing was written.' };
    }
    return { text: wanted, where: hits[0].where, count: hits[0].count, target: hits[0].target };
  }

  /** @param {import('../../application/ports/knowledge-writer-port').KnowledgeWriteRequest} request */
  function refusalOf(request) {
    if (!isKnowledgeKind(request.kind)) return `Unknown kind: ${request.kind}.`;
    if (!isKnowledgeReader(request.scope)) return `Unknown scope: ${request.scope}.`;
    if (request.kind === KNOWLEDGE_KINDS.INSTRUCTION) {
      if (request.scope === KNOWLEDGE_READERS.TEAM) return 'A procedure has no "team" reader: AGENTS.md takes facts and rules only.';
      if (request.scope === KNOWLEDGE_READERS.WORKSPACE && !folderOf(request.workspaceRoot)) {
        return 'Without an open folder there is no "workspace" reader; only "user" is possible.';
      }
      if (!isValidSkillName(request.topic)) return 'A procedure needs a topic: the skill\'s name, letters, digits, dots, dashes and underscores, at most 64 characters.';
      if (String(request.topic).startsWith(SYSTEM_SKILL_PREFIX)) return `Names beginning with "${SYSTEM_SKILL_PREFIX}" belong to the skills built into Snotra.`;
      const steps = typeof request.body === 'string' ? request.body.trim() : '';
      if (!steps) return 'A procedure needs its steps in "body": the whole skill, as it should read.';
      if (steps.length > MAX_SKILL_BODY_CHARS) return `A skill may be at most ${MAX_SKILL_BODY_CHARS} characters (here: ${steps.length}). Nothing was written.`;
      return '';
    }
    const body = typeof request.text === 'string' ? request.text.replace(/\s+/g, ' ').trim() : '';
    if (!body) return 'An empty entry cannot be remembered.';
    if (body.length > MAX_MEMORY_ENTRY_CHARS) return `An entry may be at most ${MAX_MEMORY_ENTRY_CHARS} characters (here: ${body.length}).`;
    if (request.scope !== KNOWLEDGE_READERS.USER && !folderOf(request.workspaceRoot)) {
      return `Without an open folder there is no "${request.scope}" reader; only "user" is possible.`;
    }
    if (request.kind === KNOWLEDGE_KINDS.RULE && request.scope !== KNOWLEDGE_READERS.TEAM && !isValidRuleName(request.topic)) {
      return `A rule needs a topic: lower case letters, digits and dashes, at most ${RULE_LIMITS.NAME_CHARS} characters.`;
    }
    return '';
  }

  /** @param {unknown} root */
  async function folderInstructions(root) {
    const folder = folderOf(root);
    if (!folder) return { agentsMd: false, rulesFiles: 0 };
    let agentsMd = false;
    try {
      agentsMd = (await read({ file: path.join(folder, PROJECT_INSTRUCTIONS_FILE), root: folder })) !== null;
    } catch {
      // Unreadable or leading out of the folder: it brings nothing the prompt reads.
      agentsMd = false;
    }
    let rulesFiles = 0;
    try {
      rulesFiles = (await fs.readdir(path.join(folder, '.agents', RULES_DIR))).filter((name) => ruleNameOfFile(name)).length;
    } catch {
      // No rules folder.
      rulesFiles = 0;
    }
    return { agentsMd, rulesFiles };
  }

  /** @param {{ file: string, root: string|null, path: string, kind: string }|null} target */
  async function shown(target) {
    if (!target) return null;
    let exists = false;
    try {
      exists = (await read(target)) !== null;
    } catch {
      // A file that leads out of the folder is refused at writing; here it counts as there.
      exists = true;
    }
    return { path: target.path, exists, file: /** @type {'memory'|'rules'|'agents'} */ (target.kind) };
  }

  /**
   * What the card shows of a changed skill: the diff against the current
   * version, with a little context (#1314).
   *
   * @param {string} before
   * @param {string} after
   */
  function previewOf(before, after) {
    const a = splitLines(before).lines;
    const b = splitLines(after).lines;
    const out = [];
    let i = 0;
    let j = 0;
    for (const { op, count } of diffLines(a, b).segments) {
      if (op === 'equal') {
        if (count <= 4) for (let k = 0; k < count; k += 1) out.push(` ${a[i + k]}`);
        else {
          for (let k = 0; k < 2; k += 1) out.push(` ${a[i + k]}`);
          out.push('@@');
          for (let k = count - 2; k < count; k += 1) out.push(` ${a[i + k]}`);
        }
        i += count;
        j += count;
      } else if (op === 'delete') {
        for (let k = 0; k < count; k += 1) out.push(`-${a[i + k]}`);
        i += count;
      } else {
        for (let k = 0; k < count; k += 1) out.push(`+${b[j + k]}`);
        j += count;
      }
    }
    const text = out.join('\n');
    return { kind: 'diff', text: text.slice(0, 40_000), truncated: text.length > 40_000 };
  }

  return {
    async describe(request) {
      /** @type {Record<string, Record<string, any>>} */
      const alternatives = {};
      for (const kind of [KNOWLEDGE_KINDS.FACT, KNOWLEDGE_KINDS.RULE]) {
        alternatives[kind] = {};
        for (const scope of [KNOWLEDGE_READERS.USER, KNOWLEDGE_READERS.WORKSPACE, KNOWLEDGE_READERS.TEAM]) {
          alternatives[kind][scope] = await shown(targetOf(kind, scope, request.workspaceRoot, request.topic));
        }
      }
      const base = { alternatives, folderInstructions: await folderInstructions(request.workspaceRoot) };
      const refusal = refusalOf(request);
      const target = refusal ? null : targetOf(request.kind, request.scope, request.workspaceRoot, request.topic);
      if (refusal || !target) return { ...base, target: null, refusal: refusal || 'There is no place for this entry.' };
      /** @type {import('../../application/ports/knowledge-writer-port').KnowledgeDescription} */
      const out = { ...base, target: await shown(target) };
      if (target.kind === 'skills') {
        const current = await read(target);
        const parsed = current === null ? null : parseSkillDocument(current);
        const description = typeof request.description === 'string' ? request.description.trim() : '';
        if (!parsed && !description) {
          return { ...base, target: null, refusal: 'A new skill needs a description: what it is for, and when to use it.' };
        }
        const next = (request.body || "").trim();
        out.skill = parsed
          ? { description: parsed.frontmatter.description ? String(parsed.frontmatter.description) : '', ...previewOf(parsed.body, next) }
          : { description: '', kind: 'text', text: next, truncated: false };
        return out;
      }
      if (target.kind === 'rules') {
        const current = await read(target);
        if (current !== null) {
          const parsed = parseRuleFile(current);
          out.ruleFile = { description: parsed?.descriptionDerived ? '' : parsed?.description || '', always: parsed?.always === true };
        } else if (!(typeof request.description === 'string' && request.description.trim())) {
          return { ...base, target: null, refusal: 'A new rules file needs a description: the situation in which the rule applies.' };
        }
      }
      const replaced = await findReplaced(request);
      if (replaced && 'error' in replaced) return { ...base, target: null, refusal: replaced.error };
      if (replaced) out.replaced = { text: replaced.text, where: replaced.where, count: replaced.count };
      return out;
    },

    async write(request) {
      const refusal = refusalOf(request);
      if (refusal) throw new Error(refusal);
      const replaced = await findReplaced(request);
      if (replaced && 'error' in replaced) throw new Error(replaced.error);
      const body = typeof request.text === 'string' ? request.text.replace(/\s+/g, ' ').trim() : '';
      const locale = getLocale();
      const origin = request.origin === MEMORY_ORIGINS.REQUESTED ? MEMORY_ORIGINS.REQUESTED : MEMORY_ORIGINS.SELF;
      if (origin === MEMORY_ORIGINS.SELF && typeof isSelfMemoryAllowed === 'function' && (await isSelfMemoryAllowed()) === false) {
        throw new Error('Unprompted remembering is switched off. Only what the user explicitly asks for is remembered.');
      }
      /** @type {string} */
      let file;
      if (request.kind === KNOWLEDGE_KINDS.INSTRUCTION) {
        const target = targetOf(request.kind, request.scope, request.workspaceRoot, request.topic);
        if (!target) throw new Error('There is no place for this procedure.');
        await serialize(target.file, async () => {
          const current = await read(target);
          const parsed = current === null ? null : parseSkillDocument(current);
          const description = (typeof request.description === 'string' && request.description.trim())
            || (parsed?.frontmatter.description ? String(parsed.frontmatter.description) : '');
          if (!description) throw new Error('A new skill needs a description: what it is for, and when to use it.');
          // A whole version, never an appendix: the steps stand where the procedure needs them.
          const next = skillDocumentText({
            name: /** @type {string} */ (request.topic),
            description,
            date: formatMemoryDate(new Date()),
            origin,
            body: /** @type {string} */ (request.body),
          });
          await textFiles.write({ file: target.file, root: target.root, text: next });
        });
        return { kind: request.kind, scope: request.scope, file: target.file, text: request.topic || '' };
      }
      if (request.kind === KNOWLEDGE_KINDS.FACT && request.scope !== KNOWLEDGE_READERS.TEAM) {
        const saved = await memory.remember({ scope: request.scope, workspaceRoot: request.workspaceRoot ?? null, text: body, origin });
        file = saved.file;
      } else {
        const target = targetOf(request.kind, request.scope, request.workspaceRoot, request.topic);
        if (!target) throw new Error('There is no place for this entry.');
        file = target.file;
        const line = formatKnowledgeLine({ text: body, origin, date: formatMemoryDate(new Date()), locale });
        await serialize(target.file, async () => {
          const current = await read(target);
          let next;
          if (target.kind === 'agents') {
            next = appendToSnotraSection(current || '', line, locale);
          } else if (current === null) {
            const description = typeof request.description === 'string' ? request.description.trim() : '';
            if (!description) throw new Error('A new rules file needs a description: the situation in which the rule applies.');
            next = newRuleFileText({ description, always: request.always === true, line });
          } else {
            const description = typeof request.description === 'string' ? request.description.trim() : '';
            next = appendRuleEntry(current, { line, description });
          }
          if (target.kind === 'rules' && next.length > RULE_LIMITS.BODY_CHARS) {
            throw new RangeError(`The rules file "${request.topic}" would exceed ${RULE_LIMITS.BODY_CHARS} characters. Nothing was written.`);
          }
          await textFiles.write({ file: target.file, root: target.root, text: next });
        });
      }
      /** @type {{ kind: string, scope: string, file: string, text: string, replaced?: { removed: number, error?: string } }} */
      const result = { kind: request.kind, scope: request.scope, file, text: body };
      if (replaced) {
        // Written first, removed second: a failure here leaves a duplicate, never a loss.
        try {
          const removed = await serialize(replaced.target.file, async () => {
            const current = await read(replaced.target);
            const change = removeEntriesByText(current, replaced.text);
            if (change.removed > 0) await textFiles.write({ file: replaced.target.file, root: replaced.target.root, text: change.text });
            return change.removed;
          });
          result.replaced = { removed: removed };
        } catch (error) {
          result.replaced = { removed: 0, error: error?.message || 'The old entry could not be removed; both are there now.' };
        }
      }
      return result;
    },
  };
}

module.exports = { createKnowledgeWriterAdapter };
