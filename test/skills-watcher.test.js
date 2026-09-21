const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');
const {
  createSkillsWatcher,
  MAX_FALLBACK_LEVELS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RETRY_MS,
} = require('../src/main/services/skills-watcher');

/**
 * Die Tests mit Ersatz-Watcher rechnen bewusst in POSIX-Pfaden: Geprüft wird
 * die Logik, nicht die Pfadsyntax der Plattform. Mit dem echten `path` würde
 * unter Windows schon `path.resolve` dazwischenfunken und einen
 * Laufwerksbuchstaben ergänzen, den die Erwartungen hier nicht kennen. Wie
 * sich das Ganze auf der jeweiligen Plattform wirklich verhält, prüfen die
 * beiden Läufe gegen das echte Dateisystem am Ende der Datei.
 */
const path = nodePath.posix;

const HOME = path.join(path.sep, 'home', 'nutzer');
const WS = path.join(path.sep, 'projekte', 'demo');
const WS_SKILLS = path.join(WS, '.agents', 'skills');
const HOME_SNOTRA_SKILLS = path.join(HOME, '.snotra', 'skills');
const HOME_SKILLS = path.join(HOME, '.agents', 'skills');
const os = { homedir: () => HOME };

/**
 * Ein `fs.watch`-Ersatz, der über `missing` steuert, welche Verzeichnisse es
 * (noch) nicht gibt — genau der Fall, um den herum der Dienst gebaut ist.
 *
 * `aktiv(dir)` liefert den lebenden Wächter auf einem Pfad. Nötig, weil der
 * Dienst vor dem rekursiven Wächter am Ziel flach anklopft: Dieser
 * Probe-Wächter steht ebenfalls in `created`, ist aber längst geschlossen.
 */
function createFakeWatch(missing = []) {
  const absent = new Set(missing);
  const created = [];
  function watch(dir, options, handler) {
    if (absent.has(dir)) {
      const error = new Error(`ENOENT: ${dir}`);
      error.code = 'ENOENT';
      throw error;
    }
    const watcher = {
      dir,
      options,
      handler,
      closed: false,
      listeners: {},
      on(event, callback) {
        this.listeners[event] = callback;
        return this;
      },
      close() {
        this.closed = true;
      },
    };
    created.push(watcher);
    return watcher;
  }
  return {
    watch,
    created,
    appear: (dir) => absent.delete(dir),
    absent,
    aktiv: (dir) => created.filter((w) => w.dir === dir && !w.closed).at(-1) ?? null,
  };
}

/**
 * Eine mitgesteuerte Uhr — so lässt sich das Höchstfenster prüfen, ohne
 * wirklich zu warten. Es können zwei Timer zugleich anstehen: das Entprellen
 * und die Wiedervorlage aus #155. `tick()` nimmt den, der als Nächstes
 * fällig wäre; `advance()` lässt die Uhr laufen, ohne etwas auszulösen.
 */
function createFakeClock() {
  let timers = [];
  let nextId = 0;
  let now = 1_000_000;
  const naechster = () =>
    timers.reduce((frueh, t) => (frueh === null || t.faellig < frueh.faellig ? t : frueh), null);
  return {
    setTimeoutImpl: (fn, ms = 0) => {
      const timer = { fn, id: (nextId += 1), faellig: now + ms };
      timers.push(timer);
      return timer.id;
    },
    clearTimeoutImpl: (handle) => {
      timers = timers.filter((t) => t.id !== handle);
    },
    nowImpl: () => now,
    advance(ms) {
      now += ms;
    },
    get pendingId() {
      return naechster()?.id ?? null;
    },
    get hasPending() {
      return timers.length > 0;
    },
    /** Führt den nächstfälligen Timer aus (Entprellen vor Wiedervorlage). */
    tick() {
      const due = naechster();
      if (!due) return;
      timers = timers.filter((t) => t.id !== due.id);
      due.fn();
    },
  };
}

