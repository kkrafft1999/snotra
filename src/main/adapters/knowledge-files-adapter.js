'use strict';

/**
 * Knowledge-files port (#1319): snapshots of the open folder's knowledge
 * files around a shell or Python command, the comparison, and the reset.
 *
 * The files are small — `AGENTS.md`, `.agents/memory.md`, the rules files, the
 * skills — and read whole, within limits. The global ones under `~/.snotra`
 * and `~/.agents` are taken too, keyed `~/…`: where a command runs without a
 * sandbox (Windows, or the sandbox switched off), nothing else keeps it out
 * of them. A folder that leads out of the open
 * folder (symlink) is not followed, as #534 does for `AGENTS.md`; what it holds
 * is not the folder's. Past the limits the snapshot says it is incomplete and
 * compares only what it holds.
 */

const { workspaceKnowledgeKind, globalKnowledgeKind } = require('../../shared/contracts/knowledge-files');
const { isPathInside } = require('../../shared/runtime/path-inside');
const { splitLines, diffLines } = require('../services/line-diff');

const LIMITS = Object.freeze({
  FILES: 300,
  BYTES_PER_FILE: 256 * 1024,
  BYTES_TOTAL: 4 * 1024 * 1024,
  /** The card shows at most this much of the diff. */
  DIFF_CHARS: 60_000,
  /** Lines of context around a change. */
  CONTEXT: 2,
});

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {string|null} [deps.homeDir]  for the global knowledge files
 * @returns {import('../../application/ports/knowledge-files-port').KnowledgeFilesPort}
 */
