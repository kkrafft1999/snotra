const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const {
  SKILL_SOURCES,
  SKILL_SOURCE_ORDER,
  SKILL_SOURCE_LABELS,
  SKILL_STATUS,
  MAX_ACTIVE_SKILLS,
  isValidSkillName,
  normalizeActiveSkills,
  normalizeSkillSummary,
  normalizeSkillCatalog,
} = require('../src/shared/contracts/skills');
const contracts = require('../src/shared/contracts');
const { createSkillsService } = require('../src/main/services/skills-service');

test('System steht in der Quellenreihenfolge vorn und jede Quelle hat ein Label', () => {
  assert.equal(SKILL_SOURCE_ORDER[0], SKILL_SOURCES.SYSTEM);
  assert.deepEqual(SKILL_SOURCE_ORDER, [...new Set(SKILL_SOURCE_ORDER)]);
  for (const source of SKILL_SOURCE_ORDER) {
    assert.equal(typeof SKILL_SOURCE_LABELS[source], 'string');
    assert.ok(SKILL_SOURCE_LABELS[source].length > 0);
  }
});

test('normalizeActiveSkills säubert, entdoppelt und deckelt die Liste', () => {
  assert.equal(normalizeActiveSkills(undefined), null, 'nie gesetzt ≠ leer');
  assert.deepEqual(normalizeActiveSkills([]), []);
  assert.deepEqual(normalizeActiveSkills([' demo ', 'demo', 42, '', 'zwei']), ['demo', 'zwei']);
  assert.deepEqual(normalizeActiveSkills(['../etc/passwd', 'ok']), ['ok']);
  const many = Array.from({ length: MAX_ACTIVE_SKILLS + 5 }, (_, i) => `skill-${i}`);
  assert.equal(normalizeActiveSkills(many).length, MAX_ACTIVE_SKILLS);
});

test('isValidSkillName lässt nur verzeichnistaugliche Namen zu', () => {
  assert.ok(isValidSkillName('snotra-capabilities'));
  assert.ok(isValidSkillName('a_b.c-1'));
  assert.equal(isValidSkillName('../oben'), false);
  assert.equal(isValidSkillName('mit leerzeichen'), false);
  assert.equal(isValidSkillName('.versteckt'), false);
  assert.equal(isValidSkillName(''), false);
});

test('normalizeSkillSummary füllt Defaults und markiert eingebaute Skills', () => {
  assert.equal(normalizeSkillSummary({ name: '   ' }), null);
  assert.deepEqual(normalizeSkillSummary({ name: 'demo', source: SKILL_SOURCES.SYSTEM }), {
    name: 'demo',
    description: '',
    source: SKILL_SOURCES.SYSTEM,
    status: SKILL_STATUS.AVAILABLE,
    path: '',
    detail: '',
    builtin: true,
  });
  const folderSkill = normalizeSkillSummary({ name: 'demo', source: 'quatsch', status: 'quatsch' });
  assert.equal(folderSkill.builtin, false);
  assert.equal(folderSkill.status, SKILL_STATUS.AVAILABLE);
});

test('normalizeSkillCatalog wirft kaputte Zeilen weg', () => {
  assert.deepEqual(normalizeSkillCatalog(null), { skills: [] });
  const { skills } = normalizeSkillCatalog({ skills: [{ name: 'a' }, null, { nope: true }] });
  assert.deepEqual(skills.map((skill) => skill.name), ['a']);
});

test('das Contract-Aggregat exportiert die Skill-Werte für den Renderer', () => {
  assert.equal(contracts.SKILL_SOURCES.SYSTEM, SKILL_SOURCES.SYSTEM);
  assert.equal(contracts.SKILL_STATUS.ACTIVE, SKILL_STATUS.ACTIVE);
  assert.deepEqual(contracts.SKILL_SOURCE_ORDER, SKILL_SOURCE_ORDER);
  assert.equal(typeof contracts.normalizeActiveSkills, 'function');
});

test('die mitgelieferten System-Skills sind gültig und voreingestellt aktiv', async () => {
  const systemSkillsDir = path.join(__dirname, '..', 'system-skills');
  const entries = await fs.readdir(systemSkillsDir, { withFileTypes: true });
  assert.ok(entries.length > 0, 'mindestens ein System-Skill wird ausgeliefert');

  const service = createSkillsService({
    fs,
    path,
    os: { homedir: () => path.join(systemSkillsDir, '__kein-home__') },
    systemSkillsDir,
  });
  const { skills } = await service.listCatalog({});

  assert.equal(skills.length, entries.length);
  for (const skill of skills) {
    assert.equal(skill.source, SKILL_SOURCES.SYSTEM, `${skill.name} muss System-Skill sein`);
    assert.equal(skill.status, SKILL_STATUS.ACTIVE, `${skill.name}: ${skill.detail}`);
    assert.ok(skill.description.length > 0);
  }
  assert.ok(skills.some((skill) => skill.name === 'snotra-capabilities'));

  const active = await service.getActiveSkills({});
  const capabilities = active.find((skill) => skill.name === 'snotra-capabilities');
  assert.ok(capabilities.body.includes('Snotra AI'));
});
