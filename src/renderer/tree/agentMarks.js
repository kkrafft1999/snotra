/**
 * What the agent read or changed, per conversation (#347).
 *
 * The tree shows the marks of the conversation on screen. They live in memory
 * only: a new conversation starts without any, a folder switch and a restart
 * clear them. Paths are the tree's own — absolute and native — so a mark
 * finds its row by `data-path`.
 *
 * Three states, from quiet to loud:
 *   read     a reading tool read the file
 *   changed  a writing tool changed it, and the user has looked at it since
 *   unseen   a writing tool changed it, and the user has not looked yet
 * A file only ever moves up by the agent's doing; looking at it moves
 * `unseen` down to `changed`, and nothing else moves a mark down.
 */

import { isInsideDir, joinNative, parentDirOf, segmentsOf } from '../utils/nativePath.js';

export const AGENT_MARK = Object.freeze({
  READ: 'read',
  CHANGED: 'changed',
  UNSEEN: 'unseen',
});

const RANK = Object.freeze({
  [AGENT_MARK.READ]: 1,
  [AGENT_MARK.CHANGED]: 2,
  [AGENT_MARK.UNSEEN]: 3,
});

/** The louder of two marks; either may be null. */
export function strongerMark(a, b) {
  return (RANK[b] || 0) > (RANK[a] || 0) ? b : a || null;
}

/**
 * The tree path a tool's relative path stands for, or null when it leaves the
 * folder. `..` is resolved here: the tree knows no `src/../x` row.
 */
export function markPathFor(rootPath, relativePath) {
  if (!rootPath || typeof relativePath !== 'string') return null;
  const resolved = [];
  for (const segment of segmentsOf(relativePath.trim())) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (!resolved.length) return null;
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  if (!resolved.length) return null;
  return joinNative(rootPath, resolved.join('/'));
}

export function createAgentMarks() {
  /** chatId → Map(path → mark) */
  const byChat = new Map();
  const listeners = new Set();

  function changed() {
    for (const fn of listeners) fn();
  }

  function marksOf(chatId, create = false) {
    let marks = byChat.get(chatId);
    if (!marks && create) {
      marks = new Map();
      byChat.set(chatId, marks);
    }
    return marks || null;
  }

  /** Drops `path` and everything below it from one chat's marks. */
  function dropFrom(marks, path) {
    let dropped = false;
    for (const key of [...marks.keys()]) {
      if (key === path || isInsideDir(key, path)) {
        marks.delete(key);
        dropped = true;
      }
    }
    return dropped;
  }

  return {
    /** A reading tool read the file. Never lowers a change. */
    recordRead(chatId, path) {
      if (!chatId || !path) return;
      const marks = marksOf(chatId, true);
      if (marks.has(path)) return;
      marks.set(path, AGENT_MARK.READ);
      changed();
    },

    /** A writing tool changed the file: loud until the user looks. */
    recordWrite(chatId, path) {
      if (!chatId || !path) return;
      const marks = marksOf(chatId, true);
      if (marks.get(path) === AGENT_MARK.UNSEEN) return;
      marks.set(path, AGENT_MARK.UNSEEN);
      changed();
    },

    /**
     * The user opened the file. That counts in every conversation: it is the
     * same file on disk, and the user has seen what is in it now.
     */
    markSeen(path) {
      let any = false;
      for (const marks of byChat.values()) {
        if (marks.get(path) === AGENT_MARK.UNSEEN) {
          marks.set(path, AGENT_MARK.CHANGED);
          any = true;
        }
      }
      if (any) changed();
    },

    /** Removes the mark of one file or folder (and below) in one chat. */
    clear(chatId, path) {
      const marks = marksOf(chatId);
      if (marks && dropFrom(marks, path)) changed();
    },

    /** The file or folder is gone from disk: gone from every chat. */
    forget(path) {
      let any = false;
      for (const marks of byChat.values()) {
        if (dropFrom(marks, path)) any = true;
      }
      if (any) changed();
    },

    /**
     * A full listing of `dirPath` came back: marks of direct entries that are
     * no longer in it are stale — deleted, renamed or moved. `keep` spares the
     * ones the listing leaves out on purpose (hidden files switched off).
     */
    pruneListing(dirPath, listedPaths, keep = () => false) {
      const listed = new Set(listedPaths);
      const gone = new Set();
      for (const marks of byChat.values()) {
        for (const key of marks.keys()) {
          if (!isInsideDir(key, dirPath)) continue;
          // The direct entry of dirPath this mark lies in or is.
          let entry = key;
          while (parentDirOf(entry) !== dirPath && isInsideDir(parentDirOf(entry), dirPath)) {
            entry = parentDirOf(entry);
          }
          if (parentDirOf(entry) !== dirPath) continue;
          if (!listed.has(entry) && !keep(entry)) gone.add(entry);
        }
      }
      let any = false;
      for (const entry of gone) {
        for (const marks of byChat.values()) {
          if (dropFrom(marks, entry)) any = true;
        }
      }
      if (any) changed();
    },

    clearChat(chatId) {
      const marks = marksOf(chatId);
      if (!marks || marks.size === 0) return;
      byChat.delete(chatId);
      changed();
    },

    /** Folder switch: every path held so far belongs to the folder left. */
    clearAll() {
      if (![...byChat.values()].some((marks) => marks.size > 0)) {
        byChat.clear();
        return;
      }
      byChat.clear();
      changed();
    },

    markOf(chatId, path) {
      return marksOf(chatId)?.get(path) || null;
    },

    hasMarks(chatId) {
      return (marksOf(chatId)?.size || 0) > 0;
    },

    /**
     * The loudest mark below each folder, up to `rootPath` — what a collapsed
     * folder shows. One pass over the marks, not one per folder row.
     */
    folderSummaries(chatId, rootPath) {
      const summaries = new Map();
      const marks = marksOf(chatId);
      if (!marks || !rootPath) return summaries;
      for (const [path, mark] of marks) {
        if (!isInsideDir(path, rootPath)) continue;
        let dir = parentDirOf(path);
        while (dir !== rootPath && isInsideDir(dir, rootPath)) {
          const before = summaries.get(dir) || null;
          const after = strongerMark(before, mark);
          if (after === before) break; // ancestors already carry at least this
          summaries.set(dir, after);
          dir = parentDirOf(dir);
        }
      }
      return summaries;
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
