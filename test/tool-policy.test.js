// Reine Policy (Issue #66, Konzept §3): alle 18 Matrixzellen, Vorrang der
// Sperren, ask-all trotz Freigaben, Auto, Allow-Regeln, Mehrfachwirkungen.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  POLICY_MATRIX,
  matrixDecision,
  matrixDecisionForClasses,
  classesRequiringAsk,
  selectRulesForRoot,
  decideToolPolicy,
} = require('../src/application/permissions/tool-policy');
const { TOOL_RISK_CLASS_ORDER } = require('../src/shared/contracts/tool-permissions');

const ROOT = '/work/projekt';

function rule(overrides) {
  return { id: 'r', effect: 'deny', scope: 'global', root: null, tool: null, riskClass: null, pathPattern: '**', createdAt: 0, ...overrides };
}

test('alle 18 Matrixzellen entsprechen dem Konzept', () => {
  const expected = {
    smart: { read: 'allow', 'read-sensitive': 'ask', write: 'ask', delete: 'ask', execute: 'ask', external: 'ask' },
    'ask-all': { read: 'ask', 'read-sensitive': 'ask', write: 'ask', delete: 'ask', execute: 'ask', external: 'ask' },
    auto: { read: 'allow', 'read-sensitive': 'allow', write: 'allow', delete: 'allow', execute: 'allow', external: 'allow' },
  };
  let cells = 0;
  for (const [mode, row] of Object.entries(expected)) {
    for (const [cls, decision] of Object.entries(row)) {
      assert.equal(matrixDecision(mode, cls), decision, `${mode}/${cls}`);
      assert.equal(POLICY_MATRIX[mode][cls], decision);
      // Ohne Regeln und Freigaben liefert decideToolPolicy dieselbe Zelle.
      const verdict = decideToolPolicy({ mode, toolName: 't', riskClasses: [cls], targets: [{ path: 'a' }], root: ROOT, rules: [] });
      assert.equal(verdict.decision, decision, `decide ${mode}/${cls}`);
      cells += 1;
    }
  }
  assert.equal(cells, 18);
  assert.equal(TOOL_RISK_CLASS_ORDER.length, 6);
});

test('mehrere Wirkungen müssen alle erlaubt sein; unbekannter Modus ist smart', () => {
  assert.equal(matrixDecisionForClasses('smart', ['read']), 'allow');
  assert.equal(matrixDecisionForClasses('smart', ['read', 'write']), 'ask');
  assert.equal(matrixDecisionForClasses('auto', ['read-sensitive', 'delete']), 'allow');
  assert.equal(matrixDecisionForClasses('smart', []), 'ask');
  assert.equal(matrixDecisionForClasses('smart', ['nope']), 'ask');
  assert.equal(matrixDecision('yolo', 'write'), 'ask');
  assert.deepEqual(classesRequiringAsk('smart', ['read', 'read-sensitive', 'write']), ['read-sensitive', 'write']);
  const verdict = decideToolPolicy({ mode: 'smart', toolName: 't', riskClasses: ['read', 'write'], targets: [{ path: 'a' }] });
  assert.equal(verdict.decision, 'ask');
  assert.deepEqual(verdict.askClasses, ['write']);
});

test('harte Grenze, unbekanntes Tool, deaktiviertes Tool und fehlende Klasse blockieren in jedem Modus', () => {
  for (const mode of ['smart', 'ask-all', 'auto']) {
    assert.equal(decideToolPolicy({ mode, toolName: 't', riskClasses: ['read'], hardLimit: { reason: 'hard_limit' } }).reason, 'hard_limit');
    assert.equal(decideToolPolicy({ mode, toolName: 't', riskClasses: ['read'], unknownTool: true }).reason, 'unknown_tool');
    assert.equal(decideToolPolicy({ mode, toolName: '', riskClasses: ['read'] }).reason, 'unknown_tool');
    assert.equal(decideToolPolicy({ mode, toolName: 't', riskClasses: ['read'], toolDisabled: true }).reason, 'tool_disabled');
    assert.equal(decideToolPolicy({ mode, toolName: 't', riskClasses: [] }).reason, 'invalid_arguments');
    assert.equal(decideToolPolicy({ mode, toolName: 't', riskClasses: ['shell'] }).reason, 'invalid_arguments');
    assert.equal(decideToolPolicy({ mode, toolName: 't', riskClasses: null }).decision, 'deny');
  }
  // Harte Grenze schlägt sogar eine Sitzungsfreigabe und Auto.
  const verdict = decideToolPolicy({ mode: 'auto', toolName: 't', riskClasses: ['read'], hardLimit: { reason: 'own_secret' }, sessionGrant: { id: 'g' } });
  assert.equal(verdict.decision, 'deny');
  assert.equal(verdict.reason, 'own_secret');
});

