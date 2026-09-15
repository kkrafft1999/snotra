const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createEnvironmentAdapter } = require('../src/main/adapters/environment-adapter');

const OS = { type: () => 'Darwin', release: () => '27.0.0' };

function makeFs(entries) {
  return {
    async stat(target) {
      const hit = entries[target];
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

function build(overrides = {}) {
  return createEnvironmentAdapter({
    fs: makeFs({}),
    path,
    os: OS,
    getAppVersion: () => '1.5.3',
    platform: 'darwin',
    now: () => new Date(2026, 8, 15, 12, 0),
    ...overrides,
  });
}

test('meldet ein Git-Repository, wenn .git existiert', async () => {
  const root = path.join('/tmp', 'projekt');
  const adapter = build({ fs: makeFs({ [path.join(root, '.git')]: { isDirectory: () => true } }) });
  const facts = await adapter.describe({ workspaceRoot: root });
  assert.equal(facts.isGitRepository, true);
  assert.equal(facts.workspaceRoot, root);
  assert.equal(facts.osVersion, 'Darwin 27.0.0');
  assert.equal(facts.appName, 'Snotra AI');
  assert.equal(facts.appVersion, '1.5.3');
});

test('fehlendes .git heisst „kein Repository", ein Rechtefehler heisst „unbekannt"', async () => {
  const root = path.join('/tmp', 'projekt');
  assert.equal((await build().describe({ workspaceRoot: root })).isGitRepository, false);

  const denied = new Error('EACCES');
  denied.code = 'EACCES';
  const adapter = build({ fs: makeFs({ [path.join(root, '.git')]: denied }) });
  assert.equal((await adapter.describe({ workspaceRoot: root })).isGitRepository, null);
});

test('ohne offenen Ordner bleiben Pfad und Git-Angabe leer', async () => {
  const facts = await build().describe({});
  assert.equal(facts.workspaceRoot, null);
  assert.equal(facts.isGitRepository, null);
  assert.equal(facts.platform, 'darwin');
});

test('die Shell kommt nur mit, wenn sie gefunden und eingeschaltet ist', async () => {
  const cases = [
    [{ found: true, enabled: true, label: 'zsh' }, 'zsh'],
    [{ found: true, enabled: false, label: 'zsh' }, null],
    [{ found: false, enabled: true, error: 'nichts gefunden' }, null],
    [null, null],
  ];
  for (const [state, expected] of cases) {
    const adapter = build({ describeShell: () => state });
    assert.equal((await adapter.describe({})).shell, expected, JSON.stringify(state));
  }
  // Ohne Shell-Quelle (Minimalaufbau, Tests) bleibt die Angabe ebenfalls leer.
  assert.equal((await build({ describeShell: null }).describe({})).shell, null);
});

test('eine werfende Shell-Erkennung kippt die uebrigen Angaben nicht', async () => {
  const adapter = build({
    describeShell: () => { throw new Error('Erkennung kaputt'); },
    getAppVersion: () => { throw new Error('keine Version'); },
  });
  const facts = await adapter.describe({});
  assert.equal(facts.shell, null);
  assert.equal(facts.appVersion, '');
  assert.equal(facts.osVersion, 'Darwin 27.0.0');
});
