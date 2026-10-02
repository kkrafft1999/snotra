'use strict';

/**
 * Datei-Watcher für den Projektordner (Issue #158).
 *
 * Der Dateibaum zeigte bis hierher nicht das Dateisystem, sondern den Stand
 * vom letzten Mal, als die App selbst etwas angefasst hat: Was die KI per
 * `shell_execute` anlegte, was ein `git checkout` austauschte, was im Finder
 * entstand — alles blieb unsichtbar, bis man den Ordner neu öffnete. Dieser
 * Dienst beobachtet den Workspace und meldet die betroffenen Ordner.
 *
 * Die Mechanik steckt in `directory-watcher.js` (verallgemeinert aus dem
 * Skills-Watcher, #126/#155). Eigen ist hier dreierlei:
 *
 * - **Das Ziel existiert.** Ein Workspace-Root, den es nicht gibt, ist keiner
 *   — die Kette nach oben (`fallbackLevels: 0`) entfällt, und damit auch jede
 *   Beobachtung fremder Verzeichnisse oberhalb des Projekts.
 * - **Noise filter.** Across the whole folder an ignore list is a must:
 *   `node_modules/` and `.git/` produce thousands of events on every
 *   `npm install` and every git command, and none of them moves the tree.
 *   Where the folder is watched folder by folder (Linux, #648), the same list
 *   keeps the watches out of those folders, so they cost nothing at all.
 *   Beyond that, the watcher ignores exactly the entries the listing never
 *   shows — one definition in `hidden-entries.js` (#650).
 * - **Git signals.** `.git/HEAD`, `.git/index` and `.git/ORIG_HEAD` get
 *   through on purpose: they are the one reliable sign that half the tree is
 *   being swapped. They report as "not attributable", so that the receiver
 *   reloads once, more coarsely, instead of handling a hundred single reports.
 */

const { createDirectoryWatcher } = require('./directory-watcher');
const { isAlwaysHiddenEntryName } = require('../../shared/runtime/hidden-entries');

/**
 * Verzeichnisse, deren **Inhalt** uns nichts angeht. Das Verzeichnis selbst
 * bleibt sichtbar: Entsteht `node_modules` neu, gehört es in den Baum — nur
 * die 30.000 Dateien darin interessieren nicht.
 *
 * Absichtlich kurz gehalten. `out/` oder `dist/` stehen hier nicht: Das sind
 * Ordner, die ein Nutzer sehen will, und teuer werden sie nicht — gemeldet
 * wird entprellt, und der Dateibaum lädt ohnehin nur nach, was gerade
 * aufgeklappt ist.
 */
const IGNORED_CONTENT_DIRS = new Set(['node_modules', '.git']);

/**
 * What gets out of `.git/` all the same: the three files that give away a
 * `git checkout`, `git pull`, `git switch`, `git merge` or `git rebase`.
 */
const GIT_SIGNAL_FILES = new Set(['HEAD', 'index', 'ORIG_HEAD']);

/** Zerlegt einen von `fs.watch` gemeldeten Pfad — je nach Plattform `/` oder `\`. */
function segmentsOf(relativePath) {
  return String(relativePath).split(/[\\/]/).filter(Boolean);
}

/** Ein Git-Signal — `.git/HEAD` und Verwandte, sonst nichts. */
function isGitSignal(relativePath) {
  const segments = segmentsOf(relativePath);
  return segments.length === 2 && segments[0] === '.git' && GIT_SIGNAL_FILES.has(segments[1]);
}

/**
 * Noise? Two kinds:
 *
 * - the content of an ignored folder, not the folder itself: `node_modules`
 *   reports, `node_modules/left-pad/index.js` does not;
 * - an entry the listing never shows (`.git`, `.DS_Store`, `Thumbs.db`, …),
 *   wherever it sits (#650). Nothing beyond that: an editor's `notes.md~` or
 *   `.notes.md.swp` is listed in the tree, so its removal has to reach it.
 */
function isIgnoredWorkspacePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return false;
  if (isGitSignal(relativePath)) return false;
  const segments = segmentsOf(relativePath);
  if (isAlwaysHiddenEntryName(segments.at(-1))) return true;
  // Das letzte Stück ist der Eintrag selbst — erst ein Stück davor macht ihn
  // zum Inhalt eines ignorierten Verzeichnisses.
  return segments.slice(0, -1).some((segment) => IGNORED_CONTENT_DIRS.has(segment));
}

/**
 * Which folders get a watch of their own where the workspace is watched
 * folder by folder (Linux, #648). The ignore list above filters events; this
 * keeps the watches out of the same folders in the first place, so a
 * `node_modules/` of 20,000 files costs none. `.git` at the root is watched
 * on its own, without its subfolders: the signal files sit right in it.
 */
function workspaceFolderPolicy(relativeDir) {
  const segments = segmentsOf(relativeDir);
  if (segments.length === 1 && segments[0] === '.git') return 'flat';
  return segments.some((segment) => IGNORED_CONTENT_DIRS.has(segment)) ? 'skip' : 'recursive';
}

/**
 * @param {object} options
 * @param {Function} options.watch `fs.watch`.
 * @param {object} options.path Pfad-Modul.
 * @param {Function} [options.realpath] `fs.realpathSync.native` — siehe unten.
 * @param {Function} options.onChange Meldung mit `{ directories, complete }`.
 */
function createWorkspaceWatcher({ watch, path, onChange, realpath = null, ...watcherOptions }) {
  if (typeof watch !== 'function') throw new TypeError('createWorkspaceWatcher benötigt watch.');
  if (!path) throw new TypeError('createWorkspaceWatcher benötigt path.');
  if (typeof onChange !== 'function') throw new TypeError('createWorkspaceWatcher benötigt onChange.');

  /**
   * Der Pfad, unter dem der Renderer den Baum kennt — nicht zwingend der, den
   * `fs.watch` bekommt (siehe `watchablePath`). Gemeldet wird immer in dieser
   * Schreibweise, sonst fände der Renderer seine Ordner nicht wieder.
   */
  let angezeigterRoot = null;

  /**
   * Windows verträgt keinen 8.3-Kurznamen im beobachteten Pfad: Meldet der
   * Wächter danach die Langform, bricht libuv mit einer nativen Assertion ab
   * (`!_wcsnicmp(filename, dir, dirlen)`, `src\win\fs-event.c`) — und das
   * reißt den ganzen Prozess mit, kein Fehler, den man fangen könnte
   * (nachgemessen 2026-09-19 im Windows-CI). Beobachtet wird deshalb die
   * aufgelöste Form; gemeldet weiterhin die angezeigte.
   */
  function watchablePath(root) {
    if (typeof realpath !== 'function') return root;
    try {
      return realpath(root);
    } catch {
      // Gibt es den Ordner (noch) nicht, bleibt es beim angezeigten Pfad —
      // der Watcher scheitert dann sauber an ENOENT statt hier.
      return root;
    }
  }

  return createDirectoryWatcher({
    watch,
    path,
    resolveTargets: (workspaceRoot) => {
      angezeigterRoot =
        typeof workspaceRoot === 'string' && workspaceRoot.trim()
          ? path.resolve(workspaceRoot)
          : null;
      // Ohne geöffneten Ordner gibt es nichts zu beobachten. Und der Root
      // selbst braucht keine Kette nach oben — er existiert.
      return angezeigterRoot ? [{ dir: watchablePath(angezeigterRoot), fallbackLevels: 0 }] : [];
    },
    ignores: isIgnoredWorkspacePath,
    folderPolicy: workspaceFolderPolicy,
    changedDirectoryFor: (relativePath, targetDir) => {
      // Ein Git-Signal sagt „hier wurde großflächig getauscht“, aber nicht wo.
      // `null` heißt: nicht zuzuordnen — der Empfänger lädt gröber neu.
      if (isGitSignal(relativePath)) return null;
      return path.dirname(path.join(angezeigterRoot ?? targetDir, relativePath));
    },
    onChange,
    ...watcherOptions,
  });
}

module.exports = {
  createWorkspaceWatcher,
  isIgnoredWorkspacePath,
  isGitSignal,
  IGNORED_CONTENT_DIRS,
};
