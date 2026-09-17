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
 *
 * Auf eines ist dabei kein Verlass: dass jedes Ereignis auch ankommt.
 * `fs.watch()` kehrt zurück, bevor der FSEvents-Stream wirklich läuft — was in
 * dieses Startfenster fällt, ist weg. Hängt die Kette mangels
 * `.agents/skills` auf einem Vorfahren und geht ausgerechnet dessen Ereignis
 * verloren, bliebe der Dienst dauerhaft taub, denn ein Vorfahren-Wächter ist
 * flach und hört nur auf sein erwartetes Pfadstück (Issue #155). Dagegen steht
 * eine Wiedervorlage: Solange ein Skill-Verzeichnis fehlt, wird alle paar
 * Sekunden nachgesehen, ob es inzwischen da ist. Im Normalfall — Ziel
 * vorhanden — läuft dieser Timer nicht.
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
 * Abstand der Wiedervorlage, solange ein Skill-Verzeichnis fehlt (Issue #155).
 * Der Timer läuft nur in diesem Ausnahmefall und endet, sobald das Ziel
 * erreicht ist; eine Runde kostet je fehlendem Ziel einen `watch`-Versuch,
 * der an ENOENT scheitert. Ein paar Sekunden sind der Kompromiss: schnell
 * genug, dass ein frisch installierter Skill ohne Zutun auftaucht, träge
 * genug, um im Hintergrund nicht aufzufallen.
 */
const DEFAULT_RETRY_MS = 3000;

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
  retryMs = DEFAULT_RETRY_MS,
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
  /** Läuft nur, solange ein Skill-Verzeichnis fehlt (Wiedervorlage, #155). */
  let retryTimer = null;
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

  /** Skill-Verzeichnisse, deren Kette gerade auf einem Vorfahren hängt. */
  function unwatchedTargets() {
    const beobachtet = new Set(slots.filter((slot) => slot.isTarget).map((slot) => slot.dir));
    return targetDirectories(currentRoot).filter((dir) => !beobachtet.has(dir));
  }

  /**
   * Gibt es das Verzeichnis inzwischen? Gefragt wird mit demselben Mittel,
   * an dem es zuvor gescheitert ist: Ein `watch` auf einen fehlenden Pfad
   * wirft ENOENT. Das erspart eine zweite Dateisystem-Abhängigkeit und prüft
   * genau das, worauf es ankommt — nicht nur, ob der Pfad existiert, sondern
   * ob er sich auch beobachten lässt.
   */
  function targetReachable(dir) {
    let probe = null;
    try {
      probe = watch(dir, { recursive: false }, () => {});
    } catch {
      return false;
    }
    try {
      // Ein 'error' ohne Listener risse den Main-Prozess mit — auch in der
      // kurzen Zeitspanne bis zum close().
      if (typeof probe.on === 'function') probe.on('error', () => {});
      probe.close();
    } catch {
      // Ein Probe-Watcher, der sich nicht schließen lässt, ist kein Grund
      // zur Aufregung: Er hat seine Frage bereits beantwortet.
    }
    return true;
  }

  /**
   * Wiedervorlage, solange ein Ziel fehlt (Issue #155). Ein verlorenes
   * Ereignis auf einem Vorfahren darf den Dienst nicht dauerhaft taub machen,
   * und der Vorfahren-Wächter selbst bekommt danach nichts mehr mit. Hängen
   * alle Ketten an ihrem Ziel, läuft hier kein Timer.
   */
  function scheduleRetry() {
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
    if (closed || unwatchedTargets().length === 0) return;

    retryTimer = setTimeoutImpl(() => {
      retryTimer = null;
      if (closed) return;
      if (!unwatchedTargets().some(targetReachable)) {
        scheduleRetry();
        return;
      }
      // Das Verzeichnis ist da, die Kette hängt aber noch oben: neu aufsetzen
      // und melden, damit der Scan die inzwischen angelegten Skills sieht.
      build(currentRoot);
      notifyLater({ rebuild: false });
    }, retryMs);
  }

  function build(workspaceRoot) {
    closeSlots();
    currentRoot = workspaceRoot ?? null;
    for (const dir of targetDirectories(workspaceRoot)) watchChain(dir);
    scheduleRetry();
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
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
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

  /** Nur für Tests und Diagnose: wartet gerade eine Wiedervorlage? */
  function retryPending() {
    return retryTimer !== null;
  }

  return { watchWorkspace, close, watchedDirectories, retryPending };
}

module.exports = {
  createSkillsWatcher,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RETRY_MS,
  MAX_FALLBACK_LEVELS,
};
