'use strict';

/**
 * Verzeichnis-Wächter für beliebige Ziele (Issue #158).
 *
 * Der Kern stammt aus dem Skills-Watcher (#126, nachgeschärft in #155) und ist
 * hier von seinem einen Zweck gelöst: Welche Verzeichnisse beobachtet werden,
 * wie weit die Kette nach oben reicht, was als Rauschen gilt und wie die
 * Meldung aussieht, gibt der Aufrufer vor. `skills-watcher.js` und
 * `workspace-watcher.js` sind nur noch dünne Hüllen darum.
 *
 * Bewusst **ein** Dienst statt zweier: Die Plattform-Fallen unten sind teuer
 * bezahlt, und jede davon müsste sonst zweimal gelernt werden.
 *
 * Zwei Eigenheiten prägen den Aufbau:
 *
 * - **Das Ziel fehlt womöglich.** `.agents/skills` ist die Ausnahme, nicht die
 *   Regel, und `fs.watch` scheitert an einem Pfad, den es nicht gibt.
 * - **Ein verschwindendes Verzeichnis meldet sich nicht brauchbar.** Wird der
 *   beobachtete Ordner gelöscht, verstummt der Watcher unter macOS still —
 *   kein Ereignis, kein Fehler. Unter Windows ist es das Gegenteil: Er feuert
 *   danach endlos weiter, mit dem eigenen absoluten Pfad als Dateinamen
 *   (beides nachgemessen 2026-09-13). Verlassen kann man sich auf keine der
 *   beiden Varianten.
 *
 * Beides hat dieselbe Antwort: Beobachtet wird nicht nur das Ziel, sondern
 * zugleich seine vorhandenen Vorfahren. Der Wächter oben sieht das Pfadstück
 * kommen und gehen, der unten die Arbeit darin. Damit ein belebtes
 * Projektverzeichnis nicht dauernd Meldungen auslöst, achten die oberen
 * Wächter nur auf den Namen, auf den sie warten. Ein Ziel, das ohnehin
 * existiert — der Workspace-Root selbst —, braucht keine Kette und bekommt
 * `fallbackLevels: 0`.
 *
 * Ein Vorgang erzeugt dabei viele Ereignisse — ein entpacktes Archiv oder ein
 * `git checkout` löst Dutzende aus. Gemeldet wird deshalb entprellt, ein
 * einziges Mal am Ende, mit allen betroffenen Ordnern zusammen.
 *
 * Auf eines ist dabei kein Verlass: dass jedes Ereignis auch ankommt.
 * `fs.watch()` kehrt zurück, bevor der FSEvents-Stream wirklich läuft — was in
 * dieses Startfenster fällt, ist weg. Hängt die Kette mangels Ziel auf einem
 * Vorfahren und geht ausgerechnet dessen Ereignis verloren, bliebe der Dienst
 * dauerhaft taub, denn ein Vorfahren-Wächter ist flach und hört nur auf sein
 * erwartetes Pfadstück (Issue #155). Dagegen steht eine Wiedervorlage: Solange
 * ein Ziel fehlt, wird alle paar Sekunden nachgesehen, ob es inzwischen da
 * ist. Im Normalfall — Ziel vorhanden — läuft dieser Timer nicht.
 */

