const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createSkillsService } = require('../src/main/services/skills-service');
const { translateMessage } = require('../src/shared/i18n');

// The service hands over keys since #353; the German wording is checked through
// the catalogue.
const de = (message) => translateMessage('de', message);
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

/** Home-Verzeichnis wegzeigen, damit echte ~/.agents/skills nicht in die Tests lecken. */
function makeService({ systemSkillsDir = null, home }) {
  return createSkillsService({
    fs,
    path,
    os: { homedir: () => home },
    systemSkillsDir,
  });
}

/**
 * A system skill names settings pages so the model can point the user at one.
 * The quotation follows the interface language (#294) — and only in the app's
 * own skills: a folder skill is somebody else's text and is passed through
 * exactly as written.
 */
test('Menüpfade im System-Skill folgen der Sprache, im Ordner-Skill nicht', async (t) => {
  const root = await makeTempTree(t);
  const systemDir = path.join(root, 'system-skills');
  const home = path.join(root, 'home');
  await writeSkill(systemDir, 'snotra-capabilities', {
    description: 'Switched off under {menu:settings.tools}',
    body: 'The user can enable it under `{menu:settings.tools}`.',
  });
  await writeSkill(path.join(home, '.agents', 'skills'), 'fremd', {
    body: 'Fremder Text mit {menu:settings.tools} darin.',
  });
  const service = makeService({ systemSkillsDir: systemDir, home });

  const english = await service.getActiveSkills({ locale: 'en', activeSkills: ['snotra-capabilities', 'fremd'] });
  const german = await service.getActiveSkills({ locale: 'de', activeSkills: ['snotra-capabilities', 'fremd'] });
  const bodyOf = (list, name) => list.find((skill) => skill.name === name).body;

  assert.match(bodyOf(english, 'snotra-capabilities'), /`Settings › Tools`/);
  assert.match(bodyOf(german, 'snotra-capabilities'), /`Einstellungen › Tools`/);
  // Der Ordner-Skill bleibt Wort für Wort, wie er auf der Platte liegt.
  assert.match(bodyOf(german, 'fremd'), /\{menu:settings\.tools\}/);

  // Auch die Kurzbeschreibung im Katalog spricht die Sprache der Oberfläche.
  const catalog = await service.listCatalog({ locale: 'de' });
  const entry = catalog.skills.find((skill) => skill.name === 'snotra-capabilities');
  assert.equal(entry.description, 'Switched off under Einstellungen › Tools');
});

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
  await writeSkill(path.join(home, '.snotra', 'skills'), 'home-snotra');
  await writeSkill(path.join(home, '.agents', 'skills'), 'home-agents');
  const service = makeService({ home });

  const { skills } = await service.listCatalog({ workspaceRoot: workspace });

  assert.deepEqual(
    skills.map((skill) => [skill.name, skill.source, skill.status]),
    [
      ['ws-agents', SKILL_SOURCES.WORKSPACE_AGENTS, SKILL_STATUS.AVAILABLE],
      ['home-snotra', SKILL_SOURCES.USER_SNOTRA, SKILL_STATUS.AVAILABLE],
      ['home-agents', SKILL_SOURCES.USER_AGENTS, SKILL_STATUS.AVAILABLE],
    ]
  );
  assert.deepEqual(await service.getActiveSkills({ workspaceRoot: workspace }), []);
});

// Issue #251: `~/.snotra` ist der neue Standardort für globale Skills. Bei
// Namensgleichheit gewinnt er gegen den Alt-Ort `~/.agents`, der Workspace
// aber gegen beide.
test('bei gleichem Namen gewinnt ~/.snotra gegen ~/.agents', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  const gewinner = await writeSkill(path.join(home, '.snotra', 'skills'), 'doppelt', { body: 'Snotra' });
  await writeSkill(path.join(home, '.agents', 'skills'), 'doppelt', { body: 'Agents' });
  const service = makeService({ home });

  const { skills } = await service.listCatalog({ activeSkills: ['doppelt'] });

  assert.deepEqual(
    skills.map((skill) => [skill.source, skill.status]),
    [
      [SKILL_SOURCES.USER_SNOTRA, SKILL_STATUS.ACTIVE],
      [SKILL_SOURCES.USER_AGENTS, SKILL_STATUS.SHADOWED],
    ]
  );
  assert.ok(de(skills[1].detail).includes(gewinner), 'der überdeckte Eintrag nennt den Pfad des Gewinners');

  const active = await service.getActiveSkills({ activeSkills: ['doppelt'] });
  assert.equal(active.length, 1);
  assert.equal(active[0].body, 'Snotra');
});

