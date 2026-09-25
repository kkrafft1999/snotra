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
 * Skill-Ordner an, wie er unter ~/.agents/skills/<name>/ läge.
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
  assert.match(outside.error, /outside the workspace folder/);
});

test('Skill-Pfade brechen nicht aus dem Skill-Verzeichnis aus', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  for (const rel of ['skill:demo/../../geheim.txt', 'skill:demo/references/../../../geheim.txt']) {
    const out = JSON.parse(await svc.runReadFileTextTool({ relative_path: rel }, workspace, { skillRoots }));
    assert.match(out.error, /outside the skill folder/, rel);
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
  assert.match(out.error, /outside the skill folder/);
});

test('Unbekannte oder fehlende Skills liefern eine sprechende Meldung', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const unknown = JSON.parse(
    await svc.runReadFileTextTool({ relative_path: 'skill:fehlt/a.md' }, workspace, { skillRoots })
  );
  assert.match(unknown.error, /Unknown skill/);
  assert.match(unknown.error, /demo/, 'die eingeschalteten Skills werden genannt');

  const none = JSON.parse(
    await svc.runReadFileTextTool({ relative_path: 'skill:demo/a.md' }, workspace, { skillRoots: [] })
  );
  assert.match(none.error, /no skill is switched on/i);
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
  assert.match(written.error, /only work with the read tools/);

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
  assert.match(write.error, /only work with the read tools/);
});

// ---------------------------------------------------------------------------
// Nachladen der Anleitung auf Abruf (Issue #173)
// ---------------------------------------------------------------------------

test('load_skill liefert die Anleitung ohne Frontmatter', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const out = JSON.parse(await svc.runLoadSkillTool({ name: 'demo' }, workspace, { skillRoots }));
  assert.equal(out.error, undefined);
  assert.equal(out.skill, 'demo');
  assert.equal(out.truncated, false);
  assert.equal(out.instructions, 'Siehe references/.');
  // Das Frontmatter kennt das Modell schon aus der Kurzliste im Prompt.
  assert.equal(out.instructions.includes('name: demo'), false);
});

test('load_skill braucht keinen geöffneten Ordner', async (t) => {
  const { base, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const out = JSON.parse(await svc.runLoadSkillTool({ name: 'demo' }, null, { skillRoots }));
  assert.equal(out.instructions, 'Siehe references/.');
});

test('load_skill weist unbekannte, leere und ungültige Namen ab', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  const unknown = JSON.parse(await svc.runLoadSkillTool({ name: 'fehlt' }, workspace, { skillRoots }));
  assert.match(unknown.error, /Unknown skill/);
  assert.match(unknown.error, /demo/, 'die eingeschalteten Skills werden genannt');

  const empty = JSON.parse(await svc.runLoadSkillTool({}, workspace, { skillRoots }));
  assert.match(empty.error, /name is required/);

  // Ein Pfad im Namen darf nicht zu einer zweiten Adressierungsform werden.
  const escape = JSON.parse(
    await svc.runLoadSkillTool({ name: '../geheim' }, workspace, { skillRoots })
  );
  assert.match(escape.error, /Not a valid skill name/);
});

test('load_skill meldet eine SKILL.md ohne Anleitung, statt leer zu antworten', async (t) => {
  const { base, workspace, skillDir, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const svc = makeFsService();

  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\n---\n\n   \n', 'utf8');
  const leer = JSON.parse(await svc.runLoadSkillTool({ name: 'demo' }, workspace, { skillRoots }));
  assert.match(leer.error, /has no instructions/);

  await fs.writeFile(path.join(skillDir, 'SKILL.md'), 'Nur Text, kein Frontmatter.\n', 'utf8');
  const ohneFrontmatter = JSON.parse(
    await svc.runLoadSkillTool({ name: 'demo' }, workspace, { skillRoots })
  );
  assert.match(ohneFrontmatter.error, /YAML front matter/);
});

test('load_skill läuft über die Registry als Skill-Schritt, nicht als Dateizugriff', async (t) => {
  const { base, workspace, skillRoots } = await makeFixture();
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const registry = createWorkspaceToolRegistry({ fsService: makeFsService() });

  const out = JSON.parse(
    await registry.execute('load_skill', { name: 'demo' }, {
      workspaceRoot: workspace,
      skillRoots,
      approved: true,
    })
  );
  assert.equal(out.instructions, 'Siehe references/.');

  // Das Ziel ist der übliche „skill:“-Pfad — davon hängen Freigabekarte,
  // Verlaufszeile und Schreibschutz ab (#61).
  const definition = registry.getDefinition('load_skill');
  assert.deepEqual(definition.targets({ name: 'demo' }), [
    { path: 'skill:demo/SKILL.md', kind: 'file', access: 'read' },
  ]);
  assert.equal(definition.riskClass, 'read');
  assert.equal(definition.requiresWorkspace, false);
  assert.equal(definition.requiresSkills, true);
});

test('load_skill trägt die eingeschalteten Skills als enum im Schema (#173)', () => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsService() });
  const schemaFor = (options) =>
    registry.getTools(options).find((tool) => tool.function.name === 'load_skill');

  // Gemessen mit llama3.1:8b: ohne enum erfindet ein kleines Modell bei langer
  // Skill-Liste Namen und lädt nichts. Mit enum wählt es aus der Liste.
  assert.deepEqual(schemaFor({ skillNames: ['demo', 'traffic'] }).function.parameters, {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Name of the skill, exactly as in the list of skills that are switched on.',
        enum: ['demo', 'traffic'],
      },
    },
    required: ['name'],
  });

  // Ohne Angabe kein enum — die Argumentprüfung darf nicht am Anfragezustand hängen.
  assert.equal(schemaFor({}).function.parameters.properties.name.enum, undefined);
  assert.equal(registry.getDefinition('load_skill').parameters.properties.name.enum, undefined);

  // Leere Liste heißt „kein Skill eingeschaltet“ — dann fällt das Tool weg.
  assert.equal(schemaFor({ skillNames: [] }), undefined);
});
