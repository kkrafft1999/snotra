// Der verallgemeinerte Verzeichnis-Wächter und der Dateibaum-Watcher darauf
// (Issue #158).
//
// Was der Kern schon konnte — fehlende Ziele, Vorfahren-Kette, Entprellung mit
// Höchstfenster, Wiedervorlage —, prüft weiterhin test/skills-watcher.test.js
// gegen dieselbe Mechanik; diese Datei nimmt sich das Neue vor: die
// Pfad-Nutzlast, die Ignorierliste und die konfigurierbaren Ziele.

const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');
const nodeFs = require('fs');
const os = require('os');

const { createDirectoryWatcher } = require('../src/main/services/directory-watcher');
const {
  createWorkspaceWatcher,
  isIgnoredWorkspacePath,
  isGitSignal,
} = require('../src/main/services/workspace-watcher');
const { createWorkspaceTreeChangedEvent } = require('../src/shared/contracts/workspace-tree');

/**
 * Wie im Skills-Test wird bewusst in POSIX-Pfaden gerechnet: Geprüft wird die
 * Logik, nicht die Pfadsyntax der Plattform. Der Lauf gegen das echte
 * Dateisystem am Ende der Datei deckt die jeweilige Plattform ab.
 */
const path = nodePath.posix;
const WS = path.join(path.sep, 'projekte', 'demo');

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
      on() {
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
    aktiv: (dir) => created.filter((w) => w.dir === dir && !w.closed).at(-1) ?? null,
  };
}

/** Eine mitgesteuerte Uhr — Entprellen ohne Warten. */
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
    /** Führt den nächstfälligen Timer aus, ohne auf die Uhr zu sehen. */
    tick() {
      const due = naechster();
      if (!due) return;
      timers = timers.filter((t) => t.id !== due.id);
      due.fn();
    },
    /** Führt nur aus, was nach der aktuellen Uhrzeit wirklich dran ist. */
    tickDue() {
      for (;;) {
        const due = naechster();
        if (!due || due.faellig > now) return;
        timers = timers.filter((t) => t.id !== due.id);
        due.fn();
      }
    },
  };
}

function setupWorkspace({ missing = [] } = {}) {
  const fake = createFakeWatch(missing);
  const clock = createFakeClock();
  const meldungen = [];
  const watcher = createWorkspaceWatcher({
    watch: fake.watch,
    path,
    onChange: (payload) => meldungen.push(payload),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    nowImpl: clock.nowImpl,
  });
  /** Ein Ereignis am Ziel auslösen, wie `fs.watch` es meldet. */
  const feuern = (filename, eventType = 'rename') => fake.aktiv(WS).handler(eventType, filename);
  return { fake, clock, meldungen, watcher, feuern };
}

// ── Ziele ───────────────────────────────────────────────────────────────────

test('der Workspace-Root wird rekursiv beobachtet, ohne Kette nach oben', () => {
  const { fake, watcher } = setupWorkspace();
  watcher.watchWorkspace(WS);
  // Nur der Root selbst: Er existiert, und oberhalb lägen fremde Verzeichnisse.
  assert.deepEqual(watcher.watchedDirectories(), [{ dir: WS, isTarget: true }]);
  assert.equal(fake.aktiv(WS).options.recursive, true);
});

test('kann die Plattform nicht rekursiv beobachten, bleibt ein flacher Wächter', () => {
  const versuche = [];
  const watch = (dir, options) => {
    versuche.push(Boolean(options.recursive));
    if (options.recursive) {
      const error = new Error('recursive watch nicht verfügbar');
      error.code = 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM';
      throw error;
    }
    return {
      close() {},
      on() {
        return this;
      },
    };
  };
  const fehler = [];
  const watcher = createWorkspaceWatcher({
    watch,
    path,
    onChange: () => {},
    onError: (error) => fehler.push(error.code),
  });

  watcher.watchWorkspace(WS);

  // Die oberste Ebene zu sehen ist besser, als taub zu sein — und vor allem
  // besser als eine Wiedervorlage, die alle paar Sekunden vergeblich neu
  // aufsetzt.
  assert.deepEqual(watcher.watchedDirectories(), [{ dir: WS, isTarget: true }]);
  assert.equal(watcher.retryPending(), false, 'kein Dauertimer');
  assert.deepEqual(fehler, ['ERR_FEATURE_UNAVAILABLE_ON_PLATFORM'], 'der Grund wird gemeldet');
  assert.deepEqual(versuche, [false, true, false], 'anklopfen, rekursiv versuchen, flach nehmen');
});

