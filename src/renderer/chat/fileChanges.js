/**
 * What the agent changed, as the renderer knows it (#348).
 *
 * Main keeps the content; the renderer only holds the summaries main sent
 * with each write — `{ id, relativePath, status, created, added, removed }` —
 * and asks for the lines by id when a diff is opened.
 *
 * Two things live here:
 *   - which ids main still holds: every id that arrived in this run of the
 *     app. A summary in a chat from before a restart names content main has
 *     forgotten, and the chat says so instead of offering a dead link;
 *   - an index per conversation and file, for the tree: which changes the
 *     conversation on screen made to the file in a row.
 */

const ID_PATTERN = /^[0-9a-f]{1,16}-\d{1,12}$/;
const STATUSES = new Set(['text', 'unchanged', 'eol-only', 'binary', 'too-large']);

/** One summary as stored and shown, or null. */
export function normalizeChange(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
  return {
    id: raw.id,
    relativePath: typeof raw.relativePath === 'string' ? raw.relativePath : '',
    status: STATUSES.has(raw.status) ? raw.status : 'text',
    created: raw.created === true,
    added: count(raw.added),
    removed: count(raw.removed),
  };
}

/** A list of summaries, or undefined when nothing usable is in it. */
export function normalizeChanges(raw) {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.map(normalizeChange).filter(Boolean);
  return out.length ? out : undefined;
}

const liveIds = new Set();

/** Main sent this id in the current run of the app. */
export function markChangesLive(changes) {
  for (const change of changes || []) {
    if (change?.id) liveIds.add(change.id);
  }
}

/** Does main still hold the content for every one of these? */
export function changesAreLive(changes) {
  return Array.isArray(changes) && changes.length > 0 && changes.every((change) => liveIds.has(change?.id));
}

/**
 * The files one assistant message changed, in the order they were first
 * written, each with every change to it: what the line under the tool log
 * lists.
 */
export function changedFilesOf(toolTrace) {
  const files = new Map();
  for (const entry of Array.isArray(toolTrace) ? toolTrace : []) {
    for (const change of normalizeChanges(entry?.changes) || []) {
      const key = change.relativePath;
      if (!files.has(key)) files.set(key, { relativePath: key, changes: [] });
      files.get(key).changes.push(change);
    }
  }
  return [...files.values()].map((file) => ({ ...file, ...totalsOf(file.changes) }));
}

/** Lines added and removed over several calls, as the line shows them. */
export function totalsOf(changes) {
  let added = 0;
  let removed = 0;
  for (const change of changes || []) {
    added += change.added || 0;
    removed += change.removed || 0;
  }
  return { added, removed };
}

/** Per conversation, per tree path: the changes in the order they happened. */
export function createFileChangeIndex() {
  /** chatId → Map(path → summary[]) */
  const byChat = new Map();

  return {
    record(chatId, path, change) {
      const summary = normalizeChange(change);
      if (!chatId || !path || !summary) return;
      let files = byChat.get(chatId);
      if (!files) {
        files = new Map();
        byChat.set(chatId, files);
      }
      const list = files.get(path) || [];
      if (!list.some((entry) => entry.id === summary.id)) list.push(summary);
      files.set(path, list);
      markChangesLive([summary]);
    },
    /** The changes the chat made to the file, oldest first; [] for none. */
    changesFor(chatId, path) {
      return [...(byChat.get(chatId)?.get(path) || [])];
    },
    /** The file was renamed, moved or deleted: its old path has no row now. */
    forget(path) {
      for (const files of byChat.values()) files.delete(path);
    },
    /** Folder switch: every path held so far belongs to the folder left. */
    clearAll() {
      byChat.clear();
    },
  };
}
