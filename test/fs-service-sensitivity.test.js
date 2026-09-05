// Dateisystem-Service (Issue #66): Auslassen sensibler Einträge in Listen und
// Suchen, Patch-Ziele für den Planer, Wiederherstellungskopie beim Überschreiben.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createSensitivePathMatcher } = require('../src/shared/runtime/sensitive-paths');
const { scanSensitiveContent } = require('../src/shared/runtime/sensitive-content');

function makeSensitivity() {
  const matcher = createSensitivePathMatcher();
  return {
    isSensitivePath: (p) => matcher.isSensitivePath(p),
    isSensitiveLine: (text) => scanSensitiveContent(text).sensitive,
  };
}

async function makeFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-sens-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'keys'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.js'), 'const key = "x";\n', 'utf8');
  await fs.writeFile(path.join(root, 'keys', 'server.key'), 'key material\n', 'utf8');
  await fs.writeFile(path.join(root, 'credentials.json'), '{"key": 1}\n', 'utf8');
  await fs.writeFile(path.join(root, 'config.md'), 'key note\napi_key = "abcdefgh12345678"\n', 'utf8');
  const svc = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  return { root, svc };
}

test('list_directory lässt sensible Einträge weg und zählt sie', async (t) => {
  const { root, svc } = await makeFixture(t);
  const out = JSON.parse(await svc.runListDirectoryTool({ relative_path: '.' }, root, { sensitivity: makeSensitivity() }));
  assert.deepEqual(out.items.map((i) => i.name), ['keys', 'src', 'config.md']);
  assert.equal(out.omitted_sensitive, 1);
  const plain = JSON.parse(await svc.runListDirectoryTool({ relative_path: '.' }, root));
  assert.equal(plain.omitted_sensitive, undefined, 'ohne Sensitivität wie bisher');
  assert.equal(plain.items.some((i) => i.name === 'credentials.json'), true);
});

test('find_files und list_directory_tree lassen sensible Dateien weg', async (t) => {
  const { root, svc } = await makeFixture(t);
  const found = JSON.parse(await svc.runFindFilesTool({ pattern: '**/*' }, root, { sensitivity: makeSensitivity() }));
  const paths = found.results.map((r) => r.path);
  assert.equal(paths.includes('keys/server.key'), false);
  assert.equal(paths.includes('credentials.json'), false);
  assert.equal(paths.includes('src/a.js'), true);
  assert.equal(found.omitted_sensitive, 2);

  const tree = JSON.parse(await svc.runListDirectoryTreeTool({}, root, { sensitivity: makeSensitivity() }));
  assert.doesNotMatch(tree.tree, /server\.key|credentials\.json/);
  assert.match(tree.tree, /a\.js/);
  assert.equal(tree.omitted_sensitive, 2);
});

test('search_in_files überspringt sensible Dateien und Trefferzeilen mit Zugangsdaten', async (t) => {
  const { root, svc } = await makeFixture(t);
  const out = JSON.parse(await svc.runSearchInFilesTool({ query: 'key' }, root, { sensitivity: makeSensitivity() }));
  const files = out.matches.map((m) => m.file);
  assert.equal(files.includes('keys/server.key'), false);
  assert.equal(files.includes('credentials.json'), false);
  assert.equal(files.includes('src/a.js'), true);
  // Die harmlose Zeile trägt die Zugangsdaten als Kontextzeile mit — auch sie
  // bleibt draußen, damit der Kontext das Geheimnis nicht durch die Hintertür liefert.
  assert.equal(files.filter((f) => f === 'config.md').length, 0);
  assert.equal(JSON.stringify(out).includes('abcdefgh12345678'), false);
  assert.ok(out.omitted_sensitive >= 4, JSON.stringify(out));

  const single = JSON.parse(await svc.runSearchInFilesTool({ query: 'key', relative_path: 'keys/server.key' }, root, { sensitivity: makeSensitivity() }));
  assert.deepEqual(single.matches, []);
  assert.equal(single.omitted_sensitive, 1);
});

test('listApplyPatchTargets nennt alle Ziele oder den Parse-Fehler', async (t) => {
  const { svc } = await makeFixture(t);
  assert.deepEqual(svc.listApplyPatchTargets({ relative_path: 'a.js', edits: [] }), ['a.js']);
  assert.deepEqual(svc.listApplyPatchTargets({ edits: [] }), []);
  const patch = ['--- a/x.js', '+++ b/x.js', '@@ -1,1 +1,1 @@', '-a', '+b', '--- a/y.js', '+++ b/y.js', '@@ -1,1 +1,1 @@', '-c', '+d', ''].join('\n');
  assert.deepEqual(svc.listApplyPatchTargets({ patch }), ['x.js', 'y.js']);
  assert.match(svc.listApplyPatchTargets({ patch: 'kaputt' }).error, /./);
  assert.match(svc.listApplyPatchTargets({ patch: '  ' }).error, /erforderlich/);
});

test('write_file_text: Wiederherstellungskopie, Fehlschlag ohne Freigabe, Überschreiben als delete', async (t) => {
  const { root, svc } = await makeFixture(t);
  const target = path.join(root, 'src', 'a.js');
  const trashed = [];
  const trashItem = async (p) => {
    trashed.push(p);
    await fs.unlink(p);
  };

  const ok = JSON.parse(await svc.runWriteFileTextTool({ relative_path: 'src/a.js', content: 'v2\n' }, root, { recovery: { trashItem } }));
  assert.equal(ok.overwritten, true);
  assert.match(ok.recovery_copy_in_trash, /^a\.js\.snotra-backup-\d{4}-\d{2}-\d{2}T/);
  assert.equal(trashed.length, 1);
  assert.equal(path.dirname(trashed[0]), path.join(root, 'src'), 'Kopie entsteht neben der Datei');
  assert.equal(await fs.readFile(target, 'utf8'), 'v2\n');

  const failed = JSON.parse(
    await svc.runWriteFileTextTool({ relative_path: 'src/a.js', content: 'v3\n' }, root, {
      recovery: { trashItem: async () => { throw new Error('nope'); } },
    })
  );
  assert.equal(failed.code, 'recovery_failed');
  assert.match(failed.error, /Papierkorb/);
  assert.equal(await fs.readFile(target, 'utf8'), 'v2\n', 'nicht geschrieben');
  assert.deepEqual((await fs.readdir(path.join(root, 'src'))).filter((n) => n.includes('backup')), []);

  const noTrash = JSON.parse(await svc.runWriteFileTextTool({ relative_path: 'src/a.js', content: 'v3\n' }, root, { recovery: { trashItem: null } }));
  assert.equal(noTrash.code, 'recovery_failed');

  const asDelete = JSON.parse(
    await svc.runWriteFileTextTool({ relative_path: 'src/a.js', content: 'v4\n' }, root, {
      recovery: { trashItem: null, allowUnrecoverable: true },
    })
  );
  assert.equal(asDelete.overwritten, true);
  assert.equal(asDelete.recovery_copy_in_trash, undefined);
  assert.equal(await fs.readFile(target, 'utf8'), 'v4\n');

  // Neue Datei braucht keine Kopie.
  const created = JSON.parse(await svc.runWriteFileTextTool({ relative_path: 'src/neu.md', content: 'x' }, root, { recovery: { trashItem: null } }));
  assert.equal(created.created, true);
});
