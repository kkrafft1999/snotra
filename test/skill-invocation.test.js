const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const {
  findSkillQuery,
  extractInvokedSkillNames,
  filterSkillCandidates,
  applySkillInvocation,
} = require('../src/shared/contracts/skill-invocation');
const contracts = require('../src/shared/contracts');
const { SKILL_SOURCES, SKILL_STATUS } = require('../src/shared/contracts/skills');
const { createSkillsService } = require('../src/main/services/skills-service');

// ── findSkillQuery: was ist ein offener Aufruf? ─────────────────────────────

test('findSkillQuery erkennt den Aufruf am Textanfang und nach Leerraum', () => {
  assert.deepEqual(findSkillQuery('/rel', 4), { start: 0, query: 'rel' });
  assert.deepEqual(findSkillQuery('bitte /rel', 10), { start: 6, query: 'rel' });
  assert.deepEqual(findSkillQuery('("/rel', 6), { start: 2, query: 'rel' });
  assert.deepEqual(findSkillQuery('/', 1), { start: 0, query: '' }, 'leere Anfrage zeigt alles');
});

test('findSkillQuery ignoriert Schrägstriche mitten im Wort und in Pfaden', () => {
  assert.equal(findSkillQuery('und/oder', 8), null, 'kein Leerraum davor');
  assert.equal(findSkillQuery('/usr/bin', 8), null, 'zweiter Schrägstrich beendet den Namen');
  assert.equal(findSkillQuery('kein Aufruf', 11), null);
});

test('findSkillQuery endet an Zeichen, die nicht in einen Skill-Namen gehören', () => {
  assert.equal(findSkillQuery('/rel ease', 9), null, 'Leerraum beendet den Aufruf');
  assert.equal(findSkillQuery('/rel@x', 6), null);
  assert.deepEqual(findSkillQuery('/ms-todo_cli.v2', 15), { start: 0, query: 'ms-todo_cli.v2' });
});

test('findSkillQuery liest bis zum Cursor, nicht bis zum Textende', () => {
  assert.deepEqual(findSkillQuery('/release später', 4), { start: 0, query: 'rel' });
  assert.equal(findSkillQuery('', 0), null);
  assert.equal(findSkillQuery(null, 3), null);
});

// ── extractInvokedSkillNames: was wirkt am Ende? ────────────────────────────

test('extractInvokedSkillNames findet Aufrufe, entdoppelt und hält die Reihenfolge', () => {
  assert.deepEqual(extractInvokedSkillNames('/release bitte'), ['release']);
  assert.deepEqual(
    extractInvokedSkillNames('erst /install, dann /release und nochmal /install'),
    ['install', 'release']
  );
  assert.deepEqual(extractInvokedSkillNames(''), []);
  assert.deepEqual(extractInvokedSkillNames(null), []);
});

test('extractInvokedSkillNames hält Pfade und Bruchrechnung heraus', () => {
  assert.deepEqual(extractInvokedSkillNames('siehe /usr/bin/env'), [], 'absoluter Pfad');
  assert.deepEqual(extractInvokedSkillNames('a/b'), [], 'kein Leerraum davor');
  assert.deepEqual(extractInvokedSkillNames('1/2 und 3/4'), []);
  assert.deepEqual(extractInvokedSkillNames('/ allein'), [], 'leerer Name ist kein Aufruf');
  assert.deepEqual(extractInvokedSkillNames('/../etc/passwd'), [], 'kein Verzeichniswechsel');
});

// ── filterSkillCandidates: Name vor Beschreibung ────────────────────────────

const CATALOG = [
  { name: 'release', description: 'Erstellt ein neues Release von Snotra AI' },
  { name: 'install', description: 'Baut die App und kopiert sie nach Programme' },
  { name: 'traffic', description: 'Ruft den Traffic-Report für snotra-ai.dev ab' },
  { name: 'demo-skill', description: 'Ein Demo-Skill, der aus dem Terminal heraus läuft' },
];

test('filterSkillCandidates gewichtet den Namen über die Beschreibung', () => {
  assert.deepEqual(
    filterSkillCandidates(CATALOG, 'rel').map((s) => s.name),
    ['release']
  );
  // „app“ steht nur in der Beschreibung von install — und im „-ai.dev“ von
  // traffic steckt kein „app“, der Treffer ist also eindeutig.
  assert.deepEqual(
    filterSkillCandidates(CATALOG, 'app').map((s) => s.name),
    ['install']
  );
  assert.deepEqual(filterSkillCandidates(CATALOG, 'zzz'), []);
});

test('ein Füllwort in der Beschreibung erzeugt keinen Treffer', () => {
  // „dem“ steht als Füllwort in der Beschreibung von demo-skill („aus dem
  // Terminal“) — gefunden werden darf der Skill trotzdem nur über den Namen,
  // sonst füllt sich die achtzeilige Liste mit Rauschen.
  assert.deepEqual(
    filterSkillCandidates(CATALOG, 'dem').map((s) => s.name),
    ['demo-skill']
  );
  // Ein Teilstück mitten im Wort zählt nicht: „erm“ steckt in „Terminal“.
  assert.deepEqual(filterSkillCandidates(CATALOG, 'erm'), []);
  // Wortanfänge in der Beschreibung dagegen schon.
  assert.deepEqual(
    filterSkillCandidates(CATALOG, 'programme').map((s) => s.name),
    ['install']
  );
});

