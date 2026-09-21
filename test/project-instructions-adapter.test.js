const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createProjectInstructionsAdapter } = require('../src/main/adapters/project-instructions-adapter');
const {
  PROJECT_INSTRUCTION_SOURCES: SRC,
  MAX_PROJECT_INSTRUCTION_CHARS,
} = require('../src/shared/contracts/project-instructions');

// Aufgeloest, nicht nur zusammengesetzt: Der Adapter loest Home und Ordner
// auf, und unter Windows haengt `resolve` dabei den Laufwerksbuchstaben an
// (`\tmp\projekt` wird zu `D:\tmp\projekt`). Ohne das hier laufen die
// Erwartungen an den erzeugten Pfaden vorbei — auf dem Mac unsichtbar, in der
// Windows-CI rot.
const HOME = path.resolve(path.join('/home', 'konrad'));
const ROOT = path.resolve(path.join('/tmp', 'projekt'));

const P = {
  workspaceAgents: path.join(ROOT, '.agents', 'AGENTS.md'),
  userSnotra: path.join(HOME, '.snotra', 'AGENTS.md'),
  userAgents: path.join(HOME, '.agents', 'AGENTS.md'),
  /** Kein Ziel mehr, nur noch Koeder fuer den Test unten (#253). */
  workspaceRoot: path.join(ROOT, 'AGENTS.md'),
};

/** `files` bildet Pfad auf Inhalt ab; ein `Error` als Wert wird geworfen. */
function makeFs(files, log = null) {
  return {
    async readFile(target) {
      if (log) log.push(target);
      const hit = files[target];
      if (hit === undefined) {
        const e = new Error(`ENOENT: ${target}`);
        e.code = 'ENOENT';
        throw e;
      }
      if (hit instanceof Error) throw hit;
      return hit;
    },
  };
}

function build(files, { home = HOME, log = null, ...rest } = {}) {
  return createProjectInstructionsAdapter({
    fs: makeFs(files, log),
    path,
    os: { homedir: () => home },
    ...rest,
  });
}

test('alle drei Quellen kommen in der Reihenfolge aus #251', async () => {
  const adapter = build({
    [P.workspaceAgents]: 'projekt',
    [P.userSnotra]: 'global snotra',
    [P.userAgents]: 'global agents',
  });
  const files = await adapter.load({ workspaceRoot: ROOT });
  assert.deepEqual(files.map((f) => f.source), [
    SRC.WORKSPACE_AGENTS,
    SRC.USER_SNOTRA,
    SRC.USER_AGENTS,
  ]);
  assert.deepEqual(files.map((f) => f.text), ['projekt', 'global snotra', 'global agents']);
  assert.deepEqual(files.map((f) => f.truncated), [false, false, false]);
});

test('eine AGENTS.md in der Ordnerwurzel wird weder gelesen noch geliefert (#253)', async () => {
  const log = [];
  const files = await build(
    { [P.workspaceRoot]: 'aus der Ordnerwurzel', [P.workspaceAgents]: 'aus .agents' },
    { log }
  ).load({ workspaceRoot: ROOT });
  assert.deepEqual(files, [{ source: SRC.WORKSPACE_AGENTS, text: 'aus .agents', truncated: false }]);
  // Nicht nur ignoriert — gar nicht erst angefasst.
  assert.ok(!log.includes(P.workspaceRoot), log.join(', '));
});

test('jede Teilmenge kommt durch, fehlende Dateien sind kein Fehler', async () => {
  assert.deepEqual((await build({}).load({ workspaceRoot: ROOT })), []);

  const nurSnotra = await build({ [P.userSnotra]: 'nur hier' }).load({ workspaceRoot: ROOT });
  assert.deepEqual(nurSnotra, [{ source: SRC.USER_SNOTRA, text: 'nur hier', truncated: false }]);

  const ohneProjekt = await build({
    [P.userSnotra]: 'a',
    [P.userAgents]: 'b',
  }).load({ workspaceRoot: ROOT });
  assert.deepEqual(ohneProjekt.map((f) => f.source), [SRC.USER_SNOTRA, SRC.USER_AGENTS]);
});

