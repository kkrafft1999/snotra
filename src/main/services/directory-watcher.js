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
 *
 * The window also swallows changes inside a target that exists (#478). Under
 * file-system load it grows: in the measurement from #465, eight processes
 * churning temp directories made 8 of 10 changes right after `fs.watch()` go
 * unreported. So once the watchers are open and a target is among them, the
 * service reports one more time a moment later, without a cause and with
 * `complete: false`. The receiver then checks everything it shows once, and
 * whatever fell into the window turns up there.
 *
 * Linux is watched folder by folder (#648). There `recursive: true` is not
 * native: Node emulates it in JavaScript, walks the whole tree synchronously
 * and puts an inotify watch on every file and every folder, `node_modules/`
 * included. A file replaced by rename — every atomic write since #75, every
 * editor save, git's `HEAD.lock` → `HEAD` — keeps its watch on the dead inode,
 * and Node never reports that file again; and when the user's watch budget
 * runs out, Node swallows `ENOSPC` and hands back a watcher that misses whole
 * subtrees. A plain watch on a folder has neither problem, because inotify
 * reports a change to a child by its name, whatever happens to the child's
 * inode. `openDirectoryTree` below does that; macOS and Windows keep their
 * native recursive watch.
 */

const { LIMITS } = require('../../shared/limits');

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
 * How long after opening its watchers the service reports once more (#478).
 * In the measurement from #465 a change made one second after `fs.watch()`
 * always arrived, even under load. Two seconds leave room for a busier
 * machine and are still soon enough that nobody sits waiting for the tree.
 */
const DEFAULT_START_RECHECK_MS = 2000;

/**
 * Wie weit dürfen die Wächter aufsteigen, wenn das Ziel nichts anderes sagt?
 * Zwei Ebenen decken `.agents/skills` → `.agents` → Wurzel ab. Weiter nicht:
 * Darüber lägen fremde Verzeichnisse, die uns nichts angehen.
 */
const DEFAULT_FALLBACK_LEVELS = 2;

/** The folder is not there (any more) — expected, not worth a report. */
const MISSING_FOLDER_ERRORS = new Set(['ENOENT', 'ENOTDIR']);

/**
 * Watch errors on a folder below the target that need no report (#648): the
 * folder went again before its watch was set, or it is not ours to read —
 * then the listing cannot show its content either.
 */
const QUIET_FOLDER_WATCH_ERRORS = new Set([...MISSING_FOLDER_ERRORS, 'EACCES', 'EPERM']);

/**
 * The kernel has no watch left to give (#648): `ENOSPC` is inotify's
 * `max_user_watches`, the others are file descriptors and memory. The next
 * folder would only fail the same way.
 */
const EXHAUSTED_WATCH_ERRORS = new Set(['ENOSPC', 'EMFILE', 'ENFILE', 'ENOMEM']);

/** What a target reports once it holds `maxWatchedDirectories` folders (#648). */
const WATCH_LIMIT_ERROR_CODE = 'WATCH_DIRECTORY_LIMIT';

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
 * @param {(error: Error, dir: string) => void} [options.onError] A watch that
 *   failed, with the folder it failed on.
 * @param {string} [options.platform] `process.platform` unless a test says
 *   otherwise. On `'linux'` a target is watched folder by folder instead of
 *   with `recursive: true` (#648).
 * @param {{ readdir: Function, lstat: Function }} [options.fs] `fs/promises`
 *   unless given — only the folder-by-folder watch lists and checks folders.
 * @param {(relativeDir: string, targetDir: string) => 'recursive'|'flat'|'skip'} [options.folderPolicy]
 *   Folder by folder only: whether a folder below the target is watched with
 *   its subfolders (the default), on its own (`'flat'`), or not at all, and
 *   nothing below it either (`'skip'`).
 * @param {number} [options.maxWatchedDirectories] Folder by folder only: how
 *   many folders one target may hold a watch on.
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
  startRecheckMs = DEFAULT_START_RECHECK_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
  onError = null,
  platform = process.platform,
  fs = null,
  folderPolicy = null,
  maxWatchedDirectories = LIMITS.MAX_WATCHED_DIRECTORIES,
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
  /** The one report a moment after the watchers were opened (#478). */
  let startRecheckTimer = null;
  let closed = false;
  /** Each folder gets a watch of its own instead of `recursive: true` (#648). */
  const watchesByFolder = platform === 'linux';

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

  function closeQuietly(watcher) {
    try {
      watcher.close();
    } catch {
      // Ein bereits geschlossener Watcher ist kein Fehler.
    }
  }

  function closeSlots() {
    for (const slot of slots) closeQuietly(slot.watcher);
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
   * Watches a target folder by folder — the Linux way (#648, see the top of
   * this file for why).
   *
   * Every folder gets one plain watch. When a folder reports a name that was
   * renamed — created, removed or moved —, the name is checked: a folder there
   * gets a watch, and its content is reported, because it may have filled up
   * before the watch was set; a folder that is gone loses its watch and those
   * of everything below it. `folderPolicy` keeps the walk out of folders whose
   * content nobody wants. The walk runs asynchronously and breadth first, so
   * the top levels — what the tree shows first — are watched before the cap
   * can bite. Reaching the cap, or the kernel's own limit, is said through
   * `onError` and reported as `complete: false`: the receiver reloads
   * coarsely instead of quietly missing a subtree.
   *
   * Returns something shaped like an `fs.watch` watcher: `on('error')` reaches
   * the watch on the target itself, `close()` ends all of them.
   */
  function openDirectoryTree(rootDir, handler) {
    const fsApi = fs ?? require('fs').promises;
    /** Watched folders by absolute path: `{ watcher, recursive }`. */
    const folders = new Map();
    /** Folders still to be listed, breadth first. */
    const queue = [];
    let walking = false;
    /** Names being checked after a rename, and whether another one came in meanwhile. */
    const checking = new Map();
    /** The cap or the kernel's limit was reached — no further folder is watched. */
    let full = false;
    let treeClosed = false;

    const reportIncomplete = () => notifyLater({ rebuild: false });

    function joinRelative(relDir, name) {
      return relDir ? path.join(relDir, name) : name;
    }

    function stopGrowing(error, dir) {
      if (!full) {
        full = true;
        onError?.(error, dir);
      }
      queue.length = 0;
      reportIncomplete();
    }

    /** Drops the watch on a folder and on everything below it. */
    function dropFolder(absDir) {
      const prefix = absDir.endsWith(path.sep) ? absDir : `${absDir}${path.sep}`;
      for (const [dir, entry] of folders) {
        if (dir !== absDir && !dir.startsWith(prefix)) continue;
        closeQuietly(entry.watcher);
        folders.delete(dir);
      }
    }

    function onFolderEvent(absDir, relDir, entry, eventType, filename) {
      if (treeClosed || folders.get(absDir) !== entry) return;
      const name = filename == null ? '' : String(filename);
      if (!name) {
        handler(eventType, null);
        return;
      }
      const relPath = joinRelative(relDir, name);
      handler(eventType, relPath);
      // Only a rename can turn a name into a folder or a folder into nothing;
      // a change to a folder's content arrives at the folder's own watch.
      if (eventType === 'rename' && entry.recursive) checkName(path.join(absDir, name), relPath);
    }

    function addFolder(absDir, relDir, announce) {
      if (treeClosed || folders.has(absDir)) return;
      const policy = typeof folderPolicy === 'function' ? folderPolicy(relDir, rootDir) : 'recursive';
      if (policy === 'skip') return;
      if (full) {
        reportIncomplete();
        return;
      }
      if (folders.size >= maxWatchedDirectories) {
        const error = new Error(`Not watching more than ${maxWatchedDirectories} folders below ${rootDir}.`);
        error.code = WATCH_LIMIT_ERROR_CODE;
        stopGrowing(error, absDir);
        return;
      }
      const entry = { watcher: null, recursive: policy !== 'flat' };
      try {
        entry.watcher = watch(absDir, { recursive: false }, (eventType, filename) =>
          onFolderEvent(absDir, relDir, entry, eventType, filename));
      } catch (error) {
        if (QUIET_FOLDER_WATCH_ERRORS.has(error?.code)) return;
        if (EXHAUSTED_WATCH_ERRORS.has(error?.code)) {
          stopGrowing(error, absDir);
          return;
        }
        onError?.(error, absDir);
        reportIncomplete();
        return;
      }
      if (typeof entry.watcher.on === 'function') {
        entry.watcher.on('error', (error) => {
          if (treeClosed || folders.get(absDir) !== entry) return;
          onError?.(error, absDir);
          dropFolder(absDir);
          reportIncomplete();
        });
      }
      folders.set(absDir, entry);
      // A flat folder is listed too when it is new: `git init` may have
      // written `.git/HEAD` before the watch on `.git` was set.
      if (entry.recursive || announce) enqueue(absDir, relDir, announce);
    }

    /**
     * A renamed name below a watched folder: watch it if it is a folder now,
     * drop its watch if it was one. One check per name at a time, and one more
     * when another rename came in meanwhile — so the last check sees the last
     * state, however the `lstat` calls overtake each other.
     */
    function checkName(absPath, relPath) {
      const running = checking.get(absPath);
      if (running) {
        running.again = true;
        return;
      }
      const state = { again: true };
      checking.set(absPath, state);
      (async () => {
        try {
          while (state.again && !treeClosed) {
            state.again = false;
            let stats = null;
            try {
              stats = await fsApi.lstat(absPath);
            } catch {
              stats = null;
            }
            if (treeClosed) return;
            // A rename on a folder's name means it was created, removed or
            // moved: what is watched under that name may be another folder by
            // now, or none.
            if (folders.has(absPath)) dropFolder(absPath);
            if (stats?.isDirectory()) addFolder(absPath, relPath, true);
          }
        } finally {
          checking.delete(absPath);
        }
      })().catch((error) => onError?.(error, absPath));
    }

    function enqueue(absDir, relDir, announce) {
      queue.push({ absDir, relDir, announce });
      if (walking) return;
      walking = true;
      walk().catch((error) => onError?.(error, rootDir));
    }

    async function walk() {
      try {
        while (queue.length > 0 && !treeClosed) {
          const { absDir, relDir, announce } = queue.shift();
          const entry = folders.get(absDir);
          if (!entry) continue;
          let dirents;
          try {
            dirents = await fsApi.readdir(absDir, { withFileTypes: true });
          } catch {
            // Gone meanwhile; its parent reports that.
            continue;
          }
          // Dropped or replaced while it was being read: the new one has its
          // own place in the queue.
          if (treeClosed || folders.get(absDir) !== entry) continue;
          for (const dirent of dirents) {
            const relPath = joinRelative(relDir, dirent.name);
            // Content that arrived before the watch did.
            if (announce) handler('rename', relPath);
            // `isDirectory()` is false for a symbolic link: a link is not
            // followed, neither out of the target nor round in a circle.
            if (entry.recursive && dirent.isDirectory()) {
              addFolder(path.join(absDir, dirent.name), relPath, announce);
            }
            if (treeClosed) return;
          }
        }
      } finally {
        // Set before anything else can run, so a folder enqueued right after
        // the last one starts a new walk.
        walking = false;
      }
    }

    // The target itself is watched right away: a missing one throws here, as
    // `fs.watch` does everywhere, and the chain climbs to its ancestor.
    const rootEntry = { watcher: null, recursive: true };
    rootEntry.watcher = watch(rootDir, { recursive: false }, (eventType, filename) =>
      onFolderEvent(rootDir, '', rootEntry, eventType, filename));
    folders.set(rootDir, rootEntry);
    enqueue(rootDir, '', false);

    return {
      on(event, listener) {
        if (typeof rootEntry.watcher.on === 'function') rootEntry.watcher.on(event, listener);
        return this;
      },
      close() {
        treeClosed = true;
        queue.length = 0;
        for (const entry of folders.values()) closeQuietly(entry.watcher);
        folders.clear();
      },
    };
  }

  /**
   * Öffnet den Wächter am Ziel — rekursiv, wo die Plattform das kann.
   *
   * `recursive: true` ist nicht überall zu haben. Fehlt es, wäre die Antwort
   * „dann eben gar kein Wächter“ die schlechteste von allen: Der Dienst hinge
   * an einer Wiedervorlage, die alle paar Sekunden vergeblich neu aufsetzt.
   * Ein flacher Wächter sieht immerhin die oberste Ebene — und der Empfänger
   * bekommt seine Meldungen, statt taub zu bleiben.
   *
   * On Linux the recursive watch is Node's emulation, and the target is
   * watched folder by folder instead (#648).
   */
  function openTargetWatcher(dir, handler) {
    if (watchesByFolder) return openDirectoryTree(dir, handler);
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
          // `dir` has moved on to the parent by the time an error arrives;
          // the report names the folder this watch is on (#648).
          const watchedDir = dir;
          watcher.on('error', (error) => {
            onError?.(error, watchedDir);
            notifyLater({ rebuild: true });
          });
        }
        slots.push({ watcher, dir, isTarget });
      } catch (error) {
        // A missing folder is what the chain is for, not a failure: it climbs
        // to the ancestor. Said only since `onError` reaches the log (#648).
        if (!MISSING_FOLDER_ERRORS.has(error?.code)) onError?.(error, dir);
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

  /**
   * One report without a cause, a moment after the watchers were opened
   * (#478): `complete: false` makes the receiver check everything it shows,
   * which catches what fell into the start window. Only a watched target
   * needs it. While a chain hangs on an ancestor, the retry above is already
   * looking for the target and reports once it is there.
   */
  function scheduleStartRecheck() {
    if (startRecheckTimer) {
      clearTimeoutImpl(startRecheckTimer);
      startRecheckTimer = null;
    }
    if (closed || !startRecheckMs || !slots.some((slot) => slot.isTarget)) return;

    startRecheckTimer = setTimeoutImpl(() => {
      startRecheckTimer = null;
      if (!closed) notifyLater({ rebuild: false });
    }, startRecheckMs);
  }

  function build(workspaceRoot) {
    closeSlots();
    currentRoot = workspaceRoot ?? null;
    for (const target of targets(workspaceRoot)) watchChain(target);
    scheduleRetry();
    scheduleStartRecheck();
  }

  /**
   * Auf einen Workspace umschalten (`null` = keiner offen). Alte Watcher
   * werden dabei geschlossen — sonst bliebe bei jedem Ordnerwechsel ein
   * Handle zurück.
   */
  function watchWorkspace(workspaceRoot) {
    if (closed) return;
    // What was still waiting to be reported belongs to the folder just left;
    // reported after the switch, it would name folders of the old one (#650).
    // Here and not in `build()`, which the debounce and the retry call too.
    if ((workspaceRoot ?? null) !== currentRoot) dropPending();
    build(workspaceRoot);
  }

  /** Forgets every event not reported yet. */
  function dropPending() {
    if (debounceTimer) {
      clearTimeoutImpl(debounceTimer);
      debounceTimer = null;
    }
    pendingSince = null;
    pendingRebuild = false;
    pendingDirectories = new Set();
    pendingUnattributed = false;
  }

  /** Alles abräumen; danach ist der Dienst endgültig aus. */
  function close() {
    closed = true;
    dropPending();
    if (retryTimer) {
      clearTimeoutImpl(retryTimer);
      retryTimer = null;
    }
    if (startRecheckTimer) {
      clearTimeoutImpl(startRecheckTimer);
      startRecheckTimer = null;
    }
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
  DEFAULT_START_RECHECK_MS,
  DEFAULT_FALLBACK_LEVELS,
  WATCH_LIMIT_ERROR_CODE,
};
