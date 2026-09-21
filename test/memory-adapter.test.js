const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createMemoryAdapter } = require('../src/main/adapters/memory-adapter');
const {
  MEMORY_SCOPES,
  MEMORY_ORIGINS,
  MAX_MEMORY_CHARS,
  MAX_MEMORY_ENTRY_CHARS,
} = require('../src/shared/contracts/memory');

// Aufgeloest wie im Adapter: Unter Windows haengt `resolve` den
// Laufwerksbuchstaben an, und ohne das laufen die Erwartungen an den erzeugten
// Pfaden vorbei — auf dem Mac unsichtbar, in der Windows-CI rot.
const HOME = path.resolve(path.join('/home', 'konrad'));
const ROOT = path.resolve(path.join('/tmp', 'projekt'));
const WORKSPACE_FILE = path.join(ROOT, '.agents', 'memory.md');
const USER_FILE = path.join(HOME, '.snotra', 'memory.md');

function makeFs(files = {}) {
  const made = [];
  return {
    files,
    made,
    async readFile(target) {
      const hit = files[target];
      if (hit === undefined) {
        const e = new Error(`ENOENT: ${target}`);
        e.code = 'ENOENT';
        throw e;
      }
      if (hit instanceof Error) throw hit;
      return hit;
    },
    async writeFile(target, content) {
      files[target] = content;
    },
    async mkdir(dir) {
      made.push(dir);
    },
  };
}

const os = { homedir: () => HOME };

test('beide Ebenen werden gelesen, Ordner zuerst', async () => {
  const fs = makeFs({
    [WORKSPACE_FILE]: '- 2026-09-21 — Projektsache.',
    [USER_FILE]: '- 2026-09-20 — Globale Sache.',
  });
  const adapter = createMemoryAdapter({ fs, path, os });
  const files = await adapter.load({ workspaceRoot: ROOT });
  assert.deepEqual(
    files.map((f) => f.scope),
    [MEMORY_SCOPES.WORKSPACE, MEMORY_SCOPES.USER]
  );
  assert.equal(files[0].file, WORKSPACE_FILE);
  assert.equal(files[1].file, USER_FILE);
});

test('fehlende, leere und unlesbare Dateien sind kein Fehler', async () => {
  const fs = makeFs({
    [WORKSPACE_FILE]: '   \n\n',
    [USER_FILE]: Object.assign(new Error('EACCES'), { code: 'EACCES' }),
  });
  const adapter = createMemoryAdapter({ fs, path, os });
  assert.deepEqual(await adapter.load({ workspaceRoot: ROOT }), []);
});

test('ohne geoeffneten Ordner bleibt nur die globale Ebene', async () => {
  const fs = makeFs({ [USER_FILE]: '- 2026-09-20 — Globale Sache.' });
  const adapter = createMemoryAdapter({ fs, path, os });
  const files = await adapter.load({ workspaceRoot: null });
  assert.deepEqual(files.map((f) => f.scope), [MEMORY_SCOPES.USER]);
});

test('zwei Ordner haben getrennte Gedaechtnisse', async () => {
  const other = path.resolve(path.join('/tmp', 'anderes'));
  const fs = makeFs({
    [WORKSPACE_FILE]: '- 2026-09-21 — Gehört zu projekt.',
    [path.join(other, '.agents', 'memory.md')]: '- 2026-09-21 — Gehört zu anderes.',
  });
  const adapter = createMemoryAdapter({ fs, path, os });
  const a = await adapter.load({ workspaceRoot: ROOT });
  const b = await adapter.load({ workspaceRoot: other });
  assert.match(a[0].text, /Gehört zu projekt/);
  assert.match(b[0].text, /Gehört zu anderes/);
});