test('beobachtet wird der aufgelöste Pfad, gemeldet der angezeigte', () => {
  // Der Windows-Fall: TEMP ist ein 8.3-Kurzname, `fs.watch` meldet die
  // Langform — und libuv bricht darüber den ganzen Prozess ab. Beobachtet wird
  // deshalb aufgelöst. Der Renderer kennt seinen Baum aber unter dem
  // angezeigten Pfad, also muss die Meldung dorthin zurückübersetzt werden.
  const KURZ = path.join(path.sep, 'PROJEK~1', 'demo');
  const fake = createFakeWatch();
  const clock = createFakeClock();
  const meldungen = [];
  const watcher = createWorkspaceWatcher({
    watch: fake.watch,
    path,
    realpath: (dir) => (dir === KURZ ? WS : dir),
    onChange: (payload) => meldungen.push(payload),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    nowImpl: clock.nowImpl,
  });

  watcher.watchWorkspace(KURZ);
  assert.deepEqual(watcher.watchedDirectories(), [{ dir: WS, isTarget: true }], 'beobachtet: aufgelöst');

  fake.aktiv(WS).handler('rename', path.join('docs', 'notiz.md'));
  clock.tick();
  assert.deepEqual(meldungen[0].directories, [path.join(KURZ, 'docs')], 'gemeldet: angezeigt');
});

test('lässt sich der Pfad nicht auflösen, bleibt es beim angezeigten', () => {
  const fake = createFakeWatch();
  const watcher = createWorkspaceWatcher({
    watch: fake.watch,
    path,
    realpath: () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    onChange: () => {},
  });
  watcher.watchWorkspace(WS);
  // Der Watcher scheitert dann sauber am fehlenden Ordner, nicht hier.
  assert.deepEqual(watcher.watchedDirectories(), [{ dir: WS, isTarget: true }]);
});

test('ohne geöffneten Ordner wird nichts beobachtet', () => {
  const { watcher } = setupWorkspace();
  watcher.watchWorkspace(null);
  assert.deepEqual(watcher.watchedDirectories(), []);
  assert.equal(watcher.retryPending(), false, 'und es läuft keine Wiedervorlage ins Leere');
});

test('der Ordnerwechsel schließt die Wächter des alten Workspace', () => {
  const { fake, watcher } = setupWorkspace();
  watcher.watchWorkspace(WS);
  const alt = fake.aktiv(WS);
  watcher.watchWorkspace(path.join(path.sep, 'projekte', 'anderes'));
  assert.equal(alt.closed, true, 'kein Handle-Leck beim Wechsel');
  assert.deepEqual(
    watcher.watchedDirectories().map((w) => w.dir),
    [path.join(path.sep, 'projekte', 'anderes')]
  );
});

test('close beendet Wächter und schluckt noch laufende Ereignisse', () => {
  const { fake, clock, meldungen, watcher, feuern } = setupWorkspace();
  watcher.watchWorkspace(WS);
  feuern('neu.txt');
  const wachter = fake.aktiv(WS);
  watcher.close();
  assert.equal(wachter.closed, true);
  clock.tick();
  assert.deepEqual(meldungen, [], 'nach close kommt nichts mehr');
});

// ── Pfad-Nutzlast ───────────────────────────────────────────────────────────

test('gemeldet wird der Elternordner des geänderten Eintrags', () => {
  const { clock, meldungen, watcher, feuern } = setupWorkspace();
  watcher.watchWorkspace(WS);

  feuern('README.md');
  feuern(path.join('docs', 'notiz.md'));
  feuern(path.join('docs', 'tief', 'datei.txt'));
  clock.tick();

  assert.equal(meldungen.length, 1, 'ein Vorgang, eine Meldung');
  assert.deepEqual(meldungen[0], {
    directories: [WS, path.join(WS, 'docs'), path.join(WS, 'docs', 'tief')],
    complete: true,
  });
});

test('derselbe Ordner taucht in einer Meldung nur einmal auf', () => {
  const { clock, meldungen, watcher, feuern } = setupWorkspace();
  watcher.watchWorkspace(WS);
  feuern(path.join('src', 'a.js'));
  feuern(path.join('src', 'b.js'));
  feuern(path.join('src', 'a.js'), 'change');
  clock.tick();
  assert.deepEqual(meldungen[0].directories, [path.join(WS, 'src')]);
});

