const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createMemoryAdapter } = require('../src/main/adapters/memory-adapter');
const { createMemoryFs } = require('./helpers/memory-fs');
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

const OTHER = path.resolve(path.join('/tmp', 'anderes'));

function makeFs(files = {}) {
  return createMemoryFs(files, { dirs: [HOME, ROOT, OTHER] });
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
  const other = OTHER;
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
    /no project memory/
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
    /full/
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
  const result = await adapter.forget({ scope: MEMORY_SCOPES.USER, line: 2, text: 'Eins.' });
  assert.equal(result.removed, true);
  assert.equal(fs.files[USER_FILE], '# Kopf\n\n- 2026-09-21 — Zwei.\n');
});

test('two quick forgets remove exactly the two clicked entries (#577)', async () => {
  const fs = makeFs({
    [USER_FILE]: '# Kopf\n\n- 2026-09-19 — A\n- 2026-09-19 — B\n- 2026-09-19 — C\n- 2026-09-19 — D\n',
  });
  const adapter = createMemoryAdapter({ fs, path, os });
  // Both line numbers come from the same rendered list; the second request
  // arrives before the first has answered. By line number alone the second
  // one would remove D, which moved up into C's line.
  const results = await Promise.all([
    adapter.forget({ scope: MEMORY_SCOPES.USER, line: 3, text: 'B' }),
    adapter.forget({ scope: MEMORY_SCOPES.USER, line: 4, text: 'C' }),
  ]);
  assert.deepEqual(results.map((r) => r.removed), [true, true]);
  assert.equal(fs.files[USER_FILE], '# Kopf\n\n- 2026-09-19 — A\n- 2026-09-19 — D\n');
});

test('an entry that is gone is not replaced by another one (#577)', async () => {
  const before = '# Kopf\n\n- 2026-09-19 — A\n- 2026-09-19 — C\n';
  const fs = makeFs({ [USER_FILE]: before });
  const adapter = createMemoryAdapter({ fs, path, os });
  assert.deepEqual(await adapter.forget({ scope: MEMORY_SCOPES.USER, line: 2, text: 'B' }), { removed: false });
  assert.equal(fs.files[USER_FILE], before);
});

test('a failed read does not let remember replace the file with the new entry (#534)', async () => {
  const fs = makeFs({ [USER_FILE]: Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) });
  const adapter = createMemoryAdapter({ fs, path, os, platform: 'linux' });
  await assert.rejects(() =>
    adapter.remember({ scope: MEMORY_SCOPES.USER, text: 'neu', origin: MEMORY_ORIGINS.REQUESTED })
  );
  assert.ok(fs.files[USER_FILE] instanceof Error, 'the file was not written over');
});

test('a new file gets its heading and marker in the interface language (#579)', async () => {
  const fs = makeFs();
  const en = createMemoryAdapter({ fs, path, os, getLocale: () => 'en' });
  await en.remember({ scope: MEMORY_SCOPES.USER, text: 'eins', origin: MEMORY_ORIGINS.SELF });
  assert.match(fs.files[USER_FILE], /^# Memory · global\n\n- \d{4}-\d{2}-\d{2} \(remembered on its own\) — eins\n$/);
  const de = createMemoryAdapter({ fs, path, os, getLocale: () => 'de' });
  await de.remember({ scope: MEMORY_SCOPES.WORKSPACE, workspaceRoot: ROOT, text: 'zwei', origin: MEMORY_ORIGINS.SELF });
  assert.match(fs.files[WORKSPACE_FILE], /^# Gedächtnis · Projekt\n\n- \d{4}-\d{2}-\d{2} \(selbst gemerkt\) — zwei\n$/);
});

test('vergessen ohne Datei und ohne Treffer meldet schlicht nichts getan', async () => {
  const adapter = createMemoryAdapter({ fs: makeFs(), path, os });
  assert.deepEqual(await adapter.forget({ scope: MEMORY_SCOPES.USER, line: 3, text: 'x' }), { removed: false });
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
    /switched off/
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
