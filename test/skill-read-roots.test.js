// Lese-Zugriff auf Verzeichnisse eingeschalteter Skills (Issue #61).
// Prüft die zweite Lesewurzel: Auflösung, Anzeige, Ausbruchsschutz und die
// Grenze zu den Schreib-Tools.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { parseSkillPath, formatSkillPath } = require('../src/shared/runtime/skill-path');

function makeFsService() {
  return createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
}

async function createSymlinkOrSkip(t, target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) {
      t.skip(`Symlinks werden auf dieser Plattform nicht unterstützt: ${e.code}`);
      return false;
    }
    throw e;
  }
}

/**
 * Legt einen Arbeitsordner und daneben — bewusst ausserhalb — einen
 * Skill-Ordner an, wie er unter ~/.claude/skills/<name>/ läge.
 */
async function makeFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-skill-roots-'));
  const workspace = path.join(base, 'projekt');
  const skillDir = path.join(base, 'skills', 'demo');
  await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'app.js'), 'const a = 1;\n', 'utf8');
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n\nSiehe references/.\n', 'utf8');
  await fs.writeFile(
    path.join(skillDir, 'references', 'anleitung.md'),
    '# Anleitung\n\nSchritt eins: Nadelöhr prüfen.\n',
    'utf8'
  );
  await fs.writeFile(path.join(base, 'geheim.txt'), 'nicht lesbar\n', 'utf8');
  return { base, workspace, skillDir, skillRoots: [{ name: 'demo', dir: skillDir }] };
}

test('parseSkillPath trennt Skill-Name und Restpfad', () => {
  assert.deepEqual(parseSkillPath('skill:demo/references/a.md'), { name: 'demo', rest: 'references/a.md' });
  assert.deepEqual(parseSkillPath('skill:demo'), { name: 'demo', rest: '' });
  assert.deepEqual(parseSkillPath('  skill:demo/a.md  '), { name: 'demo', rest: 'a.md' });
  assert.equal(parseSkillPath('src/index.js'), null);
  assert.equal(parseSkillPath('skill:'), null);
  assert.equal(parseSkillPath(null), null);
  assert.equal(formatSkillPath('demo', 'references/a.md'), 'skill:demo/references/a.md');
  assert.equal(formatSkillPath('demo'), 'skill:demo');
});

test('read_file_text liest eine Datei aus dem Verzeichnis eines eingeschalteten Skills', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const out = JSON.parse(
    await svc.runReadFileTextTool(
      { relative_path: 'skill:demo/references/anleitung.md' },
      workspace,
      { skillRoots }
    )
  );
  assert.equal(out.error, undefined);
  assert.match(out.content, /Nadelöhr/);
  assert.equal(out.relative_path, 'skill:demo/references/anleitung.md');
});

test('Lese-Tools bleiben ohne Präfix auf dem Arbeitsordner', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const ok = JSON.parse(
    await svc.runReadFileTextTool({ relative_path: 'app.js' }, workspace, { skillRoots })
  );
  assert.match(ok.content, /const a = 1/);

  const outside = JSON.parse(
    await svc.runReadFileTextTool({ relative_path: '../geheim.txt' }, workspace, { skillRoots })
  );
  assert.match(outside.error, /außerhalb des Arbeitsordners/);
});

test('Skill-Pfade brechen nicht aus dem Skill-Verzeichnis aus', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  for (const rel of ['skill:demo/../../geheim.txt', 'skill:demo/references/../../../geheim.txt']) {
    const out = JSON.parse(await svc.runReadFileTextTool({ relative_path: rel }, workspace, { skillRoots }));
    assert.match(out.error, /außerhalb des Skill-Ordners/, rel);
  }
});

