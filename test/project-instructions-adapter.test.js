const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createProjectInstructionsAdapter } = require('../src/main/adapters/project-instructions-adapter');
const {
  PROJECT_INSTRUCTION_SOURCES: SRC,
  MAX_PROJECT_INSTRUCTION_CHARS,
} = require('../src/shared/contracts/project-instructions');

const HOME = path.join('/home', 'konrad');
const ROOT = path.join('/tmp', 'projekt');

const P = {
  userAgents: path.join(HOME, '.agents', 'AGENTS.md'),
  userSnotra: path.join(HOME, '.snotra', 'AGENTS.md'),
  workspaceRoot: path.join(ROOT, 'AGENTS.md'),
  workspaceAgents: path.join(ROOT, '.agents', 'AGENTS.md'),
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

test('alle vier Stufen werden in der Reihenfolge der Kette geliefert (#212)', async () => {
  const adapter = build({
    [P.userAgents]: 'global',
    [P.userSnotra]: 'global snotra',
    [P.workspaceRoot]: 'projekt',
    [P.workspaceAgents]: 'projekt agents',
  });
  const files = await adapter.load({ workspaceRoot: ROOT });
  assert.deepEqual(files.map((f) => f.source), [
    SRC.USER_AGENTS,
    SRC.USER_SNOTRA,
    SRC.WORKSPACE_ROOT,
    SRC.WORKSPACE_AGENTS,
  ]);
  assert.deepEqual(files.map((f) => f.text), ['global', 'global snotra', 'projekt', 'projekt agents']);
  assert.deepEqual(files.map((f) => f.truncated), [false, false, false, false]);
});

test('jede Teilmenge kommt durch, fehlende Dateien sind kein Fehler', async () => {
  assert.deepEqual((await build({}).load({ workspaceRoot: ROOT })), []);

  const nurSnotra = await build({ [P.userSnotra]: 'nur hier' }).load({ workspaceRoot: ROOT });
  assert.deepEqual(nurSnotra, [{ source: SRC.USER_SNOTRA, text: 'nur hier', truncated: false }]);

  const ohneGlobal = await build({
    [P.workspaceRoot]: 'a',
    [P.workspaceAgents]: 'b',
  }).load({ workspaceRoot: ROOT });
  assert.deepEqual(ohneGlobal.map((f) => f.source), [SRC.WORKSPACE_ROOT, SRC.WORKSPACE_AGENTS]);
});

test('ohne offenen Ordner bleiben nur die beiden globalen Stufen', async () => {
  const log = [];
  const files = await build(
    { [P.userAgents]: 'global', [P.workspaceRoot]: 'nie gelesen' },
    { log }
  ).load({});
  assert.deepEqual(files.map((f) => f.source), [SRC.USER_AGENTS]);
  assert.deepEqual(log, [P.userAgents, P.userSnotra]);
});

test('ohne Home-Verzeichnis bleiben nur die beiden Projekt-Stufen', async () => {
  const log = [];
  const files = await build({ [P.workspaceRoot]: 'projekt' }, { home: null, log })
    .load({ workspaceRoot: ROOT });
  assert.deepEqual(files.map((f) => f.source), [SRC.WORKSPACE_ROOT]);
  assert.deepEqual(log, [P.workspaceRoot, P.workspaceAgents]);
});

test('ein unlesbares oder leeres AGENTS.md wird übergangen, nicht gemeldet', async () => {
  const denied = new Error('EACCES');
  denied.code = 'EACCES';
  const files = await build({
    [P.userAgents]: denied,
    [P.userSnotra]: '   \n  ',
    [P.workspaceRoot]: 'bleibt',
  }).load({ workspaceRoot: ROOT });
  assert.deepEqual(files.map((f) => f.source), [SRC.WORKSPACE_ROOT]);
});

test('übergroße Dateien werden je Datei gekürzt und als gekürzt gemeldet', async () => {
  const files = await build({
    [P.workspaceRoot]: 'x'.repeat(MAX_PROJECT_INSTRUCTION_CHARS + 500),
    [P.workspaceAgents]: 'y'.repeat(MAX_PROJECT_INSTRUCTION_CHARS),
  }).load({ workspaceRoot: ROOT });
  assert.equal(files[0].text.length, MAX_PROJECT_INSTRUCTION_CHARS);
  assert.equal(files[0].truncated, true);
  // Genau auf der Grenze wird nicht gekürzt.
  assert.equal(files[1].truncated, false);

  const eng = await build({ [P.workspaceRoot]: 'abcdef' }, { maxChars: 3 })
    .load({ workspaceRoot: ROOT });
  assert.deepEqual(eng, [{ source: SRC.WORKSPACE_ROOT, text: 'abc', truncated: true }]);
});

test('liegt der Ordner im Home, wird dieselbe Datei nicht zweimal gelesen', async () => {
  // `<home>/.agents/AGENTS.md` ist dann zugleich `<workspace>/.agents/AGENTS.md`.
  const log = [];
  const files = await build(
    { [P.userAgents]: 'einmal', [path.join(HOME, 'AGENTS.md')]: 'wurzel' },
    { log }
  ).load({ workspaceRoot: HOME });
  assert.deepEqual(log, [
    path.join(HOME, '.agents', 'AGENTS.md'),
    path.join(HOME, '.snotra', 'AGENTS.md'),
    path.join(HOME, 'AGENTS.md'),
  ]);
  // Es gewinnt die allgemeinere Quelle — der Inhalt steht nur einmal im Prompt.
  assert.deepEqual(files.map((f) => f.source), [SRC.USER_AGENTS, SRC.WORKSPACE_ROOT]);
});

test('ein relativer Ordnerpfad wird aufgelöst, bevor gelesen wird', async () => {
  const log = [];
  await build({}, { log }).load({ workspaceRoot: './unterordner' });
  assert.ok(log.includes(path.join(path.resolve('./unterordner'), 'AGENTS.md')));
});

test('ohne fs oder path lässt sich der Adapter nicht bauen', () => {
  assert.throws(() => createProjectInstructionsAdapter({ path }), TypeError);
  assert.throws(() => createProjectInstructionsAdapter({ fs: makeFs({}) }), TypeError);
});
