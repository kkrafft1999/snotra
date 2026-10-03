/**
 * What the middle column does when a folder is opened (#208, #255, #258, #351).
 *
 * Three wishes meet, and their order is the point:
 *
 * 1. **A restored chat beats everything** (#208). Whoever left the app in the
 *    middle of a conversation lands there again — not next to a column that
 *    was meant for a cold start.
 * 2. **The explicit preference** from the switch in the title bar (#222).
 *    `true` shows the column, `false` leaves it out; either is only in the
 *    prefs once the user has used the switch.
 * 3. **Without a stored wish the folder decides.** Without a folder the start
 *    screen is the right thing (#258): it is the way in, and without it the
 *    app would stand there empty. With a folder the column opens only when
 *    the folder has a README to show (#351) — then it shows what the folder
 *    is, rendered, and the room has its third wall. Without one it stays
 *    closed (#255): all there would be to see is the start screen, which
 *    nobody needs at that point.
 *
 * The rule holds for every folder that is opened, at the start and on every
 * switch, and nothing of it is remembered per folder (#351).
 *
 * `preference` is therefore three-valued: `undefined` means "never set" and is
 * something other than a switched-off `false`. The contract leaves the key out
 * for that instead of normalising it to `false`.
 *
 * DOM-free and exported, so that the decision can be tested without a window
 * (like pickSessionToRestore, #78).
 */
export function contentPaneVisibleOnStart({ preference, chatRestored, hasFolder, folderHasReadme }) {
  if (chatRestored === true) return false;
  if (typeof preference === 'boolean') return preference;
  if (hasFolder !== true) return true;
  return folderHasReadme === true;
}

/**
 * The README a folder opens with (#351), from the paths of its top level:
 * `README.md` — only that one, not `AGENTS.md` or a `README.txt`. A spelling
 * in another case counts as well (`readme.md`, `Readme.md`); on a disk that
 * tells the cases apart, the exact `README.md` goes first.
 *
 * @param {string[]} paths files of the folder's top level
 * @returns {string|null} the path, or null when there is none
 */
export function pickFolderReadme(paths) {
  const name = (p) => String(p).split(/[\\/]/).pop();
  const files = Array.isArray(paths) ? paths : [];
  return files.find((p) => name(p) === 'README.md')
    ?? files.find((p) => name(p).toLowerCase() === 'readme.md')
    ?? null;
}
