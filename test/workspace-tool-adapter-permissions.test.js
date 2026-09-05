// Tool-Adapter mit Planung und Ausgabeprüfung (Issue #66): Plan aus der
// Registry, Versionsprüfung vor Ausführung, sensible Ausgaben, eigene
// Provider-Secrets, Wiederherstellungskopie und Neubewertung.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');

async function makeFixture(t, deps = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-adapter-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'projekt');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'a.js'), 'const a = 1;\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'config.md'), 'harmlos\napi_key = "abcdefgh12345678"\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'notes.md'), 'nur text\n', 'utf8');
  await fs.writeFile(path.join(workspace, '.env'), 'X=1\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'own.txt'), 'key: sk-own-provider-key-123456\n', 'utf8');
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  const registry = createWorkspaceToolRegistry({ fsService });
  const adapter = createWorkspaceToolAdapter(registry, { fsService, fs, path, ...deps });
  return { base, workspace, fsService, registry, adapter };
}

test('plan liefert Klassen und Ziele aus der Registry; unbekannte Tools werden als solche gemeldet', async (t) => {
  const { workspace, adapter } = await makeFixture(t);
  const plan = await adapter.plan('read_file_text', { relative_path: 'src/a.js' }, { workspaceRoot: workspace });
  assert.deepEqual(plan.riskClasses, ['read']);
  assert.equal(plan.targets[0].path, 'src/a.js');
  const unknown = await adapter.plan('shell', {}, { workspaceRoot: workspace });
  assert.equal(unknown.unknownTool, true);
  assert.equal(unknown.reason, 'unknown_tool');
});

test('ohne Dateisystem-Zugang (Registry-Stub) liefert plan nur die Mindestklasse', async () => {
  const registry = {
    getDefinition: (name) => (name === 'x' ? { name, riskClass: 'write' } : null),
    getTools: () => [],
    buildSystemPrompt: () => '',
    execute: async () => JSON.stringify({ ok: true }),
  };
  const adapter = createWorkspaceToolAdapter(registry);
  const plan = await adapter.plan('x', { a: 1 }, {});
  assert.deepEqual(plan.riskClasses, ['write']);
  assert.deepEqual(plan.targets, []);
  assert.ok(plan.planKey);
});

test('execute prüft die Zielversion aus dem Plan und führt bei Änderung nichts aus', async (t) => {
  const { workspace, adapter, registry } = await makeFixture(t);
  const args = { relative_path: 'src/a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' };
  const plan = await adapter.plan('edit_file', args, { workspaceRoot: workspace });
  await fs.writeFile(path.join(workspace, 'src', 'a.js'), 'const a = 1; // geändert\n', 'utf8');
  const result = await adapter.execute('edit_file', args, { workspaceRoot: workspace, approved: true, plan });
  assert.equal(result.invalidated, true);
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.error, 'permission_denied');
  assert.equal(parsed.reason, 'request_invalidated');
  assert.equal(await fs.readFile(path.join(workspace, 'src', 'a.js'), 'utf8'), 'const a = 1; // geändert\n');
  assert.ok(registry.getDefinition('edit_file'));
});

test('ohne approved führt der Adapter keinen Handler aus', async (t) => {
  const { workspace, adapter } = await makeFixture(t);
  const result = await adapter.execute('write_file_text', { relative_path: 'src/neu.md', content: 'x' }, { workspaceRoot: workspace });
  assert.equal(JSON.parse(result.output).reason, 'not_approved');
  await assert.rejects(fs.access(path.join(workspace, 'src', 'neu.md')));
});

test('zweite Prüfstelle: unauffälliger Pfad, sensibler Inhalt → Ausgabe als sensitive markiert', async (t) => {
  const { workspace, adapter } = await makeFixture(t);
  const plan = await adapter.plan('read_file_text', { relative_path: 'config.md' }, { workspaceRoot: workspace });
  assert.deepEqual(plan.riskClasses, ['read'], 'Pfad selbst ist unauffällig');
  const result = await adapter.execute('read_file_text', { relative_path: 'config.md' }, { workspaceRoot: workspace, approved: true, plan, riskClasses: plan.riskClasses });
  assert.equal(result.sensitive, true);
  assert.match(JSON.parse(result.output).content, /api_key/);

  const harmless = await adapter.execute('read_file_text', { relative_path: 'notes.md' }, { workspaceRoot: workspace, approved: true, plan: await adapter.plan('read_file_text', { relative_path: 'notes.md' }, { workspaceRoot: workspace }) });
  assert.equal(harmless.sensitive, undefined);
});

test('Ausschnitte umgehen die Prüfung nicht: die ganze Datei wird geprüft', async (t) => {
  const { workspace, adapter } = await makeFixture(t);
  const args = { relative_path: 'config.md', start_line: 1, end_line: 1 };
  const plan = await adapter.plan('read_file_lines', args, { workspaceRoot: workspace });
  const result = await adapter.execute('read_file_lines', args, { workspaceRoot: workspace, approved: true, plan });
  assert.equal(result.sensitive, true, 'Zeile 1 ist harmlos, Zeile 2 nicht — die Datei zählt');
  const outline = await adapter.execute('outline_file', { relative_path: 'config.md' }, { workspaceRoot: workspace, approved: true, plan: await adapter.plan('outline_file', { relative_path: 'config.md' }, { workspaceRoot: workspace }) });
  assert.equal(outline.sensitive, true);
});

