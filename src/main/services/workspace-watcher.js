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
 * - **Rauschfilter.** Über den ganzen Ordner hinweg ist eine Ignorierliste
 *   unverzichtbar: `node_modules/` und `.git/` erzeugen bei jedem
 *   `npm install` und jedem Git-Befehl Tausende Ereignisse, die im Baum
 *   nichts bewegen.
 * - **Git-Signale.** `.git/HEAD` und `.git/index` bleiben ausdrücklich drin:
 *   Sie sind das eine verlässliche Zeichen dafür, dass gerade halbe
 *   Verzeichnisbäume ausgetauscht werden. Gemeldet werden sie als
 *   „nicht zuzuordnen“, damit der Empfänger einmal gröber neu lädt, statt
 *   hundert Einzelmeldungen zu verarbeiten.
 */

const { createDirectoryWatcher } = require('./directory-watcher');

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
 * Was aus `.git/` trotzdem durchkommt: die beiden Dateien, an denen ein
 * `git checkout`, `git pull` oder `git switch` erkennbar ist.
 */
const GIT_SIGNAL_FILES = new Set(['HEAD', 'index', 'ORIG_HEAD']);

/**
 * Editor- und Systemkram, der im Baum nie erscheint. `vim` legt beim
 * Speichern `4913` und `.datei.swp` an, `sed -i`/atomare Schreiber hantieren
 * mit `.tmp`-Dateien, macOS pflegt `.DS_Store` im Hintergrund.
 */
const NOISE_FILE_PATTERN = /(^|[\\/])(\.DS_Store|4913|\.?[^\\/]*\.sw[px]|[^\\/]*~)$/;

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
 * Rauschen? Gemeint ist nur der Inhalt der Ignorierliste, nicht sie selbst:
 * `node_modules` meldet sich, `node_modules/left-pad/index.js` nicht.
 */
function isIgnoredWorkspacePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath) return false;
  if (isGitSignal(relativePath)) return false;
  if (NOISE_FILE_PATTERN.test(relativePath)) return true;
  const segments = segmentsOf(relativePath);
  // Das letzte Stück ist der Eintrag selbst — erst ein Stück davor macht ihn
  // zum Inhalt eines ignorierten Verzeichnisses.
  return segments.slice(0, -1).some((segment) => IGNORED_CONTENT_DIRS.has(segment));
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