function setup({ missing = [], onChange, retryMs } = {}) {
  const fake = createFakeWatch(missing);
  const clock = createFakeClock();
  const changes = [];
  const watcher = createSkillsWatcher({
    watch: fake.watch,
    path,
    os,
    onChange: onChange || (() => changes.push(clock.nowImpl())),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    nowImpl: clock.nowImpl,
    ...(retryMs === undefined ? {} : { retryMs }),
  });
  return { fake, clock, changes, watcher };
}

test('beobachtet jede Ordner-Quelle samt ihrer Vorfahren, die System-Skills nicht', () => {
  const { fake, watcher } = setup();
  watcher.watchWorkspace(WS);
  assert.deepEqual(watcher.watchedDirectories(), [
    { dir: WS_SKILLS, isTarget: true },
    { dir: path.join(WS, '.agents'), isTarget: false },
    { dir: WS, isTarget: false },
    { dir: HOME_SNOTRA_SKILLS, isTarget: true },
    { dir: path.join(HOME, '.snotra'), isTarget: false },
    { dir: HOME, isTarget: false },
    { dir: HOME_SKILLS, isTarget: true },
    { dir: path.join(HOME, '.agents'), isTarget: false },
    { dir: HOME, isTarget: false },
  ]);
  // Unterordner zählen nur beim Ziel — die SKILL.md liegt eine Ebene tiefer.
  assert.equal(fake.aktiv(WS_SKILLS).options.recursive, true);
  assert.equal(fake.aktiv(path.join(WS, '.agents')).options.recursive, false);
  watcher.close();
});

test('ohne offenen Ordner bleiben die Home-Quellen beobachtet', () => {
  const { watcher } = setup();
  watcher.watchWorkspace(null);
  assert.deepEqual(
    watcher.watchedDirectories().map((w) => w.dir),
    [
      HOME_SNOTRA_SKILLS,
      path.join(HOME, '.snotra'),
      HOME,
      HOME_SKILLS,
      path.join(HOME, '.agents'),
      HOME,
    ]
  );
  watcher.close();
});

// Issue #251: Der neue Standardort ist meistens noch gar nicht da — der
// Aufstieg `~/.snotra/skills` → `~/.snotra` → `~` muss ihn trotzdem einfangen.
test('ein fehlendes ~/.snotra/skills hängt die Kette an das Home-Verzeichnis', () => {
  const { fake, clock, changes, watcher } = setup({
    missing: [HOME_SNOTRA_SKILLS, path.join(HOME, '.snotra')],
  });
  watcher.watchWorkspace(null);
  assert.deepEqual(watcher.watchedDirectories()[0], { dir: HOME, isTarget: false });
  assert.equal(watcher.retryPending(), true, 'die Wiedervorlage wartet auf das Verzeichnis');

  // Jetzt legt der Nutzer ~/.snotra/skills an. Das Ereignis dafür kommt auf
  // dem Home-Wächter der anderen Kette an und geht dort verloren — die
  // Wiedervorlage holt den Umbau trotzdem nach.
  fake.appear(HOME_SNOTRA_SKILLS);
  fake.appear(path.join(HOME, '.snotra'));
  clock.tick(); // Wiedervorlage
  clock.tick(); // entprellte Meldung

  assert.equal(changes.length, 1, 'Änderung gemeldet');
  assert.deepEqual(watcher.watchedDirectories()[0], { dir: HOME_SNOTRA_SKILLS, isTarget: true });
  assert.equal(watcher.retryPending(), false, 'und die Wiedervorlage ist beendet');
  watcher.close();
});

test('eine neue SKILL.md unter ~/.snotra/skills wird gemeldet', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  fake.aktiv(HOME_SNOTRA_SKILLS).handler('rename', 'frisch/SKILL.md');
  clock.tick();
  assert.equal(changes.length, 1);
  watcher.close();
});

