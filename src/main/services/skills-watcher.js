'use strict';

/**
 * Datei-Watcher für die Skill-Verzeichnisse (Issue #126, Teil von #89).
 *
 * Bis hierher wurde nur beim Öffnen eines Ordners und auf Knopfdruck gescannt
 * — ein frisch angelegter oder per `skill-manager` installierter Skill tauchte
 * erst nach „Skills neu laden“ auf. Dieser Dienst beobachtet die Quellen und
 * meldet Änderungen, damit der Scan-Cache von selbst verfällt.
 *
 * Beobachtet werden die beiden *Ordner*-Quellen: `<workspace>/.agents/skills`
 * und `~/.agents/skills`. Die System-Skills liegen im App-Bundle und ändern
 * sich zur Laufzeit nicht.
 *
 * Zwei Eigenheiten prägen den Aufbau:
 *
 * - **Die Verzeichnisse fehlen meistens.** `.agents/skills` ist die Ausnahme,
 *   nicht die Regel, und `fs.watch` scheitert an einem Pfad, den es nicht
 *   gibt.
 * - **Ein verschwindendes Verzeichnis meldet sich nicht selbst.** Wird der
 *   beobachtete Ordner gelöscht, verstummt der Watcher unter macOS still —
 *   kein Ereignis, kein Fehler (nachgemessen 2026-09-13).
 *
 * Beides hat dieselbe Antwort: Beobachtet wird nicht nur das Skill-
 * Verzeichnis, sondern zugleich seine vorhandenen Vorfahren bis hinauf zur
 * Workspace- bzw. Home-Wurzel. Der Wächter oben sieht das Pfadstück kommen
 * und gehen, der unten die Arbeit an den einzelnen `SKILL.md`. Damit ein
 * belebtes Projektverzeichnis nicht dauernd Scans auslöst, achten die oberen
 * Wächter nur auf den Namen, auf den sie warten.
 *
 * Ein Vorgang erzeugt dabei viele Ereignisse — ein entpacktes Archiv oder ein
 * `git checkout` löst Dutzende aus. Gemeldet wird deshalb entprellt, ein
 * einziges Mal am Ende.
 */

/** Ereignisse zusammenfassen, statt bei jedem einzelnen neu zu scannen. */
const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Wie weit dürfen die Wächter aufsteigen? `.agents/skills` → `.agents` →
 * Workspace- bzw. Home-Wurzel. Weiter nicht: Darüber lägen fremde
 * Verzeichnisse, die uns nichts angehen.
 */
const MAX_FALLBACK_LEVELS = 2;

