// Back and forward through the files the preview showed (#822).
//
// A browser's history for one pane: every file that reaches the preview is a
// step — a click in the tree, the filter, a link in a Markdown document, "Show
// changes", a link in the chat. Showing the file that is on show already is
// not a step. Opening a file after going back drops what lay ahead.
//
// The list belongs to one folder and lives in memory only: the host starts it
// anew when the folder changes, and nothing of it survives a restart.
//
// Each entry remembers what its view reported when the pane left it (`state`,
// see `viewState()` in `registry.js`) — the scroll position, and in a Markdown
// file whether the source was on show — so that going back lands where the
// reader was. An entry whose file is gone is skipped, not removed: the menu
// still shows it, struck from the choice.
//
// DOM-free on purpose, like the registry: the rules can be tested without a
// pane.

export const HISTORY_LIMIT = 50;

export function createPreviewHistory({ limit = HISTORY_LIMIT } = {}) {
  let entries = [];
  let index = -1;
  let root = null;

  const at = (i) => entries[i] ?? null;

  /** The next entry in `direction` (-1 back, +1 forward) that is not gone. */
  function neighbourIndex(direction) {
    for (let i = index + direction; i >= 0 && i < entries.length; i += direction) {
      if (!entries[i].gone) return i;
    }
    return -1;
  }

  return {
    /**
     * The pane shows `path` now. `target`, when the history asked for it, is
     * the index it went to; anything else is a new step. A new folder starts
     * a new list.
     */
    visit(path, { workspaceRoot = null, target = null } = {}) {
      if (typeof path !== 'string' || !path) return;
      if (workspaceRoot !== root) {
        entries = [];
        index = -1;
        root = workspaceRoot;
      }
      if (Number.isInteger(target) && entries[target]?.path === path) {
        index = target;
        entries[index].gone = false;
        return;
      }
      if (at(index)?.path === path) return;
      entries.splice(index + 1);
      entries.push({ path, state: null, fragment: '', gone: false });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
      index = entries.length - 1;
    },

    /** What the view of the current entry reported as it was left. */
    saveState(path, state) {
      const entry = at(index);
      if (entry && entry.path === path) entry.state = state ?? null;
    },

    /** The `#section` a link opened the current entry with (#641). */
    saveFragment(path, fragment) {
      const entry = at(index);
      if (entry && entry.path === path) entry.fragment = fragment || '';
    },

    /** `{ index, entry }` one step back (-1) or forward (+1), or null. */
    step(direction) {
      const i = neighbourIndex(direction);
      return i < 0 ? null : { index: i, entry: { ...entries[i] } };
    },

    canGo(direction) {
      return neighbourIndex(direction) >= 0;
    },

    /** The file could not be shown any more: skipped from now on. */
    markGone(path) {
      for (const entry of entries) {
        if (entry.path === path) entry.gone = true;
      }
    },

    /** Everything at `path` or inside it went away — a deleted folder (#120). */
    markGoneUnder(path, isInside) {
      for (const entry of entries) {
        if (entry.path === path || isInside(entry.path, path)) entry.gone = true;
      }
    },

    /** A rename or move in the tree: the entries follow it. */
    rename(oldPath, newPath, isInside) {
      for (const entry of entries) {
        if (entry.path === oldPath) entry.path = newPath;
        else if (isInside(entry.path, oldPath)) entry.path = newPath + entry.path.slice(oldPath.length);
      }
    },

    /**
     * The entries one side of the current one, nearest first, for the menu
     * behind the buttons: `{ index, path, gone }`.
     */
    list(direction) {
      const out = [];
      for (let i = index + direction; i >= 0 && i < entries.length; i += direction) {
        out.push({ index: i, path: entries[i].path, gone: entries[i].gone });
      }
      return out;
    },

    entryAt(i) {
      const entry = at(i);
      return entry ? { ...entry } : null;
    },

    reset() {
      entries = [];
      index = -1;
      root = null;
    },

    get current() {
      const entry = at(index);
      return entry ? { ...entry } : null;
    },
    get size() {
      return entries.length;
    },
  };
}