test('ein fehlendes Verzeichnis lässt die vorhandenen Vorfahren beobachten', () => {
  const { fake, watcher } = setup({ missing: [WS_SKILLS, path.join(WS, '.agents')] });
  watcher.watchWorkspace(WS);
  const watched = watcher.watchedDirectories();
  assert.deepEqual(watched[0], { dir: WS, isTarget: false }, 'zwei Ebenen hoch bis zum Workspace');
  assert.equal(fake.aktiv(WS).options.recursive, false, 'ein Wächter bleibt flach');
  assert.deepEqual(watched[1], { dir: HOME_SNOTRA_SKILLS, isTarget: true }, 'Home ist davon unberührt');
  watcher.close();
});

test('ein Wächter über dem Ziel reagiert nur auf das Pfadstück, auf das er wartet', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  const wsWatcher = fake.aktiv(WS);

  // Ein belebtes Projektverzeichnis darf keine Skill-Scans auslösen.
  wsWatcher.handler('rename', 'build');
  wsWatcher.handler('change', 'README.md');
  assert.equal(clock.hasPending, false, 'fremde Dateien lösen nichts aus');

  wsWatcher.handler('rename', '.agents');
  clock.tick();
  assert.equal(changes.length, 1, 'das erwartete Pfadstück dagegen schon');

  // Ohne Dateinamen (nicht jede Plattform liefert ihn) lieber einmal zu viel.
  wsWatcher.handler('rename', null);
  clock.tick();
  assert.equal(changes.length, 2);
  watcher.close();
});

test('gibt es auch den Vorfahren nicht, bleibt die Quelle einfach unbeobachtet', () => {
  const { watcher } = setup({
    missing: [
      WS_SKILLS,
      path.join(WS, '.agents'),
      WS,
      HOME_SNOTRA_SKILLS,
      path.join(HOME, '.snotra'),
      HOME_SKILLS,
      path.join(HOME, '.agents'),
      HOME,
    ],
  });
  watcher.watchWorkspace(WS);
  assert.deepEqual(watcher.watchedDirectories(), [], 'kein Absturz, nur kein Watcher');
  watcher.close();
});

test('viele Ereignisse münden in eine einzige Meldung', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  const ziel = fake.aktiv(WS_SKILLS);
  for (let i = 0; i < 20; i += 1) ziel.handler('rename', `skill-${i}/SKILL.md`);
  assert.deepEqual(changes, [], 'noch nichts gemeldet');
  clock.tick();
  assert.equal(changes.length, 1, 'genau einmal');
  watcher.close();
});

test('eine ununterbrochene Ereignis-Flut verhindert die Meldung nicht', () => {
  // Unter Windows feuert ein Watcher nach dem Entfernen seines Verzeichnisses
  // endlos weiter. Würde jedes Ereignis das Zeitfenster verlängern, käme es
  // nie zu einer Meldung — genau daran scheiterte der Löschfall dort.
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  const ziel = fake.aktiv(WS_SKILLS);

  let verschobene = 0;
  for (let i = 0; i < 200; i += 1) {
    const vorher = clock.pendingId;
    ziel.handler('rename', `flut-${i}`);
    if (clock.pendingId !== vorher) verschobene += 1;
    clock.advance(20); // schneller als das Höchstfenster von 1000 ms
  }

  assert.ok(clock.hasPending, 'ein Timer steht noch an');
  assert.ok(verschobene < 200, `der Timer wurde nicht endlos verschoben (${verschobene}×)`);
  clock.tick();
  assert.equal(changes.length, 1, 'die Meldung kommt');
  watcher.close();
});

test('ein nötiger Neuaufbau geht durch spätere Ereignisse nicht verloren', () => {
  // Die Reihenfolge aus dem Windows-Lauf: Erst meldet der Wächter über dem
  // Ziel das Verschwinden (Neuaufbau nötig), danach trudeln Ereignisse des
  // toten Ziel-Watchers ein, die für sich genommen keinen bräuchten.
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  const wurzel = fake.aktiv(WS);
  const ziel = fake.aktiv(WS_SKILLS);

  fake.absent.add(WS_SKILLS);
  fake.absent.add(path.join(WS, '.agents'));
  wurzel.handler('change', '.agents');
  ziel.handler('rename', 'demo');
  ziel.handler('rename', 'demo');
  clock.tick();

  assert.equal(changes.length, 1);
  assert.deepEqual(
    watcher.watchedDirectories()[0],
    { dir: WS, isTarget: false },
    'die Kette wurde neu aufgebaut und hängt nicht am toten Verzeichnis'
  );
  watcher.close();
});

