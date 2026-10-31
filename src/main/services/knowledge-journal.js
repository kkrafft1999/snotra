'use strict';

/**
 * The journal of the agent's changes to knowledge files (#1278): the last 50,
 * each with the whole version before it, kept in the app's own storage —
 * `<userData>/knowledge-journal.json` — never in the folder. *Undo* puts the
 * version before back, but only while the file still holds what the change
 * left: a file changed since by anyone is not overwritten.
 */

const { randomUUID } = require('crypto');
const { workspaceKnowledgeKind, globalKnowledgeKind } = require('../../shared/contracts/knowledge-files');

const MAX_ENTRIES = 50;
/** Above this a version is not kept: far beyond every knowledge file's limit. */
const MAX_VERSION_CHARS = 64 * 1024;
const EXCERPT_CHARS = 160;

/** @param {string|null} text */
function excerpt(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS - 1)}…` : flat;
}

/**
 * The part of two versions that differs, for the list: the changed lines.
 *
 * @param {string|null} before
 * @param {string|null} after
 */
function changedLines(before, after) {
  const a = typeof before === 'string' ? before.split(/\r?\n/) : [];
  const b = typeof after === 'string' ? after.split(/\r?\n/) : [];
  const setA = new Set(a);
  const setB = new Set(b);
  return {
    removed: excerpt(a.filter((line) => line.trim() && !setB.has(line)).join(' · ')),
    added: excerpt(b.filter((line) => line.trim() && !setA.has(line)).join(' · ')),
  };
}

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {string} deps.file  where the journal is kept
 * @param {string|null} [deps.homeDir]
 * @param {() => Date} [deps.now]
 * @returns {import('../../application/ports/knowledge-journal-port').KnowledgeJournalPort}
 */
function createKnowledgeJournal({ fs, path, file, homeDir = null, now = () => new Date() }) {
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();
  const home = typeof homeDir === 'string' && homeDir ? path.resolve(homeDir) : null;

  /** @returns {Promise<Array<any>>} */
  async function load() {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
      return Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {
      // No journal yet, or one that cannot be read: an empty list, not an error.
      return [];
    }
  }

  /** @param {Array<any>} entries */
  async function save(entries) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ version: 1, entries }), 'utf8');
    await fs.rename(tmp, file);
  }

  /**
   * One change after the other.
   * @template T
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function serial(task) {
    const next = queue.then(task, task);
    queue = next.catch(() => {
      // The caller gets the failure; the queue only keeps the order.
    });
    return next;
  }

  /** @param {string} absPath */
  async function readOrNull(absPath) {
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isFile() || stat.size > MAX_VERSION_CHARS) return null;
      return await fs.readFile(absPath, 'utf8');
    } catch {
      // Not there: the change created it.
      return null;
    }
  }

  /**
   * How a file is shown and what it is, from its absolute path.
   *
   * @param {string} absPath
   * @param {string|null} workspaceRoot
   */
  function describe(absPath, workspaceRoot) {
    const target = path.resolve(absPath);
    if (workspaceRoot) {
      const rel = path.relative(path.resolve(workspaceRoot), target).split(path.sep).join('/');
      if (rel && !rel.startsWith('..')) return { path: rel, kind: workspaceKnowledgeKind(rel) };
    }
    if (home) {
      const rel = path.relative(home, target).split(path.sep).join('/');
      if (rel && !rel.startsWith('..')) return { path: `~/${rel}`, kind: globalKnowledgeKind(rel) };
    }
    return { path: target, kind: null };
  }

  /** @param {{ file: string, path: string, kind: string, source: string, before: string|null, after: string|null }} change */
  function record(change) {
    if (change.before === change.after) return Promise.resolve();
    return serial(async () => {
      const entries = await load();
      entries.unshift({
        id: randomUUID(),
        at: now().toISOString(),
        source: change.source,
        kind: change.kind,
        path: change.path,
        file: change.file,
        previous: typeof change.before === 'string' && change.before.length <= MAX_VERSION_CHARS ? change.before : null,
        existed: typeof change.before === 'string',
        left: typeof change.after === 'string' && change.after.length <= MAX_VERSION_CHARS ? change.after : null,
        ...changedLines(change.before, change.after),
      });
      await save(entries.slice(0, MAX_ENTRIES));
    });
  }

  return {
    record,

    async capture(files) {
      /** @type {Map<string, string|null>} */
      const captured = new Map();
      for (const absPath of files) captured.set(absPath, await readOrNull(absPath));
      return captured;
    },

    async commit(captured, { source, workspaceRoot }) {
      for (const [absPath, before] of captured) {
        const after = await readOrNull(absPath);
        const shown = describe(absPath, workspaceRoot);
        if (!shown.kind) continue;
        await record({ file: absPath, path: shown.path, kind: shown.kind, source, before, after });
      }
    },

    async list() {
      return (await load()).map((entry) => ({
        id: entry.id,
        at: entry.at,
        source: entry.source,
        kind: entry.kind,
        path: entry.path,
        before: entry.removed || '',
        after: entry.added || '',
        undoable: entry.previous !== null || entry.existed === false,
      }));
    },

    undo(id) {
      return serial(async () => {
        const entries = await load();
        const entry = entries.find((item) => item.id === id);
        if (!entry) return { ok: false, reason: 'gone' };
        const current = await readOrNull(entry.file);
        // Only what this change left is put back; a later change stays.
        if (current !== entry.left) return { ok: false, reason: 'changedSince' };
        if (entry.existed === false) {
          await fs.rm(entry.file, { force: true });
        } else if (typeof entry.previous === 'string') {
          await fs.writeFile(entry.file, entry.previous, 'utf8');
        } else {
          return { ok: false, reason: 'tooLarge' };
        }
        await save(entries.filter((item) => item.id !== id));
        return { ok: true };
      });
    },
  };
}

module.exports = { createKnowledgeJournal, KNOWLEDGE_JOURNAL_LIMIT: MAX_ENTRIES };
