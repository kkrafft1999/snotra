const test = require('node:test');
const assert = require('node:assert/strict');
const nodePath = require('path');
const { createSkillsWatcher, MAX_FALLBACK_LEVELS } = require('../src/main/services/skills-watcher');

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
const HOME_SKILLS = path.join(HOME, '.agents', 'skills');
const os = { homedir: () => HOME };

/**
 * Ein `fs.watch`-Ersatz, der über `missing` steuert, welche Verzeichnisse es
 * (noch) nicht gibt — genau der Fall, um den herum der Dienst gebaut ist.
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
  return { watch, created, appear: (dir) => absent.delete(dir), absent };
}

/**
 * Ein einziger anstehender Timer reicht — der Dienst entprellt nur einen.
 * Die Uhr ist mitgesteuert, damit sich das Höchstfenster prüfen lässt, ohne
 * wirklich zu warten.
 */
function createFakeClock() {
  let pending = null;
  let nextId = 0;
  let now = 1_000_000;
  return {
    setTimeoutImpl: (fn) => {
      pending = { fn, id: ++nextId };
      return pending.id;
    },
    clearTimeoutImpl: (handle) => {
      if (pending && pending.id === handle) pending = null;
    },
    nowImpl: () => now,
    advance(ms) {
      now += ms;
    },
    get pendingId() {
      return pending?.id ?? null;
    },
    get hasPending() {
      return pending !== null;
    },
    tick() {
      const due = pending;
      pending = null;
      due?.fn();
    },
  };
}

function setup({ missing = [], onChange } = {}) {
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
    { dir: HOME_SKILLS, isTarget: true },
    { dir: path.join(HOME, '.agents'), isTarget: false },
    { dir: HOME, isTarget: false },
  ]);
  // Unterordner zählen nur beim Ziel — die SKILL.md liegt eine Ebene tiefer.
  assert.equal(fake.created[0].options.recursive, true);
  assert.equal(fake.created[1].options.recursive, false);
  watcher.close();
});

test('ohne offenen Ordner bleibt die Home-Quelle beobachtet', () => {
  const { watcher } = setup();
  watcher.watchWorkspace(null);
  assert.deepEqual(
    watcher.watchedDirectories().map((w) => w.dir),
    [HOME_SKILLS, path.join(HOME, '.agents'), HOME]
  );
  watcher.close();
});

test('ein fehlendes Verzeichnis lässt die vorhandenen Vorfahren beobachten', () => {
  const { fake, watcher } = setup({ missing: [WS_SKILLS, path.join(WS, '.agents')] });
  watcher.watchWorkspace(WS);
  const watched = watcher.watchedDirectories();
  assert.deepEqual(watched[0], { dir: WS, isTarget: false }, 'zwei Ebenen hoch bis zum Workspace');
  assert.equal(fake.created[0].options.recursive, false, 'ein Wächter bleibt flach');
  assert.deepEqual(watched[1], { dir: HOME_SKILLS, isTarget: true }, 'Home ist davon unberührt');
  watcher.close();
});

test('ein Wächter über dem Ziel reagiert nur auf das Pfadstück, auf das er wartet', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  const wsWatcher = fake.created.find((w) => w.dir === WS);

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
    missing: [WS_SKILLS, path.join(WS, '.agents'), WS, HOME_SKILLS, path.join(HOME, '.agents'), HOME],
  });
  watcher.watchWorkspace(WS);
  assert.deepEqual(watcher.watchedDirectories(), [], 'kein Absturz, nur kein Watcher');
  watcher.close();
});

test('viele Ereignisse münden in eine einzige Meldung', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  for (let i = 0; i < 20; i += 1) fake.created[0].handler('rename', `skill-${i}/SKILL.md`);
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
  const ziel = fake.created.find((w) => w.dir === WS_SKILLS);

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
  const wurzel = fake.created.find((w) => w.dir === WS);
  const ziel = fake.created.find((w) => w.dir === WS_SKILLS);

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
  fake.created[0].handler('rename', '.agents');
  clock.tick();

  assert.equal(changes.length, 1, 'Änderung gemeldet');
  assert.deepEqual(watcher.watchedDirectories()[0], { dir: WS_SKILLS, isTarget: true });
  watcher.close();
});