test('ein später angelegtes Verzeichnis wird erkannt und dann direkt beobachtet', () => {
  const { fake, clock, changes, watcher } = setup({
    missing: [WS_SKILLS, path.join(WS, '.agents')],
  });
  watcher.watchWorkspace(WS);
  assert.equal(watcher.watchedDirectories()[0].isTarget, false, 'zunächst nur der Vorfahre');

  // Der Nutzer legt .agents/skills an: Der Ersatz-Watcher meldet sich, und
  // danach muss der Dienst am echten Ziel hängen.
  fake.appear(WS_SKILLS);
  fake.appear(path.join(WS, '.agents'));
  fake.aktiv(WS).handler('rename', '.agents');
  clock.tick();

  assert.equal(changes.length, 1, 'Änderung gemeldet');
  assert.deepEqual(watcher.watchedDirectories()[0], { dir: WS_SKILLS, isTarget: true });
  watcher.close();
});

test('ein Fehler des Watchers stürzt nicht ab, sondern baut neu auf', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  const first = fake.aktiv(WS_SKILLS);
  assert.equal(typeof first.listeners.error, 'function', 'Fehler werden behandelt');

  // Verschwindet das Verzeichnis, meldet Node einen Fehler statt eines
  // Ereignisses — unbehandelt wäre das ein Absturz des Main-Prozesses.
  fake.absent.add(WS_SKILLS);
  first.listeners.error(new Error('EPERM'));
  clock.tick();

  assert.equal(changes.length, 1);
  assert.equal(first.closed, true, 'der kaputte Watcher ist zu');
  assert.equal(watcher.watchedDirectories()[0].isTarget, false, 'zurück auf den Vorfahren');
  watcher.close();
});

test('ein Workspace-Wechsel lässt keine Handles zurück', () => {
  const { fake, watcher } = setup();
  watcher.watchWorkspace(WS);
  const alte = [...fake.created];
  const anderer = path.join(path.sep, 'projekte', 'anderes');

  watcher.watchWorkspace(anderer);
  assert.ok(alte.every((w) => w.closed), 'alle alten Watcher geschlossen');
  assert.deepEqual(
    watcher.watchedDirectories().filter((w) => w.isTarget).map((w) => w.dir),
    [path.join(anderer, '.agents', 'skills'), HOME_SNOTRA_SKILLS, HOME_SKILLS]
  );
  watcher.close();
});

test('close räumt alles ab und schluckt noch laufende Ereignisse', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  const ziel = fake.aktiv(WS_SKILLS);
  ziel.handler('change', 'SKILL.md');
  assert.ok(clock.hasPending, 'eine Meldung steht an');

  watcher.close();
  assert.ok(fake.created.every((w) => w.closed));
  assert.equal(clock.hasPending, false, 'der Timer ist abgeräumt');
  assert.deepEqual(watcher.watchedDirectories(), []);

  // Auch ein Ereignis, das den Weg noch findet, meldet nach close nichts mehr.
  ziel.handler('change', 'SKILL.md');
  clock.tick();
  assert.deepEqual(changes, []);
});

test('liegt der Workspace im Home, wird dieselbe Quelle nicht doppelt beobachtet', () => {
  const { watcher } = setup();
  watcher.watchWorkspace(HOME);
  const ziele = watcher.watchedDirectories().filter((w) => w.isTarget).map((w) => w.dir);
  assert.deepEqual(ziele, [HOME_SKILLS, HOME_SNOTRA_SKILLS], 'jedes Ziel nur einmal');
  watcher.close();
});