test('Deny-Regel gewinnt über Allow-Regel, Sitzungsfreigabe und Auto (Deny vor Allow)', () => {
  const rules = [
    rule({ id: 'allow-all', effect: 'allow', riskClass: 'write', pathPattern: '**' }),
    rule({ id: 'deny-src', effect: 'deny', tool: 'edit_file', pathPattern: 'src/**' }),
  ];
  for (const mode of ['smart', 'ask-all', 'auto']) {
    const verdict = decideToolPolicy({
      mode,
      toolName: 'edit_file',
      riskClasses: ['write'],
      targets: [{ path: 'src/a.js' }],
      root: ROOT,
      rules,
      sessionGrant: { id: 'g' },
    });
    assert.equal(verdict.decision, 'deny', mode);
    assert.equal(verdict.reason, 'policy_denied');
    assert.equal(verdict.ruleId, 'deny-src');
  }
  // Ein Ziel außerhalb des Musters ist nicht gesperrt; die Allow-Regel deckt es.
  const other = decideToolPolicy({ mode: 'smart', toolName: 'edit_file', riskClasses: ['write'], targets: [{ path: 'docs/a.md' }], root: ROOT, rules });
  assert.equal(other.decision, 'allow');
  assert.equal(other.source, 'allow-rule');
  assert.equal(other.ruleId, 'allow-all');
});

test('Deny-Regeln greifen per Tool oder Klasse, bei mehreren Zielen reicht ein Treffer', () => {
  const byClass = [rule({ id: 'no-sensitive', effect: 'deny', riskClass: 'read-sensitive' })];
  assert.equal(decideToolPolicy({ mode: 'auto', toolName: 'read_file_text', riskClasses: ['read', 'read-sensitive'], targets: [{ path: '.env' }], rules: byClass }).decision, 'deny');
  assert.equal(decideToolPolicy({ mode: 'auto', toolName: 'read_file_text', riskClasses: ['read'], targets: [{ path: 'a' }], rules: byClass }).decision, 'allow');

  const patch = decideToolPolicy({
    mode: 'auto',
    toolName: 'apply_patch',
    riskClasses: ['write'],
    targets: [{ path: 'docs/a.md' }, { path: 'src/hidden.js' }],
    rules: [rule({ id: 'lock-src', effect: 'deny', riskClass: 'write', pathPattern: 'src/**' })],
  });
  assert.equal(patch.decision, 'deny', 'Mehrdatei-Patch: ein gesperrtes Ziel sperrt alles');

  // Ohne Ziel (z. B. web_search) greift nur eine Sperre auf „alles“.
  assert.equal(decideToolPolicy({ mode: 'auto', toolName: 'web_search', riskClasses: ['read'], targets: [], rules: [rule({ id: 'x', effect: 'deny', tool: 'web_search', pathPattern: 'src/**' })] }).decision, 'allow');
  assert.equal(decideToolPolicy({ mode: 'auto', toolName: 'web_search', riskClasses: ['read'], targets: [], rules: [rule({ id: 'x', effect: 'deny', tool: 'web_search' })] }).decision, 'deny');
});