test('ohne offenen Ordner bleiben nur die beiden globalen Quellen', async () => {
  const log = [];
  const files = await build(
    { [P.userAgents]: 'global', [P.workspaceAgents]: 'nie gelesen' },
    { log }
  ).load({});
  assert.deepEqual(files.map((f) => f.source), [SRC.USER_AGENTS]);
  assert.deepEqual(log, [P.userSnotra, P.userAgents]);
});

test('ohne Home-Verzeichnis bleibt nur die Projekt-Quelle', async () => {
  const log = [];
  const files = await build({ [P.workspaceAgents]: 'projekt' }, { home: null, log })
    .load({ workspaceRoot: ROOT });
  assert.deepEqual(files.map((f) => f.source), [SRC.WORKSPACE_AGENTS]);
  assert.deepEqual(log, [P.workspaceAgents]);
});

test('ein unlesbares oder leeres AGENTS.md wird übergangen, nicht gemeldet', async () => {
  const denied = new Error('EACCES');
  denied.code = 'EACCES';
  const files = await build({
    [P.userAgents]: denied,
    [P.userSnotra]: '   \n  ',
    [P.workspaceAgents]: 'bleibt',
  }).load({ workspaceRoot: ROOT });
  assert.deepEqual(files.map((f) => f.source), [SRC.WORKSPACE_AGENTS]);
});

test('übergroße Dateien werden je Datei gekürzt und als gekürzt gemeldet', async () => {
  const files = await build({
    [P.workspaceAgents]: 'x'.repeat(MAX_PROJECT_INSTRUCTION_CHARS + 500),
    [P.userSnotra]: 'y'.repeat(MAX_PROJECT_INSTRUCTION_CHARS),
  }).load({ workspaceRoot: ROOT });
  assert.equal(files[0].text.length, MAX_PROJECT_INSTRUCTION_CHARS);
  assert.equal(files[0].truncated, true);
  // Genau auf der Grenze wird nicht gekürzt.
  assert.equal(files[1].truncated, false);

  const eng = await build({ [P.workspaceAgents]: 'abcdef' }, { maxChars: 3 })
    .load({ workspaceRoot: ROOT });
  assert.deepEqual(eng, [{ source: SRC.WORKSPACE_AGENTS, text: 'abc', truncated: true }]);
});

test('liegt der Ordner im Home, wird dieselbe Datei nicht zweimal gelesen', async () => {
  // `<workspace>/.agents/AGENTS.md` ist dann zugleich `~/.agents/AGENTS.md`.
  const log = [];
  const files = await build({ [path.join(HOME, '.agents', 'AGENTS.md')]: 'einmal' }, { log })
    .load({ workspaceRoot: HOME });
  assert.deepEqual(log, [
    path.join(HOME, '.agents', 'AGENTS.md'),
    path.join(HOME, '.snotra', 'AGENTS.md'),
  ]);
  // Es bleibt der erste Treffer stehen — der Inhalt steht einmal im Prompt.
  assert.deepEqual(files.map((f) => f.source), [SRC.WORKSPACE_AGENTS]);
});

test('ein relativer Ordnerpfad wird aufgelöst, bevor gelesen wird', async () => {
  const log = [];
  await build({}, { log }).load({ workspaceRoot: './unterordner' });
  assert.ok(log.includes(path.join(path.resolve('./unterordner'), '.agents', 'AGENTS.md')));
});

test('unter Windows-Pfaden gilt dieselbe Kette und dieselbe Doppelt-Erkennung', async () => {
  // Pinnt die Kette gegen Windows-Pfadsemantik auf jeder Plattform fest —
  // sonst faellt ein fest verdrahteter `/` erst in der Windows-CI auf.
  const home = 'C:\\Users\\konrad';
  const log = [];
  const adapter = createProjectInstructionsAdapter({
    fs: makeFs({}, log),
    path: path.win32,
    os: { homedir: () => home },
  });
  await adapter.load({ workspaceRoot: home });
  assert.deepEqual(log, [
    'C:\\Users\\konrad\\.agents\\AGENTS.md',
    'C:\\Users\\konrad\\.snotra\\AGENTS.md',
  ]);
});

test('ohne fs oder path lässt sich der Adapter nicht bauen', () => {
  assert.throws(() => createProjectInstructionsAdapter({ path }), TypeError);
  assert.throws(() => createProjectInstructionsAdapter({ fs: makeFs({}) }), TypeError);
});