// ── Wiedervorlage, solange das Ziel fehlt (Issue #155) ─────────────────────

test('steht das Ziel, läuft keine Wiedervorlage', () => {
  const { watcher } = setup();
  watcher.watchWorkspace(WS);
  assert.equal(watcher.retryPending(), false, 'kein Dauertimer im Normalfall');
  watcher.close();
});

test('ein verlorenes Ereignis auf dem Vorfahren macht nicht dauerhaft taub', () => {
  // Der Kern von #155: Die Kette hängt auf der Wurzel, das Verzeichnis
  // entsteht — und das eine Ereignis, das den Umbau auslösen würde, kommt nie
  // an. Ohne Wiedervorlage bliebe der Dienst für immer still, denn ein
  // Vorfahren-Wächter ist flach und hört nur auf sein Pfadstück.
  const { fake, clock, changes, watcher } = setup({
    missing: [WS_SKILLS, path.join(WS, '.agents')],
  });
  watcher.watchWorkspace(WS);
  assert.equal(watcher.watchedDirectories()[0].isTarget, false, 'zunächst nur der Vorfahre');
  assert.equal(watcher.retryPending(), true, 'die Wiedervorlage steht');

  // Verzeichnis angelegt — ohne jedes Ereignis an den Wächter.
  fake.appear(WS_SKILLS);
  fake.appear(path.join(WS, '.agents'));
  clock.tick(); // Wiedervorlage

  assert.deepEqual(
    watcher.watchedDirectories()[0],
    { dir: WS_SKILLS, isTarget: true },
    'die Kette hängt jetzt am Ziel'
  );
  clock.tick(); // die Meldung ist entprellt
  assert.equal(changes.length, 1, 'die Änderung wurde gemeldet');
  assert.equal(watcher.retryPending(), false, 'und die Wiedervorlage ist am Ziel beendet');
  watcher.close();
});

test('die Wiedervorlage hält durch und ein belebter Ordner löst nichts aus', () => {
  const { fake, clock, changes, watcher } = setup({
    missing: [WS_SKILLS, path.join(WS, '.agents')],
  });
  watcher.watchWorkspace(WS);
  const wurzel = fake.aktiv(WS);

  for (let runde = 0; runde < 3; runde += 1) {
    // Zwischendurch arbeitet jemand im Projekt — das geht die Skills nichts an.
    wurzel.handler('change', 'README.md');
    wurzel.handler('rename', `build/artefakt-${runde}`);
    clock.tick(); // Wiedervorlage; das Ziel fehlt weiterhin
    assert.equal(watcher.retryPending(), true, 'sie setzt sich selbst neu auf');
  }
  assert.deepEqual(changes, [], 'kein einziger Skill-Scan');
  assert.equal(watcher.watchedDirectories()[0].isTarget, false);

  fake.appear(WS_SKILLS);
  fake.appear(path.join(WS, '.agents'));
  clock.tick();
  clock.tick();
  assert.equal(changes.length, 1, 'erst das Verzeichnis selbst löst aus');
  watcher.close();
});

test('close beendet auch die Wiedervorlage', () => {
  const { clock, watcher } = setup({ missing: [WS_SKILLS, path.join(WS, '.agents')] });
  watcher.watchWorkspace(WS);
  assert.equal(watcher.retryPending(), true);
  watcher.close();
  assert.equal(watcher.retryPending(), false);
  assert.equal(clock.hasPending, false, 'kein Timer bleibt zurück');
});