test('kurze Anfragen suchen nur im Namen', () => {
  // „ne“ beginnt ein Wort in der Beschreibung von release („ein neues
  // Release“), ist aber zu kurz, um dort zu zählen — und in keinem Namen
  // enthalten, auch nicht als Buchstabenfolge.
  assert.deepEqual(filterSkillCandidates(CATALOG, 'ne'), []);
  assert.deepEqual(
    filterSkillCandidates(CATALOG, 'in').map((s) => s.name),
    ['install'],
    'im Namen zählt auch eine kurze Anfrage'
  );
});

test('filterSkillCandidates ohne Anfrage behält die Reihenfolge und achtet das Limit', () => {
  assert.deepEqual(
    filterSkillCandidates(CATALOG, '').map((s) => s.name),
    ['release', 'install', 'traffic', 'demo-skill']
  );
  assert.equal(filterSkillCandidates(CATALOG, '', 2).length, 2);
  assert.equal(filterSkillCandidates(CATALOG, 'e', 1).length, 1);
  assert.deepEqual(filterSkillCandidates(null, 'rel'), []);
});

// ── applySkillInvocation: Einfügen ins Textfeld ─────────────────────────────

test('applySkillInvocation ersetzt die offene Anfrage durch „/name “', () => {
  assert.deepEqual(applySkillInvocation('bitte /rel', 6, 10, { name: 'release' }), {
    text: 'bitte /release ',
    caret: 15,
  });
});

test('applySkillInvocation verdoppelt ein vorhandenes Leerzeichen nicht', () => {
  const { text } = applySkillInvocation('/rel machen', 0, 4, { name: 'release' });
  assert.equal(text, '/release machen');
});

// ── Aggregat und Registry ──────────────────────────────────────────────────

test('das Contract-Aggregat reicht die Aufruf-Logik an den Renderer durch', () => {
  assert.equal(typeof contracts.findSkillQuery, 'function');
  assert.equal(typeof contracts.extractInvokedSkillNames, 'function');
  assert.equal(typeof contracts.filterSkillCandidates, 'function');
  assert.equal(typeof contracts.applySkillInvocation, 'function');
});

async function withSkillDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-skills-'));
  try {
    const skillsDir = path.join(dir, '.agents', 'skills');
    for (const name of ['alpha', 'beta', 'gamma']) {
      const skillDir = path.join(skillsDir, name);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        path.join(skillDir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Skill ${name}\n---\n\nAnweisungen für ${name}.\n`,
        'utf8'
      );
    }
    const service = createSkillsService({
      fs,
      path,
      os: { homedir: () => path.join(dir, '__kein-home__') },
    });
    await run({ service, workspaceRoot: dir });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('ein aufgerufener Skill kommt zur dauerhaften Auswahl dazu', async () => {
  await withSkillDir(async ({ service, workspaceRoot }) => {
    const active = await service.getActiveSkills({
      workspaceRoot,
      activeSkills: ['alpha'],
      invokedSkills: ['beta'],
    });
    assert.deepEqual(active.map((s) => s.name).sort(), ['alpha', 'beta']);
    assert.equal(active.find((s) => s.name === 'alpha').invoked, false);
    assert.equal(active.find((s) => s.name === 'beta').invoked, true, 'als Aufruf markiert');
    assert.ok(active.find((s) => s.name === 'beta').body.includes('Anweisungen für beta'));
  });
});

test('der Aufruf verändert die dauerhafte Auswahl nicht', async () => {
  await withSkillDir(async ({ service, workspaceRoot }) => {
    await service.getActiveSkills({
      workspaceRoot,
      activeSkills: ['alpha'],
      invokedSkills: ['beta'],
    });
    const { skills } = await service.listCatalog({ workspaceRoot, activeSkills: ['alpha'] });
    const byName = Object.fromEntries(skills.map((s) => [s.name, s.status]));
    assert.equal(byName.alpha, SKILL_STATUS.ACTIVE);
    assert.equal(byName.beta, SKILL_STATUS.AVAILABLE, 'bleibt nur verfügbar, nicht eingeschaltet');
  });
});

test('ein Aufruf zählt nicht gegen das 8er-Limit und greift nur bei nutzbaren Skills', async () => {
  await withSkillDir(async ({ service, workspaceRoot }) => {
    // Ein voller Satz aus acht Namen — „gamma“ passt nicht mehr hinein und
    // kommt trotzdem durch, weil er aufgerufen wurde.
    const full = ['alpha', 'beta', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
    const active = await service.getActiveSkills({
      workspaceRoot,
      activeSkills: full,
      invokedSkills: ['gamma', 'gibt-es-nicht'],
    });
    assert.deepEqual(active.map((s) => s.name).sort(), ['alpha', 'beta', 'gamma']);
  });
});

test('ohne Aufrufe bleibt es bei der Voreinstellung (nur System-Skills)', async () => {
  await withSkillDir(async ({ service, workspaceRoot }) => {
    const active = await service.getActiveSkills({ workspaceRoot, invokedSkills: [] });
    assert.deepEqual(active, [], 'Ordner-Skills nie ohne Nutzeraktion');
    for (const source of active.map((s) => s.source)) {
      assert.equal(source, SKILL_SOURCES.SYSTEM);
    }
  });
});