function createKnowledgeFilesAdapter({ fs, path, homeDir = null }) {
  if (!fs || !path) throw new TypeError('createKnowledgeFilesAdapter needs fs and path.');
  const home = typeof homeDir === 'string' && homeDir ? path.resolve(homeDir) : null;

  /** A key `~/…` lies under the home folder, any other under the open folder. */
  /** @param {string} root @param {string} rel */
  const abs = (root, rel) => (rel.startsWith('~/') && home
    ? path.join(home, ...rel.slice(2).split('/'))
    : path.join(root, ...rel.split('/')));
  /** @param {string} rel */
  const kindOf = (rel) => (rel.startsWith('~/') ? globalKnowledgeKind(rel.slice(2)) : workspaceKnowledgeKind(rel));

  /**
   * The knowledge files under the folder, as relative paths.
   *
   * @param {string} root
   * @param {string} realRoot
   */
  async function listFiles(root, realRoot) {
    /** @type {string[]} */
    const found = [];
    for (const rel of ['AGENTS.md', '.agents/memory.md']) {
      try {
        const stat = await fs.lstat(abs(root, rel));
        if (stat.isFile() || stat.isSymbolicLink()) found.push(rel);
      } catch {
        // Not there: the normal case.
      }
    }
    /** @param {string} rel */
    async function walk(rel) {
      let real;
      try {
        real = await fs.realpath(abs(root, rel));
      } catch {
        // Not there: the normal case.
        return;
      }
      // A folder that leads out of the open folder is not the folder's.
      if (!isPathInside(path, realRoot, real)) return;
      let entries;
      try {
        entries = await fs.readdir(abs(root, rel), { withFileTypes: true });
      } catch {
        // Unreadable: nothing to compare.
        return;
      }
      for (const entry of entries) {
        if (found.length > LIMITS.FILES) return;
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile() || entry.isSymbolicLink()) found.push(child);
      }
    }
    await walk('.agents/rules');
    await walk('.agents/skills');
    if (home) {
      for (const rel of ['~/.snotra/memory.md', '~/.snotra/AGENTS.md', '~/.agents/AGENTS.md']) {
        try {
          await fs.stat(abs(root, rel));
          found.push(rel);
        } catch {
          // Not there: the normal case.
        }
      }
      for (const base of ['~/.snotra/rules', '~/.agents/rules', '~/.snotra/skills', '~/.agents/skills']) await walkGlobal(base);
    }
    return found;

    /**
     * A global folder: the user's own, so a link elsewhere is followed — a
     * dotfiles manager puts it there.
     *
     * @param {string} rel
     */
    async function walkGlobal(rel) {
      let entries;
      try {
        entries = await fs.readdir(abs(root, rel), { withFileTypes: true });
      } catch {
        // Not there: the normal case.
        return;
      }
      for (const entry of entries) {
        if (found.length > LIMITS.FILES) return;
        const child = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walkGlobal(child);
        else if (entry.isFile() || entry.isSymbolicLink()) found.push(child);
      }
    }
  }

  /**
   * A file's text within the limit, or null when it is not a regular file
   * inside the folder or too large.
   *
   * @param {string} root
   * @param {string} realRoot
   * @param {string} rel
   */
  async function readText(root, realRoot, rel) {
    try {
      const real = await fs.realpath(abs(root, rel));
      if (!rel.startsWith('~/') && !isPathInside(path, realRoot, real)) return null;
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > LIMITS.BYTES_PER_FILE) return null;
      return await fs.readFile(real, 'utf8');
    } catch {
      // Gone between listing and reading, or unreadable: not compared.
      return null;
    }
  }

  /**
   * A unified diff of one file, with a little context.
   *
   * @param {string} rel
   * @param {string|undefined} before
   * @param {string|undefined} after
   */
  function fileDiff(rel, before, after) {
    const a = before === undefined ? [] : splitLines(before).lines;
    const b = after === undefined ? [] : splitLines(after).lines;
    const { segments } = diffLines(a, b);
    const out = [`--- ${before === undefined ? '/dev/null' : `a/${rel}`}`, `+++ ${after === undefined ? '/dev/null' : `b/${rel}`}`];
    let i = 0;
    let j = 0;
    for (let s = 0; s < segments.length; s += 1) {
      const { op, count } = segments[s];
      if (op === 'equal') {
        const first = s === 0;
        const last = s === segments.length - 1;
        if (count <= LIMITS.CONTEXT * 2 && !first && !last) {
          for (let k = 0; k < count; k += 1) out.push(` ${a[i + k]}`);
        } else {
          if (!first) for (let k = 0; k < Math.min(LIMITS.CONTEXT, count); k += 1) out.push(` ${a[i + k]}`);
          if (!last) {
            out.push('@@');
            for (let k = Math.max(0, count - LIMITS.CONTEXT); k < count; k += 1) out.push(` ${a[i + k]}`);
          }
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
    return out.join('\n');
  }

  return {
    async snapshot({ workspaceRoot }) {
      /** @type {Map<string, string>} */
      const files = new Map();
      let complete = true;
      let realRoot;
      try {
        realRoot = await fs.realpath(workspaceRoot);
      } catch {
        // No folder to look at: an empty snapshot, compared with an empty one.
        return { files, complete: false };
      }
      const listed = await listFiles(workspaceRoot, realRoot);
      if (listed.length > LIMITS.FILES) complete = false;
      let total = 0;
      for (const rel of listed.slice(0, LIMITS.FILES)) {
        const text = await readText(workspaceRoot, realRoot, rel);
        if (text === null) {
          complete = false;
          continue;
        }
        total += Buffer.byteLength(text);
        if (total > LIMITS.BYTES_TOTAL) {
          complete = false;
          break;
        }
        files.set(rel, text);
      }
      return { files, complete };
    },

    compare(before, after) {
      /** @type {import('../../application/ports/knowledge-files-port').KnowledgeChange[]} */
      const changes = [];
      const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
      for (const rel of paths) {
        const a = before.files.get(rel);
        const b = after.files.get(rel);
        if (a === b) continue;
        // A file only one incomplete snapshot holds may just have been left out.
        if (a === undefined && !before.complete) continue;
        if (b === undefined && !after.complete) continue;
        const kind = kindOf(rel);
        if (!kind) continue;
        changes.push({ path: rel, kind, status: a === undefined ? 'added' : b === undefined ? 'removed' : 'changed' });
      }
      let diff = changes.map((change) => fileDiff(change.path, before.files.get(change.path), after.files.get(change.path))).join('\n\n');
      const truncated = diff.length > LIMITS.DIFF_CHARS;
      if (truncated) diff = diff.slice(0, LIMITS.DIFF_CHARS);
      return { changes, diff, truncated };
    },

    async restore({ workspaceRoot, before, changes }) {
      /** @type {string[]} */
      const failed = [];
      for (const change of changes) {
        const target = abs(workspaceRoot, change.path);
        try {
          if (change.status === 'added') {
            await fs.rm(target, { force: true });
          } else {
            const text = before.files.get(change.path);
            if (text === undefined) throw new Error('no snapshot');
            await fs.mkdir(path.dirname(target), { recursive: true });
            // In the open folder, whatever the command left there — a symlink
            // out of it included — is replaced, never written through. A
            // global file is the user's own and may be a dotfiles link: written
            // through.
            if (!change.path.startsWith('~/')) await fs.rm(target, { force: true });
            await fs.writeFile(target, text, 'utf8');
          }
        } catch (error) {
          failed.push(`${change.path}: ${error?.message || 'could not be reset'}`);
        }
      }
      return { ok: failed.length === 0, failed };
    },
  };
}

module.exports = {
  createKnowledgeFilesAdapter,
  KNOWLEDGE_SNAPSHOT_LIMITS: LIMITS,
};
