const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createSkillsService } = require('../src/main/services/skills-service');
const { SKILL_SOURCES, SKILL_STATUS } = require('../src/shared/contracts/skills');

async function makeTempTree(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-skills-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeSkill(baseDir, dirName, { name = dirName, description = 'Beschreibung', body = 'Anweisung.' } = {}) {
  const skillDir = path.join(baseDir, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  const frontmatter = ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n');
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), frontmatter, 'utf8');
  return skillDir;
}

/** Home-Verzeichnis wegzeigen, damit echte ~/.claude/skills nicht in die Tests lecken. */
function makeService({ systemSkillsDir = null, home }) {
  return createSkillsService({
    fs,
    path,
    os: { homedir: () => home },
    systemSkillsDir,
  });
}

test('findet System-Skills auch ohne geöffneten Ordner', async (t) => {
  const root = await makeTempTree(t);
  const systemDir = path.join(root, 'system-skills');
  await writeSkill(systemDir, 'snotra-capabilities', { description: 'Auskunft über die App' });
  const service = makeService({ systemSkillsDir: systemDir, home: path.join(root, 'home') });

  const { skills } = await service.listCatalog({});

  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'snotra-capabilities');
  assert.equal(skills[0].source, SKILL_SOURCES.SYSTEM);
  // Voreinstellung: System-Skills sind an, ohne dass etwas gespeichert wurde.
  assert.equal(skills[0].status, SKILL_STATUS.ACTIVE);
});

test('liest Ordner-Skills aus Workspace und Home, aber schaltet sie nicht ein', async (t) => {
  const root = await makeTempTree(t);
  const workspace = path.join(root, 'ws');
  const home = path.join(root, 'home');
  await writeSkill(path.join(workspace, '.agents', 'skills'), 'ws-agents');
  await writeSkill(path.join(workspace, '.claude', 'skills'), 'ws-claude');
  await writeSkill(path.join(home, '.agents', 'skills'), 'home-agents');
  await writeSkill(path.join(home, '.claude', 'skills'), 'home-claude');
  const service = makeService({ home });

  const { skills } = await service.listCatalog({ workspaceRoot: workspace });

  assert.deepEqual(
    skills.map((skill) => [skill.name, skill.source, skill.status]),
    [
      ['ws-agents', SKILL_SOURCES.WORKSPACE_AGENTS, SKILL_STATUS.AVAILABLE],
      ['ws-claude', SKILL_SOURCES.WORKSPACE_CLAUDE, SKILL_STATUS.AVAILABLE],
      ['home-agents', SKILL_SOURCES.USER_AGENTS, SKILL_STATUS.AVAILABLE],
      ['home-claude', SKILL_SOURCES.USER_CLAUDE, SKILL_STATUS.AVAILABLE],
    ]
  );
  assert.deepEqual(await service.getActiveSkills({ workspaceRoot: workspace }), []);
});

test('gleicher Name mehrfach: der höher priorisierte Fund gewinnt', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  const winnerDir = await writeSkill(path.join(workspace, '.agents', 'skills'), 'doppelt', { body: 'Workspace' });
  await writeSkill(path.join(home, '.claude', 'skills'), 'doppelt', { body: 'Home' });
  const service = makeService({ home });

  const { skills } = await service.listCatalog({
    workspaceRoot: workspace,
    activeSkills: ['doppelt'],
  });

  assert.equal(skills[0].status, SKILL_STATUS.ACTIVE);
  assert.equal(skills[1].status, SKILL_STATUS.SHADOWED);
  assert.match(skills[1].detail, /Überdeckt von/);
  assert.ok(skills[1].detail.includes(winnerDir));

  const active = await service.getActiveSkills({ workspaceRoot: workspace, activeSkills: ['doppelt'] });
  assert.equal(active.length, 1);
  assert.equal(active[0].body, 'Workspace');
});