test('gemerkt wird in die Datei der gewaehlten Ebene, samt Verzeichnis', async () => {
  const fs = makeFs();
  const adapter = createMemoryAdapter({ fs, path, os });
  const saved = await adapter.remember({
    scope: MEMORY_SCOPES.WORKSPACE,
    workspaceRoot: ROOT,
    text: 'Tests laufen mit npm test',
    origin: MEMORY_ORIGINS.REQUESTED,
  });
  assert.equal(saved.file, WORKSPACE_FILE);
  assert.match(fs.files[WORKSPACE_FILE], /- \d{4}-\d{2}-\d{2} — Tests laufen mit npm test/);
  assert.deepEqual(fs.made, [path.join(ROOT, '.agents')]);
  // Nichts landet in der globalen Datei, nur weil die Ordner-Ebene gemeint war.
  assert.equal(fs.files[USER_FILE], undefined);
});

test('die globale Ebene schreibt nach ~/.snotra, ohne Ordner', async () => {
  const fs = makeFs();
  const adapter = createMemoryAdapter({ fs, path, os });
  const saved = await adapter.remember({
    scope: MEMORY_SCOPES.USER,
    workspaceRoot: null,
    text: 'Anrede durchgängig Du',
    origin: MEMORY_ORIGINS.REQUESTED,
  });
  assert.equal(saved.file, USER_FILE);
  assert.match(fs.files[USER_FILE], /Anrede durchgängig Du/);
});

test('ohne geoeffneten Ordner gibt es kein Projekt-Gedaechtnis', async () => {
  const adapter = createMemoryAdapter({ fs: makeFs(), path, os });
  await assert.rejects(
    () =>
      adapter.remember({
        scope: MEMORY_SCOPES.WORKSPACE,
        workspaceRoot: null,
        text: 'irgendwas',
        origin: MEMORY_ORIGINS.REQUESTED,
      }),
    /kein Projekt-Gedächtnis/
  );
});

test('leerer Text, zu langer Eintrag und unbekannte Ebene werden abgelehnt', async () => {
  const adapter = createMemoryAdapter({ fs: makeFs(), path, os });
  const base = { scope: MEMORY_SCOPES.USER, origin: MEMORY_ORIGINS.REQUESTED };
  await assert.rejects(() => adapter.remember({ ...base, text: '   ' }), TypeError);
  await assert.rejects(
    () => adapter.remember({ ...base, text: 'x'.repeat(MAX_MEMORY_ENTRY_CHARS + 1) }),
    RangeError
  );
  await assert.rejects(() => adapter.remember({ scope: 'erfunden', text: 'x' }), TypeError);
});

test('ist die Datei voll, wird nicht geschrieben statt still zu kuerzen', async () => {
  const full = `- 2026-01-01 — ${'x'.repeat(MAX_MEMORY_CHARS - 20)}`;
  const fs = makeFs({ [USER_FILE]: full });
  const adapter = createMemoryAdapter({ fs, path, os });
  await assert.rejects(
    () =>
      adapter.remember({
        scope: MEMORY_SCOPES.USER,
        text: 'passt nicht mehr',
        origin: MEMORY_ORIGINS.REQUESTED,
      }),
    /voll/
  );
  assert.equal(fs.files[USER_FILE], full);
});

test('gelesen wird hoechstens die Obergrenze, und das steht dran', async () => {
  const fs = makeFs({ [USER_FILE]: 'x'.repeat(MAX_MEMORY_CHARS + 500) });
  const adapter = createMemoryAdapter({ fs, path, os });
  const [file] = await adapter.load({ workspaceRoot: null });
  assert.equal(file.text.length, MAX_MEMORY_CHARS);
  assert.equal(file.truncated, true);
});

test('gleichzeitige Merkvorgaenge ueberschreiben einander nicht', async () => {
  const fs = makeFs();
  const adapter = createMemoryAdapter({ fs, path, os });
  // Ohne Serialisierung laesen beide dieselbe leere Datei und der zweite
  // Schreibvorgang verschluckte den ersten — genau der Fall, den zwei
  // Chatfenster im selben Ordner erzeugen.
  await Promise.all(
    ['erster Eintrag', 'zweiter Eintrag', 'dritter Eintrag'].map((text) =>
      adapter.remember({ scope: MEMORY_SCOPES.USER, text, origin: MEMORY_ORIGINS.REQUESTED })
    )
  );
  const written = fs.files[USER_FILE];
  assert.match(written, /erster Eintrag/);
  assert.match(written, /zweiter Eintrag/);
  assert.match(written, /dritter Eintrag/);
});