test('ein rekursiver Wächter, der ENOENT verschweigt, wird nicht für das Ziel gehalten', () => {
  // Unter Linux kehrt `watch(..., { recursive: true })` auch für einen
  // fehlenden Pfad zurück und liefert einen Wächter, der nie etwas meldet
  // (nachgemessen 2026-09-17, Node 24.21). Hinge die Kette an dieser
  // Attrappe, wäre sie blind und die Wiedervorlage sähe ihr Ziel als
  // erreicht an.
  const fake = createFakeWatch([WS_SKILLS, path.join(WS, '.agents')]);
  const clock = createFakeClock();
  const linuxWatch = (dir, optionen, handler) => {
    if (optionen?.recursive && fake.absent.has(dir)) {
      return { dir, options: optionen, handler: () => {}, closed: false, on() { return this; }, close() { this.closed = true; } };
    }
    return fake.watch(dir, optionen, handler);
  };
  const watcher = createSkillsWatcher({
    watch: linuxWatch,
    path,
    os,
    onChange: () => {},
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    nowImpl: clock.nowImpl,
  });

  watcher.watchWorkspace(WS);
  assert.deepEqual(
    watcher.watchedDirectories()[0],
    { dir: WS, isTarget: false },
    'die Kette steigt zum Vorfahren auf, statt an der Attrappe zu hängen'
  );
  assert.equal(watcher.retryPending(), true, 'und die Wiedervorlage läuft');
  watcher.close();
});

test('der Abstand der Wiedervorlage ist ein paar Sekunden', () => {
  assert.equal(DEFAULT_RETRY_MS, 3000);
});

test('der Aufstieg endet an der Workspace- bzw. Home-Wurzel', () => {
  assert.equal(MAX_FALLBACK_LEVELS, 2, '.agents/skills → .agents → Wurzel');
});

// ── Ein Lauf gegen das echte Dateisystem ───────────────────────────────────
// Die Tests oben prüfen die Logik gegen einen Ersatz für `fs.watch`. Dieser
// hier belegt, dass die gewählten Optionen auch wirklich anschlagen — sonst
// wäre die ganze Konstruktion an der Wirklichkeit vorbei gebaut.

const fsPromises = require('fs/promises');
const { watch } = require('fs');
const nodeOs = require('os');
// Ab hier gilt wieder die Pfadsyntax der laufenden Plattform.
const realPath = nodePath;

// Unter Windows ist TEMP oft ein 8.3-Kurzname (C:\Users\RUNNER~1\...), und
// fs.watch meldet Pfade dann in der Langform. Einmal auflösen, damit Anlegen
// und Beobachten denselben Pfad meinen.
async function makeTempRoot(prefix) {
  const dir = await fsPromises.mkdtemp(realPath.join(nodeOs.tmpdir(), prefix));
  return fsPromises.realpath(dir);
}

// Stürzt der Prozess hier ab, meldet node:test nur ein nacktes „test failed“
// für die ganze Datei. Diese beiden Zeilen machen die Ursache sichtbar.
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT in skills-watcher.test.js:', error);
  process.exit(1);
});
process.on('unhandledRejection', (error) => {
  console.error('UNHANDLED REJECTION in skills-watcher.test.js:', error);
  process.exit(1);
});

/**
 * Ein Zähler, auf dessen nächsten Ausschlag man warten kann, statt zu pollen.
 */
function createMeldungssignal() {
  let zaehler = 0;
  let wecker = null;
  return {
    melden() {
      zaehler += 1;
      const w = wecker;
      wecker = null;
      w?.();
    },
    zuruecksetzen() {
      zaehler = 0;
    },
    /** Wartet auf die nächste Meldung; `false`, wenn binnen `ms` keine kam. */
    warten(ms) {
      if (zaehler > 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          wecker = null;
          resolve(false);
        }, ms);
        wecker = () => {
          clearTimeout(timer);
          resolve(true);
        };
      });
    },
  };
}