test('ohne Dateinamen gilt die Meldung als unvollständig', () => {
  const { clock, meldungen, watcher, feuern } = setupWorkspace();
  watcher.watchWorkspace(WS);
  // Nicht jede Plattform liefert den Dateinamen mit.
  feuern(null);
  clock.tick();
  assert.deepEqual(meldungen[0], { directories: [], complete: false });
});

test('ein einzelnes namenloses Ereignis macht die ganze Meldung unvollständig', () => {
  const { clock, meldungen, watcher, feuern } = setupWorkspace();
  watcher.watchWorkspace(WS);
  feuern('README.md');
  feuern(undefined);
  clock.tick();
  assert.equal(meldungen[0].complete, false, 'lieber gröber neu laden als etwas übersehen');
  assert.deepEqual(meldungen[0].directories, [WS], 'was bekannt ist, kommt trotzdem mit');
});

// ── Ignorierliste ───────────────────────────────────────────────────────────

test('der Inhalt von node_modules und .git bleibt draußen, die Ordner selbst nicht', () => {
  assert.equal(isIgnoredWorkspacePath(path.join('node_modules', 'left-pad', 'index.js')), true);
  assert.equal(isIgnoredWorkspacePath(path.join('paket', 'node_modules', 'x.js')), true);
  assert.equal(isIgnoredWorkspacePath(path.join('.git', 'objects', 'ab', '123')), true);
  // Entsteht node_modules neu, gehört es in den Baum.
  assert.equal(isIgnoredWorkspacePath('node_modules'), false);
  assert.equal(isIgnoredWorkspacePath('.git'), false);
  // Ein Ordner, der nur so heißt wie eine Datei darin, bleibt unberührt.
  assert.equal(isIgnoredWorkspacePath(path.join('src', 'app.js')), false);
});

test('Editor- und Systemkram wird nicht gemeldet', () => {
  for (const noise of ['.DS_Store', path.join('src', '.DS_Store'), '4913', '.app.js.swp', 'app.js~']) {
    assert.equal(isIgnoredWorkspacePath(noise), true, noise);
  }
  assert.equal(isIgnoredWorkspacePath('swap.js'), false, 'kein Fehlalarm bei normalen Namen');
});

test('Windows-Backslashes zerlegt die Ignorierliste genauso', () => {
  assert.equal(isIgnoredWorkspacePath('node_modules\\left-pad\\index.js'), true);
  assert.equal(isIgnoredWorkspacePath('src\\app.js'), false);
});

test('ignorierte Pfade lösen gar keine Meldung aus', () => {
  const { clock, meldungen, watcher, feuern } = setupWorkspace();
  watcher.watchWorkspace(WS);
  // Ein npm-Lauf schreibt Zehntausende solcher Dateien.
  for (let i = 0; i < 50; i += 1) feuern(path.join('node_modules', `paket-${i}`, 'index.js'));
  clock.tick();
  assert.deepEqual(meldungen, [], 'kein Timer, keine Meldung, kein Rendern');
});

// ── Git-Signale ─────────────────────────────────────────────────────────────

test('.git/HEAD und .git/index kommen durch, der Rest von .git nicht', () => {
  assert.equal(isGitSignal(path.join('.git', 'HEAD')), true);
  assert.equal(isGitSignal(path.join('.git', 'index')), true);
  assert.equal(isGitSignal(path.join('.git', 'ORIG_HEAD')), true);
  assert.equal(isGitSignal(path.join('.git', 'index.lock')), false);
  assert.equal(isGitSignal(path.join('.git', 'refs', 'heads', 'main')), false);
  assert.equal(isGitSignal('HEAD'), false, 'eine Datei HEAD im Projekt ist kein Git-Signal');
});

test('ein Zweigwechsel meldet sich als unvollständig, nicht als hundert Ordner', () => {
  const { clock, meldungen, watcher, feuern } = setupWorkspace();
  watcher.watchWorkspace(WS);
  // So sieht ein Wechsel aus: viele Dateien und dazu das Signal aus .git.
  feuern(path.join('src', 'a.js'));
  feuern(path.join('src', 'b.js'));
  feuern(path.join('.git', 'HEAD'));
  clock.tick();

  assert.equal(meldungen.length, 1);
  assert.equal(meldungen[0].complete, false, 'der Empfänger lädt einmal gröber neu');
  assert.deepEqual(meldungen[0].directories, [path.join(WS, 'src')]);
});