test('ein Ordner-Skill kann einen System-Skill nicht verdrängen', async (t) => {
  const root = await makeTempTree(t);
  const systemDir = path.join(root, 'system-skills');
  const workspace = path.join(root, 'ws');
  await writeSkill(systemDir, 'snotra-capabilities', { body: 'Echt' });
  await writeSkill(path.join(workspace, '.agents', 'skills'), 'snotra-capabilities', { body: 'Untergeschoben' });
  const service = makeService({ systemSkillsDir: systemDir, home: path.join(root, 'home') });

  const active = await service.getActiveSkills({ workspaceRoot: workspace });

  assert.equal(active.length, 1);
  assert.equal(active[0].source, SKILL_SOURCES.SYSTEM);
  assert.equal(active[0].body, 'Echt');
});

test('meldet ungültige Einträge mit Grund, statt den Scan abzubrechen', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  const skillsDir = path.join(home, '.agents', 'skills');
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(path.join(skillsDir, 'paket.zip'), 'binär', 'utf8');
  await fs.mkdir(path.join(skillsDir, 'ohne-datei'), { recursive: true });
  await fs.mkdir(path.join(skillsDir, 'ohne-frontmatter'), { recursive: true });
  await fs.writeFile(path.join(skillsDir, 'ohne-frontmatter', 'SKILL.md'), '# Nur Text', 'utf8');
  await writeSkill(skillsDir, 'namens-mismatch', { name: 'anders' });
  await writeSkill(skillsDir, 'heil');
  const service = makeService({ home });

  const { skills } = await service.listCatalog({});
  const byName = Object.fromEntries(skills.map((skill) => [skill.name, skill]));

  assert.equal(byName['paket.zip'].detail, 'Kein Verzeichnis');
  assert.equal(byName['ohne-datei'].detail, 'SKILL.md fehlt');
  assert.equal(byName['ohne-frontmatter'].detail, 'Kein YAML-Frontmatter');
  assert.match(byName['namens-mismatch'].detail, /≠ Verzeichnis/);
  for (const name of ['paket.zip', 'ohne-datei', 'ohne-frontmatter', 'namens-mismatch']) {
    assert.equal(byName[name].status, SKILL_STATUS.INVALID);
  }
  assert.equal(byName.heil.status, SKILL_STATUS.AVAILABLE);
});

test('leere Auswahl schaltet auch die System-Skills ab', async (t) => {
  const root = await makeTempTree(t);
  const systemDir = path.join(root, 'system-skills');
  await writeSkill(systemDir, 'snotra-capabilities');
  const service = makeService({ systemSkillsDir: systemDir, home: path.join(root, 'home') });

  assert.deepEqual(await service.getActiveSkills({ activeSkills: [] }), []);
  const { skills } = await service.listCatalog({ activeSkills: [] });
  assert.equal(skills[0].status, SKILL_STATUS.AVAILABLE);
});

test('fehlende Verzeichnisse sind kein Fehler', async (t) => {
  const root = await makeTempTree(t);
  const service = makeService({
    systemSkillsDir: path.join(root, 'gibts-nicht'),
    home: path.join(root, 'auch-nicht'),
  });

  assert.deepEqual(await service.listCatalog({ workspaceRoot: path.join(root, 'weg') }), { skills: [] });
});

test('scannt erst nach reload() erneut', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  const skillsDir = path.join(home, '.agents', 'skills');
  await writeSkill(skillsDir, 'erst-da');
  const service = makeService({ home });

  assert.equal((await service.listCatalog({})).skills.length, 1);
  await writeSkill(skillsDir, 'spaeter-da');
  assert.equal((await service.listCatalog({})).skills.length, 1, 'Cache greift');

  service.reload();
  assert.equal((await service.listCatalog({})).skills.length, 2);
});

test('kürzt überlange Bodies auf das Zeichenbudget', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  await writeSkill(path.join(home, '.agents', 'skills'), 'lang', { body: 'x'.repeat(500) });
  const service = createSkillsService({ fs, path, os: { homedir: () => home }, maxSkillBodyChars: 100 });

  const active = await service.getActiveSkills({ activeSkills: ['lang'] });
  assert.equal(active[0].body.length, 100);
});