test('ein gescheiterter Vorgang blockiert die Datei nicht dauerhaft', async () => {
  const fs = makeFs();
  const adapter = createMemoryAdapter({ fs, path, os });
  await assert.rejects(() =>
    adapter.remember({
      scope: MEMORY_SCOPES.USER,
      text: 'x'.repeat(MAX_MEMORY_ENTRY_CHARS + 1),
      origin: MEMORY_ORIGINS.REQUESTED,
    })
  );
  await adapter.remember({
    scope: MEMORY_SCOPES.USER,
    text: 'geht trotzdem',
    origin: MEMORY_ORIGINS.REQUESTED,
  });
  assert.match(fs.files[USER_FILE], /geht trotzdem/);
});

test('vergessen entfernt die Zeile und schreibt die Datei zurueck', async () => {
  const fs = makeFs({ [USER_FILE]: '# Kopf\n\n- 2026-09-19 — Eins.\n- 2026-09-21 — Zwei.\n' });
  const adapter = createMemoryAdapter({ fs, path, os });
  const result = await adapter.forget({ scope: MEMORY_SCOPES.USER, line: 2 });
  assert.equal(result.removed, true);
  assert.equal(fs.files[USER_FILE], '# Kopf\n\n- 2026-09-21 — Zwei.\n');
});

test('vergessen ohne Datei und ohne Treffer meldet schlicht nichts getan', async () => {
  const adapter = createMemoryAdapter({ fs: makeFs(), path, os });
  assert.deepEqual(await adapter.forget({ scope: MEMORY_SCOPES.USER, line: 3 }), { removed: false });
});

test('die Pfade sind ohne Lesen abfragbar', () => {
  const adapter = createMemoryAdapter({ fs: makeFs(), path, os });
  assert.deepEqual(adapter.paths({ workspaceRoot: ROOT }), {
    [MEMORY_SCOPES.WORKSPACE]: WORKSPACE_FILE,
    [MEMORY_SCOPES.USER]: USER_FILE,
  });
  assert.equal(adapter.paths({ workspaceRoot: null })[MEMORY_SCOPES.WORKSPACE], null);
});

test('ist selbstständiges Merken abgeschaltet, wird nichts geschrieben', async () => {
  const fs = makeFs();
  const adapter = createMemoryAdapter({ fs, path, os, isSelfMemoryAllowed: async () => false });
  await assert.rejects(
    () =>
      adapter.remember({
        scope: MEMORY_SCOPES.USER,
        text: 'faellt mir gerade auf',
        origin: MEMORY_ORIGINS.SELF,
      }),
    /abgeschaltet/
  );
  assert.equal(fs.files[USER_FILE], undefined);
  // Was der Nutzer ausdruecklich verlangt, geht weiterhin durch — der
  // Schalter betrifft nur den Eigenantrieb.
  await adapter.remember({
    scope: MEMORY_SCOPES.USER,
    text: 'das bitte merken',
    origin: MEMORY_ORIGINS.REQUESTED,
  });
  assert.match(fs.files[USER_FILE], /das bitte merken/);
});

test('der Schalter wird bei jedem Aufruf neu gelesen', async () => {
  let allowed = false;
  const fs = makeFs();
  const adapter = createMemoryAdapter({ fs, path, os, isSelfMemoryAllowed: async () => allowed });
  const entry = { scope: MEMORY_SCOPES.USER, text: 'Eigenantrieb', origin: MEMORY_ORIGINS.SELF };
  await assert.rejects(() => adapter.remember(entry));
  allowed = true;
  await adapter.remember(entry);
  assert.match(fs.files[USER_FILE], /Eigenantrieb/);
});