// ── Entprellung über den ganzen Ordner ──────────────────────────────────────

test('ein schreibender Build-Lauf endet trotzdem in einer Meldung je Höchstfenster', () => {
  const { clock, meldungen, watcher, feuern } = setupWorkspace();
  watcher.watchWorkspace(WS);

  // Dauerfeuer: alle 100 ms eine Datei, über drei Sekunden. Ohne Höchstfenster
  // schöbe das die Meldung immer weiter vor sich her und es käme nie eine.
  for (let i = 0; i < 30; i += 1) {
    feuern(path.join('out', `bundle-${i}.js`));
    clock.advance(100);
    clock.tickDue();
  }
  assert.ok(meldungen.length >= 1, 'die Meldung kommt trotz Dauerfeuer');
  assert.ok(meldungen.length <= 5, `höchstens eine je Höchstfenster, waren ${meldungen.length}`);
  for (const meldung of meldungen) {
    assert.deepEqual(meldung.directories, [path.join(WS, 'out')]);
  }
});

// ── Konfigurierbare Ziele (der generische Kern) ─────────────────────────────

test('jedes Ziel bekommt seine eigene Aufstiegstiefe', () => {
  const fake = createFakeWatch();
  const tief = path.join(WS, 'a', 'b', 'c');
  const watcher = createDirectoryWatcher({
    watch: fake.watch,
    path,
    resolveTargets: () => [WS, { dir: tief, fallbackLevels: 1 }],
    fallbackLevels: 0,
    onChange: () => {},
  });
  watcher.watchWorkspace(WS);
  assert.deepEqual(watcher.watchedDirectories(), [
    { dir: WS, isTarget: true },
    { dir: tief, isTarget: true },
    { dir: path.join(WS, 'a', 'b'), isTarget: false },
  ]);
});

test('doppelte Ziele werden nur einmal beobachtet', () => {
  const fake = createFakeWatch();
  const watcher = createDirectoryWatcher({
    watch: fake.watch,
    path,
    resolveTargets: () => [WS, WS, { dir: WS }],
    fallbackLevels: 0,
    onChange: () => {},
  });
  watcher.watchWorkspace(WS);
  assert.deepEqual(watcher.watchedDirectories(), [{ dir: WS, isTarget: true }]);
});

test('ein eigener Zuordner darf den Ordner selbst bestimmen', () => {
  const fake = createFakeWatch();
  const clock = createFakeClock();
  const meldungen = [];
  const watcher = createDirectoryWatcher({
    watch: fake.watch,
    path,
    resolveTargets: () => [WS],
    fallbackLevels: 0,
    changedDirectoryFor: () => path.join(WS, 'immer', 'hierhin'),
    onChange: (payload) => meldungen.push(payload),
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    nowImpl: clock.nowImpl,
  });
  watcher.watchWorkspace(WS);
  fake.aktiv(WS).handler('rename', 'egal.txt');
  clock.tick();
  assert.deepEqual(meldungen[0].directories, [path.join(WS, 'immer', 'hierhin')]);
});

test('der Kern verlangt seine Abhängigkeiten', () => {
  const fake = createFakeWatch();
  assert.throws(() => createDirectoryWatcher({ path, resolveTargets: () => [], onChange() {} }), TypeError);
  assert.throws(() => createDirectoryWatcher({ watch: fake.watch, resolveTargets: () => [], onChange() {} }), TypeError);
  assert.throws(() => createDirectoryWatcher({ watch: fake.watch, path, onChange() {} }), TypeError);
  assert.throws(() => createDirectoryWatcher({ watch: fake.watch, path, resolveTargets: () => [] }), TypeError);
});

// ── Vertrag ────────────────────────────────────────────────────────────────