test('ask-all fragt auch Lesetools und ignoriert Sitzungsfreigaben und Allow-Regeln', () => {
  const rules = [rule({ id: 'a', effect: 'allow', riskClass: 'read' })];
  const verdict = decideToolPolicy({ mode: 'ask-all', toolName: 'list_directory', riskClasses: ['read'], targets: [], rules, sessionGrant: { id: 'g' } });
  assert.equal(verdict.decision, 'ask');
  assert.deepEqual(verdict.askClasses, ['read']);
  assert.equal(decideToolPolicy({ mode: 'ask-all', toolName: 'web_search', riskClasses: ['read'] }).decision, 'ask');
});

test('auto erlaubt alle Klassen innerhalb der Grenzen, auch sensible Daten', () => {
  const verdict = decideToolPolicy({ mode: 'auto', toolName: 'read_file_text', riskClasses: ['read', 'read-sensitive'], targets: [{ path: '.env' }] });
  assert.equal(verdict.decision, 'allow');
  assert.equal(verdict.source, 'auto');
});

test('smart: Sitzungsfreigabe geht vor Allow-Regel vor Matrix', () => {
  const grant = decideToolPolicy({ mode: 'smart', toolName: 'edit_file', riskClasses: ['write'], targets: [{ path: 'a' }], sessionGrant: { id: 'g1' } });
  assert.equal(grant.decision, 'allow');
  assert.equal(grant.source, 'allow-session');
  assert.equal(grant.grantId, 'g1');

  const read = decideToolPolicy({ mode: 'smart', toolName: 'read_file_text', riskClasses: ['read'], targets: [{ path: 'a' }] });
  assert.equal(read.decision, 'allow');
  assert.equal(read.source, 'auto');
});

test('Allow-Regeln decken nur vollständig: jede Klasse, jedes Ziel, nur read/write', () => {
  const toolRule = [rule({ id: 'edit-docs', effect: 'allow', tool: 'edit_file', pathPattern: 'docs/**' })];
  assert.equal(decideToolPolicy({ mode: 'smart', toolName: 'edit_file', riskClasses: ['write'], targets: [{ path: 'docs/a.md' }], rules: toolRule }).decision, 'allow');
  assert.equal(decideToolPolicy({ mode: 'smart', toolName: 'edit_file', riskClasses: ['write'], targets: [{ path: 'docs/a.md' }, { path: 'src/b.js' }], rules: toolRule }).decision, 'ask', 'ein Ziel außerhalb → fragen');
  assert.equal(decideToolPolicy({ mode: 'smart', toolName: 'write_file_text', riskClasses: ['write'], targets: [{ path: 'docs/a.md' }], rules: toolRule }).decision, 'ask', 'anderes Tool');
  // Sensible Daten sind nie dauerhaft erlaubt, auch wenn eine Regel „alles“ erlaubt.
  const broad = [rule({ id: 'all-write', effect: 'allow', riskClass: 'write' }), rule({ id: 'all-read', effect: 'allow', riskClass: 'read' })];
  assert.equal(decideToolPolicy({ mode: 'smart', toolName: 'edit_file', riskClasses: ['write', 'read-sensitive'], targets: [{ path: '.env' }], rules: broad }).decision, 'ask');
  assert.equal(decideToolPolicy({ mode: 'smart', toolName: 'write_file_text', riskClasses: ['delete'], targets: [{ path: 'a' }], rules: broad }).decision, 'ask');
  // Zwei Klassen, zwei Regeln: beide decken → erlaubt.
  const both = decideToolPolicy({ mode: 'smart', toolName: 'edit_file', riskClasses: ['read', 'write'], targets: [{ path: 'a' }], rules: broad });
  assert.equal(both.decision, 'allow');
  assert.deepEqual(both.ruleIds, ['all-read', 'all-write']);
  // Ohne Ziel deckt nur ein Alles-Muster.
  assert.equal(decideToolPolicy({ mode: 'smart', toolName: 'run', riskClasses: ['write'], targets: [], rules: [rule({ id: 'p', effect: 'allow', tool: 'run', pathPattern: 'x/**' })] }).decision, 'ask');
});