/** Ereignisse zusammenfassen, statt bei jedem einzelnen zu melden. */
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
 * Abstand der Wiedervorlage, solange ein Ziel fehlt (Issue #155). Der Timer
 * läuft nur in diesem Ausnahmefall und endet, sobald das Ziel erreicht ist;
 * eine Runde kostet je fehlendem Ziel einen `watch`-Versuch, der an ENOENT
 * scheitert. Ein paar Sekunden sind der Kompromiss: schnell genug, dass ein
 * frisch angelegtes Verzeichnis ohne Zutun auftaucht, träge genug, um im
 * Hintergrund nicht aufzufallen.
 */
const DEFAULT_RETRY_MS = 3000;

/**
 * Wie weit dürfen die Wächter aufsteigen, wenn das Ziel nichts anderes sagt?
 * Zwei Ebenen decken `.agents/skills` → `.agents` → Wurzel ab. Weiter nicht:
 * Darüber lägen fremde Verzeichnisse, die uns nichts angehen.
 */
const DEFAULT_FALLBACK_LEVELS = 2;

/**
 * @param {object} options
 * @param {Function} options.watch `fs.watch` (injizierbar für Tests).
 * @param {object} options.path Pfad-Modul (posix in Tests, nativ im Betrieb).
 * @param {(root: string|null) => Array<string|{dir: string, fallbackLevels?: number}>} options.resolveTargets
 *   Welche Verzeichnisse für diesen Workspace-Root beobachtet werden.
 * @param {(payload: {directories: string[], complete: boolean}) => void} options.onChange
 *   Meldung nach dem Entprellen. `directories` sind die betroffenen **Ordner**
 *   (nicht die Dateien); `complete: false` heißt „da war noch mehr, das sich
 *   keinem Ordner zuordnen ließ“ — dann muss der Empfänger gröber neu laden.
 * @param {(relativePath: string, targetDir: string) => boolean} [options.ignores]
 *   Rauschfilter für Ereignisse **innerhalb** eines Ziels.
 * @param {(relativePath: string, targetDir: string) => string|null} [options.changedDirectoryFor]
 *   Welcher Ordner gilt als betroffen? Vorgabe ist der Elternordner des
 *   gemeldeten Eintrags; `null` bedeutet „nicht zuzuordnen“.
 */
function createDirectoryWatcher({
  watch,
  path,
  resolveTargets,
  onChange,
  ignores = null,
  changedDirectoryFor = null,
  fallbackLevels = DEFAULT_FALLBACK_LEVELS,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  retryMs = DEFAULT_RETRY_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
  onError = null,
}) {
  if (typeof watch !== 'function') throw new TypeError('createDirectoryWatcher benötigt watch.');
  if (!path) throw new TypeError('createDirectoryWatcher benötigt path.');
  if (typeof resolveTargets !== 'function') {
    throw new TypeError('createDirectoryWatcher benötigt resolveTargets.');
  }
  if (typeof onChange !== 'function') throw new TypeError('createDirectoryWatcher benötigt onChange.');

  /** @type {Array<{ watcher: object, dir: string, isTarget: boolean }>} */
  let slots = [];
  let currentRoot = null;
  let debounceTimer = null;
  /** Zeitpunkt des ersten noch nicht gemeldeten Ereignisses. */
  let pendingSince = null;
  /** Hat eines der gesammelten Ereignisse einen Neuaufbau verlangt? */
  let pendingRebuild = false;
  /** Betroffene Ordner seit der letzten Meldung. */
  let pendingDirectories = new Set();
  /** Gab es ein Ereignis, das sich keinem Ordner zuordnen ließ? */
  let pendingUnattributed = false;
  /** Läuft nur, solange ein Ziel fehlt (Wiedervorlage, #155). */
  let retryTimer = null;
  let closed = false;

  /** Die Ziele in einheitlicher Form — Zeichenkette oder Objekt ist erlaubt. */
  function targets(workspaceRoot) {
    const list = resolveTargets(workspaceRoot ?? null) || [];
    const seen = new Set();
    const normalized = [];
    for (const entry of list) {
      const dir = typeof entry === 'string' ? entry : entry?.dir;
      if (typeof dir !== 'string' || !dir || seen.has(dir)) continue;
      seen.add(dir);
      const levels = typeof entry === 'object' && entry !== null ? entry.fallbackLevels : undefined;
      normalized.push({ dir, fallbackLevels: Number.isInteger(levels) ? levels : fallbackLevels });
    }
    return normalized;
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

  function notifyLater({ rebuild, directory = null }) {
    if (closed) return;
    // Ein Neuaufbau darf nicht verloren gehen, nur weil danach noch
    // Ereignisse eintrudeln, die für sich genommen keinen bräuchten.
    pendingRebuild = pendingRebuild || rebuild;
    if (directory) pendingDirectories.add(directory);
    else pendingUnattributed = true;
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
      const directories = [...pendingDirectories];
      const complete = !pendingUnattributed;
      pendingRebuild = false;
      pendingDirectories = new Set();
      pendingUnattributed = false;
      if (closed) return;
      // Erst neu aufsetzen, dann melden: Wurde das Verzeichnis gerade
      // angelegt oder entfernt, hängt der Watcher danach am richtigen Pfad,
      // und der folgende Neuaufbau sieht den neuen Stand.
      if (rebuildNoetig) build(currentRoot);
      // Die Obergrenze für die Liste steckt im Vertrag
      // (`createWorkspaceTreeChangedEvent`) — hier zählt nur, dass alles
      // Gesammelte einmal herauskommt.
      onChange({ directories, complete });
    }, debounceMs);
  }

  /**
   * Meldet ein Wächter über dem Ziel eine Änderung, die gar nicht das
   * erwartete Pfadstück betrifft, geht sie uns nichts an: In einem belebten
   * Projektverzeichnis wäre sonst jede angelegte Datei ein Anlass. Ohne
   * Dateinamen (den liefert nicht jede Plattform) bleibt es bei „lieber einmal
   * zu viel“.
   */
  function concernsUs(filename, expectedChild) {
    if (!expectedChild || !filename) return true;
    const name = String(filename);
    return name === expectedChild || name.startsWith(`${expectedChild}${path.sep}`);
  }

  /**
   * Welcher Ordner ist betroffen? Vorgabe: der Elternordner des gemeldeten
   * Eintrags — bei `sub/datei.txt` also `<ziel>/sub`, bei einem gelöschten
   * Unterordner dessen Elternordner. Genau das braucht ein Empfänger, der
   * einen Verzeichnis-Inhalt neu liest.
   */
  function changedDirectory(relativePath, targetDir) {
    if (typeof changedDirectoryFor === 'function') {
      return changedDirectoryFor(relativePath, targetDir) ?? null;
    }
    return path.dirname(path.join(targetDir, relativePath));
  }

  /**
   * Klopft flach an einem Verzeichnis an und wirft, wenn es fehlt.
   *
   * Nötig, weil `watch` einen fehlenden Pfad nicht überall gleich behandelt:
   * Mit `recursive: true` kehrt es unter Linux auch dafür zurück und liefert
   * einen Wächter, der nie etwas meldet — statt ENOENT zu werfen wie unter
   * macOS und Windows (nachgemessen 2026-09-17, Node 24.21 auf Linux). Ein
   * flacher Wächter wirft dagegen überall.
   */
  function probeWatchable(dir) {
    const probe = watch(dir, { recursive: false }, () => {});
    try {
      // Ein 'error' ohne Listener risse den Main-Prozess mit — auch in der
      // kurzen Zeitspanne bis zum close().
      if (typeof probe.on === 'function') probe.on('error', () => {});
      probe.close();
    } catch {
      // Ein Probe-Watcher, der sich nicht schließen lässt, ist kein Grund zur
      // Aufregung: Er hat seine Frage bereits beantwortet.
    }
  }

  /**
   * Öffnet den Wächter am Ziel — rekursiv, wo die Plattform das kann.
   *
   * `recursive: true` ist nicht überall zu haben. Fehlt es, wäre die Antwort
   * „dann eben gar kein Wächter“ die schlechteste von allen: Der Dienst hinge
   * an einer Wiedervorlage, die alle paar Sekunden vergeblich neu aufsetzt.
   * Ein flacher Wächter sieht immerhin die oberste Ebene — und der Empfänger
   * bekommt seine Meldungen, statt taub zu bleiben.
   */
  function openTargetWatcher(dir, handler) {
    try {
      return watch(dir, { recursive: true }, handler);
    } catch (error) {
      if (error?.code !== 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM') throw error;
      onError?.(error, dir);
      return watch(dir, { recursive: false }, handler);
    }
  }

  /**
   * Beobachtet das Ziel **und** seine vorhandenen Vorfahren. Nicht
   * entweder-oder: Das Ziel sieht die Arbeit darin, die Vorfahren sehen das
   * Ziel selbst entstehen und vergehen.
   */
  function watchChain({ dir: targetDir, fallbackLevels: levels }) {
    let dir = targetDir;
    let expectedChild = null;
    for (let level = 0; level <= levels; level += 1) {
      const isTarget = dir === targetDir;
      const childName = expectedChild;
      try {
        // Erst anklopfen: Der rekursive Wächter am Ziel verschweigt einen
        // fehlenden Pfad unter Linux, und die Kette stiege dann nie zum
        // Vorfahren auf, sondern hinge an einer Attrappe.
        if (isTarget) probeWatchable(dir);
        // Unterhalb des Ziels zählt jede Ebene. Ein Wächter darüber wartet nur
        // auf ein einzelnes Pfadstück und bleibt flach.
        const handler = (_eventType, filename) => {
          if (!isTarget) {
            if (!concernsUs(filename, childName)) return;
            // Oberhalb des Ziels kann sich der Pfad geändert haben — neu
            // aufbauen, und was dort geschah, ist keinem Ordner zuzuordnen.
            notifyLater({ rebuild: true });
            return;
          }
          const relativePath = filename == null ? '' : String(filename);
          if (!relativePath) {
            // Ohne Dateinamen bleibt nur die grobe Meldung.
            notifyLater({ rebuild: false });
            return;
          }
          if (ignores && ignores(relativePath, targetDir)) return;
          notifyLater({ rebuild: false, directory: changedDirectory(relativePath, targetDir) });
        };
        const watcher = isTarget
          ? openTargetWatcher(dir, handler)
          : watch(dir, { recursive: false }, handler);
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

  /** Ziele, deren Kette gerade auf einem Vorfahren hängt. */
  function unwatchedTargets() {
    const beobachtet = new Set(slots.filter((slot) => slot.isTarget).map((slot) => slot.dir));
    return targets(currentRoot)
      .map((target) => target.dir)
      .filter((dir) => !beobachtet.has(dir));
  }

  /**
   * Gibt es das Verzeichnis inzwischen? Gefragt wird mit demselben Mittel, an
   * dem es zuvor gescheitert ist — das erspart eine zweite Dateisystem-
   * Abhängigkeit und prüft genau das, worauf es ankommt: nicht nur, ob der
   * Pfad existiert, sondern ob er sich beobachten lässt.
   */
  function targetReachable(dir) {
    try {
      probeWatchable(dir);
      return true;
    } catch {
      return false;
    }
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
      // und melden, damit der Empfänger den inzwischen entstandenen Inhalt
      // sieht.
      build(currentRoot);
      notifyLater({ rebuild: false });
    }, retryMs);
  }

  function build(workspaceRoot) {
    closeSlots();
    currentRoot = workspaceRoot ?? null;
    for (const target of targets(workspaceRoot)) watchChain(target);
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
    pendingDirectories = new Set();
    pendingUnattributed = false;
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
  createDirectoryWatcher,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RETRY_MS,
  DEFAULT_FALLBACK_LEVELS,
};
