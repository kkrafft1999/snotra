// Skill folders are read-only again (#548, taking back #429): no write tool
// and no sandboxed run reaches one, a refusal names `.agents/data/` in the
// open folder, and without a folder only the read tools reach the skills.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');
const { planSpawn } = require('../src/main/services/sandboxed-spawn');
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');
const { buildApprovalRequest } = require('../src/application/permissions/approval-request');
const { SKILL_DATA_DIR, SKILL_FOLDER_READ_ONLY } = require('../src/shared/contracts/skills');

const loadRenderer = (file) =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'utils', file)).href);
const loadRendererI18n = () =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js')).href);

const READ_ONLY = /Skill folders are read-only\. Keep what a skill produces in "\.agents\/data\/" in the open folder\./;

async function makeFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-skill-ro-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'projekt');
  const skillDir = path.join(base, 'skills', 'demo');
  await fs.mkdir(path.join(skillDir, 'assets'), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n\nRules in assets/.\n', 'utf8');
  await fs.writeFile(path.join(skillDir, 'assets', 'rules.md'), 'Rule A\n', 'utf8');
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  return { base, workspace, skillDir, fsService, skillRoots: [{ name: 'demo', dir: skillDir }] };
}

function makePlanner(fsService, opts = {}) {
  return createToolCallPlanner({ fsService, fs, path, canTrash: false, ...opts });
}

test('the data folder and the refusal are one contract', () => {
  assert.equal(SKILL_DATA_DIR, '.agents/data');
  assert.match(SKILL_FOLDER_READ_ONLY, READ_ONLY);
});

// ── Planner: writes ────────────────────────────────────────────────────────

test('a write into a skill folder is a hard limit that names .agents/data', async (t) => {
  const { workspace, skillDir, fsService, skillRoots } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService });
  const planner = makePlanner(fsService);
  const absolute = path.join(skillDir, 'assets', 'rules.md');
  const calls = [
    ['write_file_text', { relative_path: 'skill:demo/assets/new.md', content: 'x\n' }],
    ['write_file_text', { relative_path: absolute, content: 'x\n' }],
    ['edit_file', { relative_path: absolute, old_string: 'Rule A', new_string: 'Rule B' }],
    ['apply_patch', { relative_path: 'skill:demo/assets/rules.md', edits: [{ old_string: 'Rule A', new_string: 'Rule B' }] }],
  ];
  for (const [tool, args] of calls) {
    // A `writableSkills` left over from #429 opens nothing.
    for (const workspaceRoot of [workspace, '']) {
      const plan = await planner.plan(registry.getDefinition(tool), args, { workspaceRoot, skillRoots, writableSkills: ['demo'] });
      assert.equal(plan.reason, 'hard_limit', `${tool} ${args.relative_path} (${workspaceRoot || 'no folder'})`);
      assert.match(plan.error, READ_ONLY);
    }
  }
  assert.equal(await fs.readFile(absolute, 'utf8'), 'Rule A\n');
  await assert.rejects(fs.access(path.join(skillDir, 'assets', 'new.md')));
});

test('a write into .agents/data in the open folder is an ordinary write', async (t) => {
  const { workspace, fsService, skillRoots } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService });
  const planner = makePlanner(fsService);
  const args = { relative_path: '.agents/data/contacts.md', content: '- Anna\n' };

  const plan = await planner.plan(registry.getDefinition('write_file_text'), args, { workspaceRoot: workspace, skillRoots });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.riskClasses, ['write']);
  assert.equal(plan.targets[0].skillName ?? null, null);

  const out = JSON.parse(await registry.execute('write_file_text', args, { approved: true, workspaceRoot: workspace, skillRoots }));
  assert.equal(out.error, undefined);
  assert.equal(await fs.readFile(path.join(workspace, '.agents', 'data', 'contacts.md'), 'utf8'), '- Anna\n');
});

// ── Execution runs ─────────────────────────────────────────────────────────

test('an isolated run gets no skill folder to write to', async (t) => {
  const { workspace, fsService, skillRoots } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService });
  const planner = makePlanner(fsService, { describeSandbox: async () => ({ isolated: true }) });
  const context = { workspaceRoot: workspace, skillRoots, writableSkills: ['demo'] };

  const shell = await planner.plan(registry.getDefinition('shell_execute'), { command: 'ls' }, context);
  const python = await planner.plan(registry.getDefinition('run_python'), { code: 'print(1)' }, context);
  for (const plan of [shell, python]) {
    assert.equal(plan.error, undefined);
    assert.equal(plan.sandbox.skillFolders, undefined);
    assert.equal(plan.preview.isolation.skillFolders, undefined);
  }
});

test('shell_execute does not run in a skill folder', async (t) => {
  const { workspace, skillDir, fsService, skillRoots } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({
    fsService,
    shellRunner: { isAvailable: () => true, run: async () => assert.fail('must not run') },
  });
  const planner = makePlanner(fsService);
  for (const cwd of ['skill:demo', skillDir]) {
    const plan = await planner.plan(registry.getDefinition('shell_execute'), { command: 'ls', cwd }, { workspaceRoot: workspace, skillRoots });
    assert.equal(plan.reason, 'hard_limit', cwd);
  }
  const out = JSON.parse(await registry.execute('shell_execute', { command: 'ls', cwd: 'skill:demo' }, {
    approved: true, workspaceRoot: workspace, skillRoots,
  }));
  assert.match(out.error, /only work with the read tools/);
});