test('Ein Symlink aus dem Skill-Verzeichnis heraus wird abgewiesen', async (t) => {
  const { base, workspace, skillDir, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const linked = await createSymlinkOrSkip(
    t,
    path.join(base, 'geheim.txt'),
    path.join(skillDir, 'raus.txt'),
    'file'
  );
  if (!linked) return;
  const svc = makeFsService();

  const out = JSON.parse(
    await svc.runReadFileTextTool({ relative_path: 'skill:demo/raus.txt' }, workspace, { skillRoots })
  );
  assert.match(out.error, /außerhalb des Skill-Ordners/);
});

test('Unbekannte oder fehlende Skills liefern eine sprechende Meldung', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const unknown = JSON.parse(
    await svc.runReadFileTextTool({ relative_path: 'skill:fehlt/a.md' }, workspace, { skillRoots })
  );
  assert.match(unknown.error, /Unbekannter Skill/);
  assert.match(unknown.error, /demo/, 'die eingeschalteten Skills werden genannt');

  const none = JSON.parse(
    await svc.runReadFileTextTool({ relative_path: 'skill:demo/a.md' }, workspace, { skillRoots: [] })
  );
  assert.match(none.error, /kein Skill eingeschaltet/i);
});

test('Schreib-Tools erreichen kein Skill-Verzeichnis', async (t) => {
  const { base, workspace, skillDir } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const written = JSON.parse(
    await svc.runWriteFileTextTool(
      { relative_path: 'skill:demo/references/anleitung.md', content: 'überschrieben' },
      workspace
    )
  );
  assert.match(written.error, /nur mit den Lese-Tools/);

  // Weder im Skill noch als Datei mit dem wörtlichen Namen „skill:demo“.
  const original = await fs.readFile(path.join(skillDir, 'references', 'anleitung.md'), 'utf8');
  assert.match(original, /Nadelöhr/);
  const entries = await fs.readdir(workspace);
  assert.deepEqual(entries, ['app.js']);
});

test('search_in_files und find_files liefern Treffer mit skill:-Präfix zurück', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const found = JSON.parse(
    await svc.runSearchInFilesTool(
      { query: 'Nadelöhr', relative_path: 'skill:demo' },
      workspace,
      { skillRoots }
    )
  );
  assert.equal(found.error, undefined);
  assert.deepEqual(
    found.matches.map((m) => m.file),
    ['skill:demo/references/anleitung.md']
  );

  const files = JSON.parse(
    await svc.runFindFilesTool({ pattern: '**/*.md', relative_path: 'skill:demo' }, workspace, { skillRoots })
  );
  assert.deepEqual(
    files.results.map((r) => r.path).sort(),
    ['skill:demo/SKILL.md', 'skill:demo/references/anleitung.md']
  );
});

test('list_directory und list_directory_tree zeigen den Skill-Ordner', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const listed = JSON.parse(
    await svc.runListDirectoryTool({ relative_path: 'skill:demo' }, workspace, { skillRoots })
  );
  assert.deepEqual(
    listed.items.map((i) => i.name).sort(),
    ['SKILL.md', 'references']
  );

  const tree = JSON.parse(
    await svc.runListDirectoryTreeTool({ relative_path: 'skill:demo' }, workspace, { skillRoots })
  );
  assert.match(tree.tree, /references\//);
  assert.match(tree.tree, /anleitung\.md/);
});

test('Die Registry gibt Skill-Wurzeln nur an Lese-Tools weiter', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const registry = createWorkspaceToolRegistry({ fsService: makeFsService() });
  // `approved` steht fuer die Policy-Freigabe der Engine (Issue #66); hier
  // zaehlt nur, dass Schreib-Tools strukturell keine Skill-Wurzeln sehen.
  const context = { workspaceRoot: workspace, skillRoots, approved: true };

  const read = JSON.parse(
    await registry.execute('read_file_text', { relative_path: 'skill:demo/references/anleitung.md' }, context)
  );
  assert.match(read.content, /Nadelöhr/);

  const write = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'skill:demo/references/anleitung.md', content: 'nein' },
      context
    )
  );
  assert.match(write.error, /nur mit den Lese-Tools/);
});
