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
 * - **Ein verschwindendes Verzeichnis meldet sich nicht brauchbar.** Wird der
 *   beobachtete Ordner gelöscht, verstummt der Watcher unter macOS still —
 *   kein Ereignis, kein Fehler. Unter Windows ist es das Gegenteil: Er feuert
 *   danach endlos weiter, mit dem eigenen absoluten Pfad als Dateinamen
 *   (beides nachgemessen 2026-09-13). Verlassen kann man sich auf keine der
 *   beiden Varianten.
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
 * Obergrenze für das Zusammenfassen. Ohne sie verschiebt eine ununterbrochene
 * Ereignis-Folge die Meldung immer weiter und es kommt nie zu einer — genau
 * das passiert unter Windows, wo ein Watcher nach dem Entfernen seines
 * Verzeichnisses endlos weiterfeuert (nachgemessen 2026-09-13), und ebenso
 * bei einem Build-Prozess, der dauernd in den Ordner schreibt.
 */
const DEFAULT_MAX_WAIT_MS = 1000;

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
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
  onError = null,
}) {
  if (typeof watch !== 'function') throw new TypeError('createSkillsWatcher benötigt watch.');
  if (!path) throw new TypeError('createSkillsWatcher benötigt path.');
  if (typeof onChange !== 'function') throw new TypeError('createSkillsWatcher benötigt onChange.');

  /** @type {Array<{ watcher: object, dir: string, isTarget: boolean }>} */
  let slots = [];
  let currentRoot = null;
  let debounceTimer = null;
  /** Zeitpunkt des ersten noch nicht gemeldeten Ereignisses. */
  let pendingSince = null;
  /** Hat eines der gesammelten Ereignisse einen Neuaufbau verlangt? */
  let pendingRebuild = false;
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
    // Ein Neuaufbau darf nicht verloren gehen, nur weil danach noch
    // Ereignisse eintrudeln, die für sich genommen keinen bräuchten.
    pendingRebuild = pendingRebuild || rebuild;
    const now = nowImpl();
    if (pendingSince === null) pendingSince = now;

    // Verlängert wird nur innerhalb des Höchstfensters. Danach läuft der
    // bereits gesetzte Timer aus, statt immer weiter verschoben zu werden.
    const darfVerlaengern = now - pendingSince < maxWaitMs;
    if (debounceTimer && !darfVerlaengern) return;
    if (debounceTimer) clearTimeoutImpl(debounceTimer);

    debounceTimer = setTimeoutImpl(() => {
      debounceTimer = null;
      pendingSince = null;
      const rebuildNoetig = pendingRebuild;
      pendingRebuild = false;
      if (closed) return;
      // Erst neu aufsetzen, dann melden: Wurde das Verzeichnis gerade
      // angelegt oder entfernt, hängt der Watcher danach am richtigen Pfad,
      // und der folgende Scan sieht den neuen Stand.
      if (rebuildNoetig) build(currentRoot);
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
          notifyLater({ rebuild: !isTarget });
        });
        if (typeof watcher.on === 'function') {
          // Manche Plattformen melden einen Fehler statt eines Ereignisses.
          // Unbehandelt wäre das ein 'error'-Event ohne Listener und damit
          // ein Absturz des Main-Prozesses.
          watcher.on('error', (error) => {
            onError?.(error, dir);
            notifyLater({ rebuild: true });
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
    pendingSince = null;
    pendingRebuild = false;
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
  DEFAULT_MAX_WAIT_MS,
  MAX_FALLBACK_LEVELS,
};