test('zu große Quelldatei: keine ungeprüfte Ausgabe', async (t) => {
  const { workspace, adapter } = await makeFixture(t, { maxScanBytes: 8 });
  const plan = await adapter.plan('read_file_text', { relative_path: 'notes.md' }, { workspaceRoot: workspace });
  const result = await adapter.execute('read_file_text', { relative_path: 'notes.md' }, { workspaceRoot: workspace, approved: true, plan });
  assert.match(JSON.parse(result.output).error, /zu groß für die Prüfung/);
});

test('breite Suche lässt sensible Dateien und Trefferzeilen weg und meldet nur die Anzahl', async (t) => {
  const { workspace, adapter } = await makeFixture(t);
  const args = { query: 'key', relative_path: '.' , include_hidden: true };
  const plan = await adapter.plan('search_in_files', args, { workspaceRoot: workspace });
  const result = await adapter.execute('search_in_files', args, { workspaceRoot: workspace, approved: true, plan });
  const out = JSON.parse(result.output);
  assert.equal(out.matches.some((m) => m.file === '.env'), false, '.env wird als Datei ausgelassen');
  assert.equal(out.matches.some((m) => /abcdefgh12345678/.test(m.text)), false, 'Trefferzeile mit Zugangsdaten ausgelassen');
  assert.ok(out.omitted_sensitive >= 2, JSON.stringify(out));
  assert.equal(result.sensitive, undefined, 'Suchergebnis selbst enthält nichts Sensibles mehr');
});

test('eigene Provider-Schlüssel werden in jeder Ausgabe hart zurückgehalten', async (t) => {
  const { workspace, adapter } = await makeFixture(t, { readOwnSecrets: async () => ['sk-own-provider-key-123456'] });
  const plan = await adapter.plan('read_file_text', { relative_path: 'own.txt' }, { workspaceRoot: workspace });
  const result = await adapter.execute('read_file_text', { relative_path: 'own.txt' }, { workspaceRoot: workspace, approved: true, plan });
  assert.deepEqual(result.hardLimit, { reason: 'own_secret' });
  const parsed = JSON.parse(result.output);
  assert.equal(parsed.reason, 'own_secret');
  assert.equal(result.output.includes('sk-own-provider-key-123456'), false);
});

test('Überschreiben: Kopie in den Papierkorb → write mit Rückweg; Fehlschlag → Neubewertung als delete', async (t) => {
  const trashed = [];
  // Der Fake verhält sich wie shell.trashItem: die Kopie verschwindet aus dem Ordner.
  const { workspace, adapter } = await makeFixture(t, { trashItem: async (target) => { trashed.push(target); await fs.unlink(target); } });
  const args = { relative_path: 'src/a.js', content: 'neu\n' };
  const plan = await adapter.plan('write_file_text', args, { workspaceRoot: workspace });
  assert.deepEqual(plan.riskClasses, ['write']);
  assert.equal(plan.recovery, 'trash');
  const result = await adapter.execute('write_file_text', args, { workspaceRoot: workspace, approved: true, plan, riskClasses: plan.riskClasses });
  const out = JSON.parse(result.output);
  assert.equal(out.overwritten, true);
  assert.match(out.recovery_copy_in_trash, /^a\.js\.snotra-backup-/);
  assert.equal(trashed.length, 1);
  assert.equal(await fs.readFile(path.join(workspace, 'src', 'a.js'), 'utf8'), 'neu\n');
  assert.equal(result.progressEvents.length, 1);
  const leftovers = (await fs.readdir(path.join(workspace, 'src'))).filter((n) => n.includes('snotra-backup'));
  assert.deepEqual(leftovers, [], 'Kopie liegt im Papierkorb, nicht im Ordner (hier: vom Fake entfernt)');

  const failing = createWorkspaceToolAdapter(
    createWorkspaceToolRegistry({ fsService: createFsService({ fs, path, maxReadFileBytes: 1024, maxWriteFileBytes: 1024 }) }),
    { fsService: createFsService({ fs, path, maxReadFileBytes: 1024, maxWriteFileBytes: 1024 }), fs, path, trashItem: async () => { throw new Error('kein Papierkorb'); } }
  );
  const plan2 = await failing.plan('write_file_text', args, { workspaceRoot: workspace });
  const reclassified = await failing.execute('write_file_text', args, { workspaceRoot: workspace, approved: true, plan: plan2, riskClasses: plan2.riskClasses });
  assert.deepEqual(reclassified.reclassify, ['delete']);
  assert.equal(await fs.readFile(path.join(workspace, 'src', 'a.js'), 'utf8'), 'neu\n', 'nicht erneut geschrieben');
  const noLeftovers = (await fs.readdir(path.join(workspace, 'src'))).filter((n) => n.includes('snotra-backup'));
  assert.deepEqual(noLeftovers, [], 'liegen gebliebene Kopie wurde entfernt');

  // Als delete freigegeben: Überschreiben ohne Kopie ist erlaubt.
  const asDelete = await failing.execute('write_file_text', { ...args, content: 'ganz neu\n' }, { workspaceRoot: workspace, approved: true, plan: plan2, riskClasses: ['delete'] });
  assert.equal(JSON.parse(asDelete.output).overwritten, true);
  assert.equal(asDelete.reclassify, undefined);
});