test('der Workspace schlägt auch ~/.snotra', async (t) => {
  const root = await makeTempTree(t);
  const workspace = path.join(root, 'ws');
  const home = path.join(root, 'home');
  await writeSkill(path.join(workspace, '.agents', 'skills'), 'doppelt', { body: 'Workspace' });
  await writeSkill(path.join(home, '.snotra', 'skills'), 'doppelt', { body: 'Snotra' });
  const service = makeService({ home });

  const active = await service.getActiveSkills({ workspaceRoot: workspace, activeSkills: ['doppelt'] });

  assert.equal(active.length, 1);
  assert.equal(active[0].source, SKILL_SOURCES.WORKSPACE_AGENTS);
  assert.equal(active[0].body, 'Workspace');
});

// Kein Auto-Anlegen: Wer `~/.agents/skills` nutzt, merkt vom neuen Ort nichts.
test('ein fehlendes ~/.snotra bleibt geräuschlos', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  await writeSkill(path.join(home, '.agents', 'skills'), 'nur-alt');
  const service = makeService({ home });

  const { skills } = await service.listCatalog({});

  assert.deepEqual(
    skills.map((skill) => [skill.name, skill.source]),
    [['nur-alt', SKILL_SOURCES.USER_AGENTS]]
  );
  assert.equal(await fs.access(path.join(home, '.snotra')).then(() => true, () => false), false,
    'der Scan legt nichts an');
});

// Issue #103: `.claude/` gehoert einem anderen Werkzeug. Snotra liest dort
// grundsaetzlich nichts — weder im geoeffneten Ordner noch im Home.
test('Skills in .claude/skills bleiben unsichtbar', async (t) => {
  const root = await makeTempTree(t);
  const workspace = path.join(root, 'ws');
  const home = path.join(root, 'home');
  await writeSkill(path.join(workspace, '.claude', 'skills'), 'ws-claude');
  await writeSkill(path.join(home, '.claude', 'skills'), 'home-claude');
  const service = makeService({ home });

  const { skills } = await service.listCatalog({ workspaceRoot: workspace });

  assert.deepEqual(skills, []);
  assert.deepEqual(await service.getActiveSkills({ workspaceRoot: workspace, activeSkills: ['ws-claude'] }), []);
});

test('gleicher Name mehrfach: der höher priorisierte Fund gewinnt', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'ws');
  const winnerDir = await writeSkill(path.join(workspace, '.agents', 'skills'), 'doppelt', { body: 'Workspace' });
  await writeSkill(path.join(home, '.agents', 'skills'), 'doppelt', { body: 'Home' });
  const service = makeService({ home });

  const { skills } = await service.listCatalog({
    workspaceRoot: workspace,
    activeSkills: ['doppelt'],
  });

  assert.equal(skills[0].status, SKILL_STATUS.ACTIVE);
  assert.equal(skills[1].status, SKILL_STATUS.SHADOWED);
  assert.match(de(skills[1].detail), /Überdeckt von/);
  assert.ok(de(skills[1].detail).includes(winnerDir));

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

  assert.equal(de(byName['paket.zip'].detail), 'Kein Verzeichnis');
  assert.equal(de(byName['ohne-datei'].detail), 'SKILL.md fehlt');
  assert.equal(de(byName['ohne-frontmatter'].detail), 'Kein YAML-Frontmatter');
  assert.match(de(byName['namens-mismatch'].detail), /≠ Verzeichnis/);
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

test('mehrzeilige Beschreibung als Block-Skalar landet vollständig im Katalog', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  await writeSkill(path.join(home, '.agents', 'skills'), 'block-skill', {
    description: ['>-', '  Erste Zeile der Beschreibung,', '  zweite Zeile der Beschreibung.'].join('\n'),
  });
  const service = makeService({ home });

  const { skills } = await service.listCatalog({});

  assert.equal(skills[0].status, SKILL_STATUS.AVAILABLE);
  assert.equal(skills[0].description, 'Erste Zeile der Beschreibung, zweite Zeile der Beschreibung.');
});

test('Block-Skalar ohne Inhalt zählt als fehlende description', async (t) => {
  const root = await makeTempTree(t);
  const home = path.join(root, 'home');
  await writeSkill(path.join(home, '.agents', 'skills'), 'leer-skill', { description: '>-' });
  const service = makeService({ home });

  const { skills } = await service.listCatalog({});

  assert.equal(skills[0].status, SKILL_STATUS.INVALID);
  assert.equal(de(skills[0].detail), 'Frontmatter ohne description');
});