test('ein Fehler des Watchers stürzt nicht ab, sondern baut neu auf', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  const first = fake.created[0];
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
    [path.join(anderer, '.agents', 'skills'), HOME_SKILLS]
  );
  watcher.close();
});

test('close räumt alles ab und schluckt noch laufende Ereignisse', () => {
  const { fake, clock, changes, watcher } = setup();
  watcher.watchWorkspace(WS);
  fake.created[0].handler('change', 'SKILL.md');
  assert.ok(clock.hasPending, 'eine Meldung steht an');

  watcher.close();
  assert.ok(fake.created.every((w) => w.closed));
  assert.equal(clock.hasPending, false, 'der Timer ist abgeräumt');
  assert.deepEqual(watcher.watchedDirectories(), []);

  // Auch ein Ereignis, das den Weg noch findet, meldet nach close nichts mehr.
  fake.created[0].handler('change', 'SKILL.md');
  clock.tick();
  assert.deepEqual(changes, []);
});

test('liegt der Workspace im Home, wird dieselbe Quelle nicht doppelt beobachtet', () => {
  const { watcher } = setup();
  watcher.watchWorkspace(HOME);
  const dirs = watcher.watchedDirectories().map((w) => w.dir);
  assert.deepEqual(dirs, [...new Set(dirs)], 'jeder Pfad nur einmal');
  assert.deepEqual(dirs, [HOME_SKILLS, path.join(HOME, '.agents'), HOME]);
  watcher.close();
});

test('der Aufstieg endet an der Workspace-Wurzel', () => {
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

test('meldet eine echte neue SKILL.md im Unterordner', async () => {
  const root = await makeTempRoot('snotra-watch-');
  const skillsDir = realPath.join(root, '.agents', 'skills');
  await fsPromises.mkdir(skillsDir, { recursive: true });

  let meldungen = 0;
  const watcher = createSkillsWatcher({
    watch,
    path: realPath,
    os: { homedir: () => realPath.join(root, '__kein-home__') },
    onChange: () => {
      meldungen += 1;
    },
    debounceMs: 50,
  });

  try {
    watcher.watchWorkspace(root);
    const skillDir = realPath.join(skillsDir, 'frisch');
    await fsPromises.mkdir(skillDir);
    await fsPromises.writeFile(
      realPath.join(skillDir, 'SKILL.md'),
      '---\nname: frisch\ndescription: Neu angelegt\n---\n\nHallo.\n',
      'utf8'
    );

    for (let i = 0; i < 60 && meldungen === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(meldungen > 0, 'das Anlegen eines Skills wurde gemeldet');
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
  const skillDir = realPath.join(root, '.agents', 'skills', 'verschwindet');
  await fsPromises.mkdir(skillDir, { recursive: true });
  await fsPromises.writeFile(realPath.join(skillDir, 'SKILL.md'), '---\nname: x\n---\n', 'utf8');

  let meldungen = 0;
  const watcher = createSkillsWatcher({
    watch,
    path: realPath,
    os: { homedir: () => realPath.join(root, '__kein-home__') },
    onChange: () => {
      meldungen += 1;
    },
    debounceMs: 50,
  });

  try {
    watcher.watchWorkspace(root);
    await new Promise((resolve) => setTimeout(resolve, 200));
    meldungen = 0;

    await fsPromises.rm(realPath.join(root, '.agents'), { recursive: true, force: true });
    for (let i = 0; i < 60 && meldungen === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(meldungen > 0, 'das Entfernen wurde gemeldet');
  } finally {
    watcher.close();
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