function createSkillsWatcher({
  watch,
  path,
  os = null,
  onChange,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  onError = null,
}) {
  if (typeof watch !== 'function') throw new TypeError('createSkillsWatcher benötigt watch.');
  if (!path) throw new TypeError('createSkillsWatcher benötigt path.');
  if (typeof onChange !== 'function') throw new TypeError('createSkillsWatcher benötigt onChange.');

  /** @type {Array<{ watcher: object, dir: string, isTarget: boolean }>} */
  let slots = [];
  let currentRoot = null;
  let debounceTimer = null;
  let closed = false;

  function homeDir() {
    try {
      return os && typeof os.homedir === 'function' ? os.homedir() : null;
    } catch {
      return null;
    }
  }

  /** Die zu beobachtenden Skill-Verzeichnisse — ohne die System-Quelle. */
  function targetDirectories(workspaceRoot) {
    const dirs = [];
    const root =
      typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : null;
    if (root) dirs.push(path.join(root, '.agents', 'skills'));
    const home = homeDir();
    if (home) dirs.push(path.join(home, '.agents', 'skills'));
    // Liegt der Workspace im Home, fallen beide Pfade zusammen.
    return [...new Set(dirs)];
  }

  function closeSlots() {
    for (const slot of slots) {
      try {
        slot.watcher.close();
      } catch {
        // Ein bereits geschlossener Watcher ist kein Fehler.
      }
    }
    slots = [];
  }

  function notifyLater({ rebuild }) {
    if (closed) return;
    if (debounceTimer) clearTimeoutImpl(debounceTimer);
    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = null;
      if (closed) return;
      // Erst neu aufsetzen, dann melden: Wurde das Verzeichnis gerade
      // angelegt, hängt der Watcher danach am richtigen Pfad, und der
      // folgende Scan sieht den neuen Stand.
      if (rebuild()) build(currentRoot);
      onChange();
    }, debounceMs);
  }

  /**
   * Meldet ein Wächter über dem Ziel eine Änderung, die gar nicht das
   * erwartete Pfadstück betrifft, geht sie uns nichts an: In einem belebten
   * Projektverzeichnis wäre sonst jede angelegte Datei ein Anlass, alle
   * Skills neu zu lesen. Ohne Dateinamen (den liefert nicht jede Plattform)
   * bleibt es bei „lieber einmal zu viel“.
   */
  function concernsUs(filename, expectedChild) {
    if (!expectedChild || !filename) return true;
    const name = String(filename);
    return name === expectedChild || name.startsWith(`${expectedChild}${path.sep}`);
  }

  /**
   * Beobachtet das Skill-Verzeichnis **und** seine vorhandenen Vorfahren.
   * Nicht entweder-oder: Das Ziel sieht die Arbeit an den Skills, die
   * Vorfahren sehen das Ziel selbst entstehen und vergehen.
   */
  function watchChain(targetDir) {
    let dir = targetDir;
    let expectedChild = null;
    for (let level = 0; level <= MAX_FALLBACK_LEVELS; level += 1) {
      const isTarget = dir === targetDir;
      const childName = expectedChild;
      try {
        // Unterhalb des Skill-Verzeichnisses zählt jede Ebene (die SKILL.md
        // liegt im Unterordner). Ein Wächter darüber wartet nur auf ein
        // einzelnes Pfadstück und bleibt flach.
        const watcher = watch(dir, { recursive: isTarget }, (_eventType, filename) => {
          if (!isTarget && !concernsUs(filename, childName)) return;
          // Oberhalb des Ziels kann sich der Pfad geändert haben — neu
          // aufbauen. Das Ziel selbst meldet nur.
          notifyLater({ rebuild: () => !isTarget });
        });
        if (typeof watcher.on === 'function') {
          // Manche Plattformen melden einen Fehler statt eines Ereignisses.
          // Unbehandelt wäre das ein 'error'-Event ohne Listener und damit
          // ein Absturz des Main-Prozesses.
          watcher.on('error', (error) => {
            onError?.(error, dir);
            notifyLater({ rebuild: () => true });
          });
        }
        slots.push({ watcher, dir, isTarget });
      } catch (error) {
        onError?.(error, dir);
      }
      const parent = path.dirname(dir);
      if (!parent || parent === dir) break;
      expectedChild = path.basename(dir);
      dir = parent;
    }
  }

  function build(workspaceRoot) {
    closeSlots();
    currentRoot = workspaceRoot ?? null;
    for (const dir of targetDirectories(workspaceRoot)) watchChain(dir);
  }

  /**
   * Auf einen Workspace umschalten (`null` = keiner offen). Alte Watcher
   * werden dabei geschlossen — sonst bliebe bei jedem Ordnerwechsel ein
   * Handle zurück.
   */
  function watchWorkspace(workspaceRoot) {
    if (closed) return;
    build(workspaceRoot);
  }

  /** Alles abräumen; danach ist der Dienst endgültig aus. */
  function close() {
    closed = true;
    if (debounceTimer) {
      clearTimeoutImpl(debounceTimer);
      debounceTimer = null;
    }
    closeSlots();
    currentRoot = null;
  }

  /** Nur für Tests und Diagnose: was wird gerade beobachtet? */
  function watchedDirectories() {
    return slots.map((slot) => ({ dir: slot.dir, isTarget: slot.isTarget }));
  }

  return { watchWorkspace, close, watchedDirectories };
}

module.exports = {
  createSkillsWatcher,
  DEFAULT_DEBOUNCE_MS,
  MAX_FALLBACK_LEVELS,
};