test('Workspace-Regeln gelten nur für ihre kanonische Wurzel, globale überall', () => {
  const rules = [
    rule({ id: 'ws', effect: 'deny', scope: 'workspace', root: ROOT, tool: 'edit_file' }),
    rule({ id: 'g', effect: 'deny', scope: 'global', tool: 'apply_patch' }),
  ];
  assert.deepEqual(selectRulesForRoot(rules, ROOT).map((r) => r.id), ['ws', 'g']);
  assert.deepEqual(selectRulesForRoot(rules, '/other/projekt').map((r) => r.id), ['g']);
  assert.deepEqual(selectRulesForRoot(rules, null).map((r) => r.id), ['g']);
  assert.equal(decideToolPolicy({ mode: 'auto', toolName: 'edit_file', riskClasses: ['write'], targets: [{ path: 'a' }], root: '/other/projekt', rules }).decision, 'allow');
  assert.equal(decideToolPolicy({ mode: 'auto', toolName: 'edit_file', riskClasses: ['write'], targets: [{ path: 'a' }], root: ROOT, rules }).decision, 'deny');
});

// ── Rules decide on the place a call touches (#511) ─────────────────────────

function decideFor({ rules, riskClasses = ['read'], target, mode = 'smart' }) {
  return decideToolPolicy({ mode, toolName: 'read_file_text', riskClasses, targets: [target], root: ROOT, rules }).decision;
}

test('an allow rule covers only what lies under its pattern, whatever the spelling (#511)', () => {
  const allowSrc = rule({ effect: 'allow', scope: 'workspace', root: ROOT, riskClass: 'write', pathPattern: 'src/**' });
  const write = (target) => decideFor({ rules: [allowSrc], riskClasses: ['write'], target });
  assert.equal(write({ path: 'src/a.js', rulePaths: ['src/a.js'] }), 'allow');
  // The planner resolves `src/../package.json` to `package.json`.
  assert.equal(write({ path: 'src/../package.json', rulePaths: ['package.json'] }), 'ask');
  // A symlink inside src/ pointing elsewhere: the real path is outside the pattern.
  assert.equal(write({ path: 'src/link', rulePaths: ['src/link', 'config/secret.json'] }), 'ask');
  // Without resolved forms, a spelling that leaves its folder covers nothing.
  assert.equal(write({ path: 'src/../package.json' }), 'ask');
  assert.equal(write({ path: '/work/projekt/src/a.js' }), 'ask');
  // Exact case for allowing: `Src/` is not what the rule names.
  assert.equal(write({ path: 'Src/a.js', rulePaths: ['Src/a.js'] }), 'ask');
});

test('a deny rule catches every form of every target, case-insensitively (#511)', () => {
  const denyPrivate = rule({ scope: 'workspace', root: ROOT, riskClass: 'read', pathPattern: 'private/**' });
  const read = (target) => decideFor({ rules: [denyPrivate], target });
  assert.equal(read({ path: 'x/../private/a', rulePaths: ['private/a'] }), 'deny');
  assert.equal(read({ path: '/work/projekt/private/a', rulePaths: ['private/a'] }), 'deny');
  assert.equal(read({ path: 'Private/a', rulePaths: ['Private/a'] }), 'deny');
  assert.equal(read({ path: 'link/a', rulePaths: ['link/a', 'private/a'] }), 'deny');
  assert.equal(read({ path: 'public/a', rulePaths: ['public/a'] }), 'allow');
});

test('a block on writes covers an overwrite without recovery, classified delete (#515)', () => {
  const denyWrite = rule({ riskClass: 'write', pathPattern: '**' });
  for (const mode of ['smart', 'auto', 'ask-all']) {
    assert.equal(decideFor({ rules: [denyWrite], riskClasses: ['delete'], target: { path: 'a.txt' }, mode }), 'deny', mode);
  }
  // A block on deletes does not, in turn, block ordinary writes.
  const denyDelete = rule({ riskClass: 'delete', pathPattern: '**' });
  assert.equal(decideFor({ rules: [denyDelete], riskClasses: ['write'], target: { path: 'a.txt' } }), 'ask');
});