test('planSpawn widens the sandbox by a program allowance only', async () => {
  const requests = [];
  const sandbox = {
    describe: () => ({ isolated: true }),
    async prepare(request) {
      requests.push(request);
      return {
        command: '/bin/sh', args: ['-c', request.command], env: {}, domains: request.allowedDomains,
        writePaths: request.extraWritePaths, trustd: false, annotate: (s) => s, release: () => {},
      };
    },
  };
  const target = await planSpawn({
    sandbox, argv: ['/bin/zsh', '-c', 'ls'], runTmp: '/tmp/x', domains: [],
    allowance: { writePaths: ['/cache'], trustd: false }, skillWritePaths: ['/s/demo'],
  });
  assert.deepEqual(requests[0].extraWritePaths, ['/cache']);
  assert.deepEqual(target.isolation, { isolated: true, domains: [], writePaths: ['/cache'] });
});

// ── Tools without an open folder ───────────────────────────────────────────

test('without a folder only the read tools stay on while a skill is switched on', async (t) => {
  const { fsService } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService, shellRunner: { isAvailable: () => true, run: async () => ({}) } });
  const names = (options) => registry.getTools(options).map((tool) => tool.function.name);

  const withSkill = names({ workspaceOpen: false, skillNames: ['demo'] });
  for (const name of ['read_file_text', 'list_directory', 'find_files', 'load_skill']) {
    assert.ok(withSkill.includes(name), name);
  }
  for (const name of ['write_file_text', 'edit_file', 'apply_patch', 'shell_execute']) {
    assert.equal(withSkill.includes(name), false, name);
  }
  assert.equal(names({ workspaceOpen: false, skillNames: [] }).includes('read_file_text'), false);

  const prompt = registry.buildSystemPrompt({ workspaceOpen: false, skillNames: ['demo'] });
  assert.match(prompt, /No folder is open, so the read tools reach only the folders of the switched-on skills/);
  assert.doesNotMatch(prompt, /relative to the folder root/);
});

// ── Card and security overview ─────────────────────────────────────────────

function cardDto(fields) {
  return createToolApprovalRequestDto({ requestId: 'r1', mode: 'smart', ...fields });
}

test('card: a read target keeps its skill, and its session scope names the skill path', () => {
  const plan = {
    riskClasses: ['read-sensitive'],
    planKey: 'p',
    targets: [{ path: '/abs/demo/assets/.env', kind: 'file', exists: true, skillName: 'demo', skillPath: 'skill:demo/assets/.env' }],
  };
  const request = buildApprovalRequest({ tool: 'read_file_text', plan, askClasses: ['read-sensitive'], mode: 'smart' });
  assert.equal(request.targets[0].skillName, 'demo');
  assert.equal(request.targets[0].skillPath, 'skill:demo/assets/.env');
  assert.match(JSON.stringify(request.sessionScope), /skill:demo\/assets\/\.env/);
});

test('card: names the skill of a read target and lists no skill folders for a run (en/de)', async () => {
  const { setLocale } = await loadRendererI18n();
  const { buildApprovalCardView } = await loadRenderer('tool-approval-view.js');
  const read = cardDto({
    tool: 'read_file_text', riskClasses: ['read'],
    targets: [{ path: '/Users/u/.claude/skills/demo/assets/rules.md', kind: 'file', exists: true, skillName: 'demo', skillPath: 'skill:demo/assets/rules.md' }],
  });
  const run = cardDto({
    tool: 'shell_execute', riskClasses: ['execute'], targets: [],
    preview: { kind: 'text', text: 'ls', isolation: { isolated: true, domains: [], skillFolders: [{ name: 'demo', path: '/s/demo' }] } },
  });
  // The contract drops what no plan produces any more.
  assert.equal(run.preview.isolation.skillFolders, undefined);
  try {
    setLocale('en');
    const view = buildApprovalCardView(read);
    assert.equal(view.headline.targetLabel, 'skill:demo/assets/rules.md');
    assert.deepEqual(view.targets[0].notes.filter((note) => /skill/.test(note)), ['from skill demo']);
    assert.equal('skillFolders' in buildApprovalCardView(run).isolation, false);
    setLocale('de');
    assert.ok(buildApprovalCardView(read).targets[0].notes.includes('aus dem Skill demo'));
  } finally {
    setLocale('en');
  }
});

test('the security overview names no skill folder as a place to write (en/de)', async () => {
  const { setLocale, t } = await loadRendererI18n();
  try {
    setLocale('en');
    assert.match(t('security.a.where.write'), /^In this folder\. Skill folders stay read-only: what a skill keeps goes into \.agents\/data/);
    assert.match(t('security.a.where.write.noWorkspace'), /^Nowhere: no folder is open, and skill folders are read-only\./);
    assert.equal(t('security.a.where.execute.fact.write'), 'Writes only in this folder and a temporary folder');
    setLocale('de');
    assert.match(t('security.a.where.write'), /^In diesem Ordner\. Skill-Ordner bleiben schreibgeschützt: Was ein Skill aufbewahrt, landet in \.agents\/data/);
    assert.match(t('security.a.where.write.noWorkspace'), /^Nirgends: Kein Ordner ist offen, und Skill-Ordner sind schreibgeschützt\./);
    assert.equal(t('security.a.where.execute.fact.write'), 'Schreibt nur in diesem Ordner und einem temporären Ordner');
  } finally {
    setLocale('en');
  }
});