/**
 * Löst `ausloesen` aus und wartet auf die Meldung — notfalls mehrmals.
 *
 * Der Grund für die Wiederholung (Issue #151): `fs.watch` meldet entweder
 * binnen Millisekunden oder überhaupt nicht mehr. Gemessen am 2026-09-16 über
 * sechs volle Suite-Läufe lag die grüne Meldung stabil bei ~110 ms, während
 * der seltene Fehlschlag die vollen 10 s verstreichen ließ — die Verteilung
 * ist also zweigipflig, nicht langschwänzig. Dahinter steckt das Startfenster
 * des Watchers: `fs.watch()` kehrt zurück, bevor der FSEvents-Stream wirklich
 * läuft, und was in dieses Fenster fällt, ist verloren. Ein größeres
 * Zeitbudget hilft dagegen nicht, eine zweite Änderung schon.
 *
 * `vorbereiten` stellt den Ausgangszustand her und dient zugleich als
 * Lebendprobe: Bleibt schon dessen Echo aus, ist der Watcher noch nicht
 * scharf und der Versuch wird verworfen, statt `ausloesen` zu verheizen.
 *
 * Das Wartefenster richtet sich nach dem Höchstfenster des Dienstes, nicht
 * nach einem geschätzten Wert: Unter Windows feuert ein Watcher nach dem
 * Entfernen seines Verzeichnisses endlos weiter, und genau dagegen hält der
 * Dienst die Meldung bis zu `DEFAULT_MAX_WAIT_MS` zurück. Ein kürzeres
 * Fenster kann dort grundsätzlich nicht aufgehen — nachgestellt am
 * 2026-09-16 mit einer Flut-Attrappe: erste Meldung nach 1060 ms bei einem
 * Höchstfenster von 1000 ms. Der Faktor zwei lässt Luft für einen belasteten
 * Runner und wandert mit, falls die Konstante sich ändert.
 */
async function bisMeldung({
  signal,
  vorbereiten = null,
  ausloesen,
  versuche = 5,
  fensterMs = DEFAULT_MAX_WAIT_MS * 2,
}) {
  for (let versuch = 0; versuch < versuche; versuch += 1) {
    if (vorbereiten) {
      await vorbereiten(versuch);
      if (!(await signal.warten(fensterMs))) continue;
    }
    signal.zuruecksetzen();
    await ausloesen(versuch);
    if (await signal.warten(fensterMs)) return true;
  }
  return false;
}