test('das Ereignis-DTO räumt die Liste auf und kappt sie bei 200', () => {
  const sauber = createWorkspaceTreeChangedEvent({
    directories: ['/ws/a', '/ws/a', '', null, '/ws/b'],
    complete: true,
  });
  assert.deepEqual(sauber, { directories: ['/ws/a', '/ws/b'], complete: true });

  const viele = createWorkspaceTreeChangedEvent({
    directories: Array.from({ length: 250 }, (_, i) => `/ws/ordner-${i}`),
    complete: true,
  });
  assert.equal(viele.directories.length, 200);
  assert.equal(viele.complete, false, 'gekappt heißt unvollständig');

  assert.deepEqual(createWorkspaceTreeChangedEvent(), { directories: [], complete: true });
  assert.deepEqual(createWorkspaceTreeChangedEvent({ directories: 'kaputt', complete: false }), {
    directories: [],
    complete: false,
  });
});

// ── Gegen das echte Dateisystem ────────────────────────────────────────────

/**
 * Unter Windows ist TEMP oft ein 8.3-Kurzname (C:\Users\RUNNER~1\...), und
 * `fs.watch` meldet Pfade dann in der Langform. libuv verträgt das nicht: Es
 * bricht mit einer nativen Assertion ab (`!_wcsnicmp(filename, dir, dirlen)`,
 * `src\win\fs-event.c`) und reißt den ganzen Testprozess mit — nachgemessen
 * am 2026-09-19 im Windows-CI. Einmal auflösen, damit Anlegen und Beobachten
 * denselben Pfad meinen; dieselbe Lektion steckt in
 * `test/skills-watcher.test.js`.
 */
async function makeTempRoot(prefix) {
  const dir = await nodeFs.promises.mkdtemp(nodePath.join(os.tmpdir(), prefix));
  return nodeFs.promises.realpath(dir);
}

// Stürzt der Prozess in einem der Läufe unten ab, meldet node:test nur ein
// nacktes „test failed“ für die ganze Datei. Diese Zeilen machen die Ursache
// sichtbar.
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT in workspace-watcher.test.js:', error);
  process.exit(1);
});

/**
 * Die Ersatz-Watcher oben prüfen die Logik. Ob `fs.watch` auf dieser
 * Plattform wirklich das meldet, worauf der Dateibaum baut — einen rekursiven
 * Wächter samt relativem Pfad —, kann nur ein echter Lauf beantworten.
 */
function realWatcherTest(name, run) {
  test(name, { timeout: 15000 }, async (t) => {
    const root = await makeTempRoot('snotra-ws-watch-');
    const meldungen = [];
    let aufwecken = null;
    const watcher = createWorkspaceWatcher({
      watch: nodeFs.watch,
      path: nodePath,
      onChange: (payload) => {
        meldungen.push(payload);
        aufwecken?.();
      },
    });
    t.after(async () => {
      watcher.close();
      await nodeFs.promises.rm(root, { recursive: true, force: true });
    });
    /** Auf die nächste Meldung warten — der Watcher entprellt 250 ms. */
    const naechsteMeldung = () =>
      new Promise((resolve, reject) => {
        const frist = setTimeout(() => reject(new Error('keine Meldung binnen 8 s')), 8000);
        aufwecken = () => {
          clearTimeout(frist);
          aufwecken = null;
          resolve(meldungen.at(-1));
        };
      });
    await run({ root, watcher, naechsteMeldung, meldungen });
  });
}

realWatcherTest('meldet eine von außen angelegte Datei mit ihrem Ordner', async ({ root, watcher, naechsteMeldung }) => {
  watcher.watchWorkspace(root);
  await nodeFs.promises.mkdir(nodePath.join(root, 'docs'), { recursive: true });
  const meldung = await naechsteMeldung();
  // Der Ordner „docs" entsteht direkt unter der Wurzel — die ist betroffen.
  assert.ok(
    meldung.directories.includes(nodePath.resolve(root)),
    `erwartet ${root} in ${JSON.stringify(meldung.directories)}`
  );
});

realWatcherTest('meldet auch eine Datei tief im Baum', async ({ root, watcher, naechsteMeldung }) => {
  await nodeFs.promises.mkdir(nodePath.join(root, 'docs'), { recursive: true });
  watcher.watchWorkspace(root);
  await nodeFs.promises.writeFile(nodePath.join(root, 'docs', 'notiz.md'), 'hallo\n', 'utf8');
  const meldung = await naechsteMeldung();
  assert.ok(
    meldung.directories.includes(nodePath.join(nodePath.resolve(root), 'docs')) ||
      meldung.complete === false,
    `erwartet docs/ in ${JSON.stringify(meldung)}`
  );
});
