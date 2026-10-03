/**
 * The flat list of the workspace's paths, as main's `listWorkspacePaths`
 * walks it — one source for the `@` menu (#52) and the tree's filter (#350),
 * so both search the same entries.
 *
 * Fetched on first use and kept for a short while. It is dropped outright on
 * a folder switch, after the agent wrote and whenever the watcher reports a
 * change (app.js, FileTree.js); the short lifetime catches what reports
 * nothing. Keyed by the folder and by whether hidden files are shown (#436):
 * the list follows the tree, so switching them over fetches it anew.
 */

const CACHE_MAX_AGE_MS = 30_000;

/**
 * @returns {{
 *   load: () => Promise<{ entries: Array<{path: string, kind: string}>, truncated: boolean }>,
 *   invalidate: () => void,
 * }}
 */
export function createWorkspacePathSource({ api, appStore, maxAgeMs = CACHE_MAX_AGE_MS }) {
  const empty = () => ({ entries: [], truncated: false });
  let cache = null; // { root, showHidden, list, fetchedAt }
  let pending = null; // { root, showHidden, promise }
  let generation = 0;

  function invalidate() {
    generation += 1;
    cache = null;
    pending = null;
  }

  async function load() {
    const root = appStore.rootPath;
    if (!root || typeof api?.listWorkspacePaths !== 'function') return empty();
    const showHidden = appStore.showHiddenFiles === true;
    const matches = (held) => held?.root === root && held.showHidden === showHidden;
    if (matches(cache) && Date.now() - cache.fetchedAt < maxAgeMs) return cache.list;
    if (matches(pending)) return pending.promise;

    const asked = generation;
    const promise = (async () => {
      let list = empty();
      try {
        const result = await api.listWorkspacePaths({ showHidden });
        list = {
          entries: Array.isArray(result?.entries) ? result.entries : [],
          truncated: result?.truncated === true,
        };
      } catch {
        list = empty();
      }
      // Dropped meanwhile, or the folder changed: handed to the caller who
      // asked, but not kept for the next.
      if (asked === generation && appStore.rootPath === root) {
        cache = { root, showHidden, list, fetchedAt: Date.now() };
      }
      if (pending?.promise === promise) pending = null;
      return list;
    })();
    pending = { root, showHidden, promise };
    return promise;
  }

  return { load, invalidate };
}