test('meldet eine echte neue SKILL.md im Unterordner', async () => {
  const root = await makeTempRoot('snotra-watch-');
  const skillsDir = realPath.join(root, '.agents', 'skills');
  await fsPromises.mkdir(skillsDir, { recursive: true });

  const signal = createMeldungssignal();
  const watcher = createSkillsWatcher({
    watch,
    path: realPath,
    os: { homedir: () => realPath.join(root, '__kein-home__') },
    onChange: () => signal.melden(),
    debounceMs: 50,
  });

  try {
    watcher.watchWorkspace(root);
    // Jeder Versuch legt einen eigenen Skill an — ein verlorener erster
    // Anlauf wird so vom zweiten eingeholt.
    const gemeldet = await bisMeldung({
      signal,
      ausloesen: async (versuch) => {
        const skillDir = realPath.join(skillsDir, `frisch-${versuch}`);
        await fsPromises.mkdir(skillDir);
        await fsPromises.writeFile(
          realPath.join(skillDir, 'SKILL.md'),
          '---\nname: frisch\ndescription: Neu angelegt\n---\n\nHallo.\n',
          'utf8'
        );
      },
    });
    assert.ok(gemeldet, 'das Anlegen eines Skills wurde gemeldet');
  } finally {
    watcher.close();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('meldet auch, wenn das ganze Skill-Verzeichnis verschwindet', async () => {
  // Der Fall, der beim Rauchtest aufflog: Ein Watcher auf `.agents/skills`
  // sieht Änderungen *darin*, verstummt unter macOS aber lautlos, wenn das
  // Verzeichnis selbst mitgelöscht wird — ohne Ereignis und ohne Fehler.
  // Gerettet wird das nur vom Wächter auf dem Vorfahren.
  const root = await makeTempRoot('snotra-watch-rm-');
  const agentsDir = realPath.join(root, '.agents');
  const skillDir = realPath.join(agentsDir, 'skills', 'verschwindet');
  // Die Struktur steht schon vor dem ersten Wächter: Nur dann hängt die Kette
  // von Anfang an am Ziel. Begänne sie flach auf der Wurzel, bliebe ein
  // verlorenes `.agents`-Ereignis unbemerkt und nichts baute sie je um.
  await fsPromises.mkdir(skillDir, { recursive: true });

  const signal = createMeldungssignal();
  const watcher = createSkillsWatcher({
    watch,
    path: realPath,
    os: { homedir: () => realPath.join(root, '__kein-home__') },
    onChange: () => signal.melden(),
    debounceMs: 50,
  });

  try {
    watcher.watchWorkspace(root);
    const gemeldet = await bisMeldung({
      signal,
      // Stellt nach einem missglückten Versuch das Gelöschte wieder her und
      // belegt zugleich, dass der Wächter am Ziel wirklich schon meldet.
      vorbereiten: async () => {
        await fsPromises.mkdir(skillDir, { recursive: true });
        await fsPromises.writeFile(realPath.join(skillDir, 'SKILL.md'), '---\nname: x\n---\n', 'utf8');
      },
      ausloesen: () => fsPromises.rm(agentsDir, { recursive: true, force: true }),
    });
    assert.ok(gemeldet, 'das Entfernen wurde gemeldet');
  } finally {
    watcher.close();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('ein Watcher, der sein Startfenster verschläft, bleibt nicht taub', async () => {
  // Der Fall aus #155, gegen das echte Dateisystem nachgestellt: `fs.watch()`
  // kehrt zurück, bevor der FSEvents-Stream läuft — was in dieses Fenster
  // fällt, ist weg. Die Attrappe verschläft ihre ersten Ereignisse, also auch
  // das eine, das den Umbau auf `.agents/skills` auslösen würde. Ohne
  // Wiedervorlage bliebe der Dienst danach dauerhaft still.
  const STARTFENSTER_MS = 400;
  const verschlafenderWatch = (dir, optionen, handler) => {
    const geboren = Date.now();
    return watch(dir, optionen, (...args) => {
      if (Date.now() - geboren < STARTFENSTER_MS) return;
      handler(...args);
    });
  };

  // Der Workspace beginnt ohne `.agents` — die Kette hängt auf der Wurzel.
  const root = await makeTempRoot('snotra-watch-taub-');
  const skillsDir = realPath.join(root, '.agents', 'skills');

  const signal = createMeldungssignal();
  const watcher = createSkillsWatcher({
    watch: verschlafenderWatch,
    path: realPath,
    // Ein Home, das es nicht gibt: Diese Quelle bleibt unerreichbar, die
    // Wiedervorlage läuft also weiter — dem Workspace-Ziel schadet das nicht.
    os: { homedir: () => realPath.join(root, '__kein-home__') },
    onChange: () => signal.melden(),
    debounceMs: 50,
    retryMs: 100,
  });

  try {
    watcher.watchWorkspace(root);
    assert.equal(
      watcher.watchedDirectories()[0].isTarget,
      false,
      'zu Beginn hängt die Kette auf einem Vorfahren'
    );

    await fsPromises.mkdir(realPath.join(skillsDir, 'neu'), { recursive: true });
    await fsPromises.writeFile(
      realPath.join(skillsDir, 'neu', 'SKILL.md'),
      '---\nname: neu\ndescription: Nach dem Startfenster angelegt\n---\n\nHallo.\n',
      'utf8'
    );

    // Großzügig bemessen: Es geht darum, *dass* die Meldung kommt, nicht wie
    // schnell. Das Zeitbudget trägt mehrere Runden der Wiedervorlage.
    assert.ok(
      await signal.warten(DEFAULT_MAX_WAIT_MS * 10),
      'das neue Skill-Verzeichnis wurde trotz verlorenem Ereignis gemeldet'
    );
    assert.deepEqual(
      watcher.watchedDirectories()[0],
      { dir: skillsDir, isTarget: true },
      'und die Kette hängt danach am Ziel'
    );
  } finally {
    watcher.close();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
