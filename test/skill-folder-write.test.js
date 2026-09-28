// Writing to the folder of a loaded skill (#429): the planner lets a write
// reach only the skills loaded in the run, execution runs get their folders
// in the sandbox, the file tools work without an open folder while a skill is
// on, and the card names what the call touches.

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

const loadRenderer = (file) =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'utils', file)).href);
const loadRendererI18n = () =>
  import(pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'i18n.js')).href);

async function makeFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-skill-write-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'projekt');
  const skillDir = path.join(base, 'skills', 'demo');
  await fs.mkdir(path.join(skillDir, 'assets'), { recursive: true });
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: d\n---\n\nRules in assets/.\n', 'utf8');
  await fs.writeFile(path.join(skillDir, 'assets', 'rules.md'), 'Rule A\n', 'utf8');
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  return {
    base,
    workspace,
    skillDir,
    realSkillDir: await fs.realpath(skillDir),
    fsService,
    skillRoots: [{ name: 'demo', dir: skillDir }],
  };
}

function makePlanner(fsService, opts = {}) {
  return createToolCallPlanner({ fsService, fs, path, canTrash: false, ...opts });
}

// ── Planner: writes ────────────────────────────────────────────────────────

test('a write reaches the folder of a loaded skill as an ordinary write', async (t) => {
  const { workspace, skillDir, fsService, skillRoots } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService });
  const planner = makePlanner(fsService);
  const definition = registry.getDefinition('edit_file');
  const args = { relative_path: path.join(skillDir, 'assets', 'rules.md'), old_string: 'Rule A', new_string: 'Rule B' };

  const plan = await planner.plan(definition, args, { workspaceRoot: workspace, skillRoots, writableSkills: ['demo'] });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.riskClasses, ['write']);
  assert.equal(plan.targets[0].skillName, 'demo');
  assert.equal(plan.targets[0].skillPath, 'skill:demo/assets/rules.md');

  // Not loaded in this run: a hard limit, whatever the mode.
  const closed = await planner.plan(definition, args, { workspaceRoot: workspace, skillRoots, writableSkills: [] });
  assert.equal(closed.reason, 'hard_limit');
  assert.match(closed.error, /read-only here/);
});

test('a skill write works without an open folder', async (t) => {
  const { skillDir, fsService, skillRoots } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService });
  const planner = makePlanner(fsService);
  const args = { relative_path: 'skill:demo/assets/new.md', content: 'x\n' };

  const plan = await planner.plan(registry.getDefinition('write_file_text'), args, { workspaceRoot: '', skillRoots, writableSkills: ['demo'] });
  assert.equal(plan.error, undefined);
  const out = JSON.parse(await registry.execute('write_file_text', args, { approved: true, workspaceRoot: null, skillRoots, writableSkills: ['demo'] }));
  assert.equal(out.error, undefined);
  assert.equal(await fs.readFile(path.join(skillDir, 'assets', 'new.md'), 'utf8'), 'x\n');

  // A workspace path still needs the workspace.
  const plain = await planner.plan(registry.getDefinition('write_file_text'), { relative_path: 'a.md', content: 'x' }, { workspaceRoot: '', skillRoots, writableSkills: ['demo'] });
  assert.equal(plain.reason, 'hard_limit');
});

// ── Planner: execution runs ────────────────────────────────────────────────

test('an isolated run gets the real folders of the loaded skills, and the card names them', async (t) => {
  const { base, workspace, realSkillDir, fsService } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService });
  // Configured under a symlinked skills directory, like ~/.agents/skills.
  const linked = path.join(base, 'linked');
  await fs.symlink(path.join(base, 'skills'), linked, 'dir');
  const skillRoots = [{ name: 'demo', dir: path.join(linked, 'demo') }];
  const planner = makePlanner(fsService, { describeSandbox: async () => ({ isolated: true }) });
  const definition = registry.getDefinition('shell_execute');
  const args = { command: 'ls' };

  const plan = await planner.plan(definition, args, { workspaceRoot: workspace, skillRoots, writableSkills: ['demo'] });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.sandbox.skillFolders, [{ name: 'demo', path: realSkillDir }]);
  assert.deepEqual(plan.preview.isolation.skillFolders, [{ name: 'demo', path: realSkillDir }]);

  const without = await planner.plan(definition, args, { workspaceRoot: workspace, skillRoots, writableSkills: [] });
  assert.equal(without.sandbox.skillFolders, undefined);
  assert.equal(without.preview.isolation.skillFolders, undefined);
  // What the card showed is what was approved.
  assert.notEqual(plan.planKey, without.planKey);

  const python = await planner.plan(registry.getDefinition('run_python'), { code: 'print(1)' }, { workspaceRoot: workspace, skillRoots, writableSkills: ['demo'] });
  assert.deepEqual(python.sandbox.skillFolders, [{ name: 'demo', path: realSkillDir }]);
});

test('without a sandbox there is nothing to widen', async (t) => {
  const { workspace, fsService, skillRoots } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService });
  const planner = makePlanner(fsService, { describeSandbox: async () => ({ isolated: true }), isSandboxDisabled: async () => true });
  const plan = await planner.plan(registry.getDefinition('shell_execute'), { command: 'ls' }, { workspaceRoot: workspace, skillRoots, writableSkills: ['demo'] });
  assert.equal(plan.sandbox.disabled, true);
  assert.equal(plan.sandbox.skillFolders, undefined);
});

test('shell_execute runs in a skill folder, and such a command is never remembered', async (t) => {
  const { workspace, skillDir, fsService, skillRoots } = await makeFixture(t);
  const calls = [];
  const registry = createWorkspaceToolRegistry({
    fsService,
    shellRunner: {
      isAvailable: () => true,
      async run(request) {
        calls.push(request);
        return {
          stdout: '', stderr: '', exitCode: 0, timedOut: false, aborted: false, truncated: false, durationMs: 1, shell: 'zsh',
          isolation: { isolated: true, domains: [], skillWritePaths: [skillDir] },
        };
      },
    },
  });
  const planner = makePlanner(fsService);
  const args = { command: 'python3 scripts/update.py', cwd: 'skill:demo' };

  const plan = await planner.plan(registry.getDefinition('shell_execute'), args, { workspaceRoot: workspace, skillRoots, writableSkills: ['demo'] });
  assert.equal(plan.error, undefined);
  assert.equal(plan.shellCommand.command, null);
  // The card shows the working folder the way the model named it.
  assert.equal(plan.preview.cwd, 'skill:demo');

  const out = JSON.parse(await registry.execute('shell_execute', args, {
    approved: true, workspaceRoot: workspace, skillRoots, plan: { ...plan, sandbox: { skillFolders: [{ name: 'demo', path: skillDir }] } },
  }));
  assert.equal(calls[0].cwd, path.resolve(skillDir));
  assert.deepEqual(calls[0].skillWritePaths, [skillDir]);
  assert.deepEqual(out.sandbox.skill_write_paths, [skillDir]);

  // A skill that is not switched on is no working folder.
  const unknown = await planner.plan(registry.getDefinition('shell_execute'), { command: 'ls', cwd: 'skill:other' }, { workspaceRoot: workspace, skillRoots });
  assert.equal(unknown.reason, 'hard_limit');
});

test('run_python passes the skill folders of its plan and nothing else', async (t) => {
  const { workspace, fsService } = await makeFixture(t);
  const calls = [];
  const registry = createWorkspaceToolRegistry({
    fsService,
    pythonRunner: {
      isAvailable: () => true,
      async run(request) {
        calls.push(request);
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 1 };
      },
    },
  });
  await registry.execute('run_python', { code: 'print(1)' }, {
    approved: true, workspaceRoot: workspace, plan: { sandbox: { skillFolders: [{ name: 'demo', path: '/s/demo' }] } },
  });
  await registry.execute('run_python', { code: 'print(1)' }, { approved: true, workspaceRoot: workspace });
  assert.deepEqual(calls[0].skillWritePaths, ['/s/demo']);
  assert.deepEqual(calls[1].skillWritePaths, []);
});

// ── Spawn ──────────────────────────────────────────────────────────────────

test('planSpawn hands the skill folders to the sandbox and reports them apart from an allowance', async () => {
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
  assert.deepEqual(requests[0].extraWritePaths, ['/cache', '/s/demo']);
  assert.deepEqual(target.isolation, { isolated: true, domains: [], writePaths: ['/cache'], skillWritePaths: ['/s/demo'] });

  const plain = await planSpawn({ sandbox, argv: ['/bin/zsh', '-c', 'ls'], runTmp: '/tmp/x', domains: [] });
  assert.deepEqual(requests[1].extraWritePaths, []);
  assert.deepEqual(plain.isolation, { isolated: true, domains: [] });
});

// ── Tools without an open folder ───────────────────────────────────────────

test('without a folder the file tools stay on while a skill is switched on', async (t) => {
  const { fsService } = await makeFixture(t);
  const registry = createWorkspaceToolRegistry({ fsService, shellRunner: { isAvailable: () => true, run: async () => ({}) } });
  const names = (options) => registry.getTools(options).map((tool) => tool.function.name);

  const withSkill = names({ workspaceOpen: false, skillNames: ['demo'] });
  for (const name of ['read_file_text', 'list_directory', 'find_files', 'write_file_text', 'edit_file', 'apply_patch', 'load_skill']) {
    assert.ok(withSkill.includes(name), name);
  }
  assert.equal(withSkill.includes('shell_execute'), false);
  assert.equal(names({ workspaceOpen: false, skillNames: [] }).includes('read_file_text'), false);

  const prompt = registry.buildSystemPrompt({ workspaceOpen: false, skillNames: ['demo'] });
  assert.match(prompt, /No folder is open, so the file tools reach only the folders of the switched-on skills/);
  assert.doesNotMatch(prompt, /relative to the folder root/);
});

// ── Card ───────────────────────────────────────────────────────────────────

test('card: the approval request keeps the skill of a target, and its session scope names the skill path', () => {
  const plan = {
    riskClasses: ['write'],
    planKey: 'p',
    targets: [{ path: '/abs/demo/assets/rules.md', kind: 'file', exists: true, version: '1:2', skillName: 'demo', skillPath: 'skill:demo/assets/rules.md' }],
  };
  const request = buildApprovalRequest({ tool: 'edit_file', plan, askClasses: ['write'], mode: 'smart' });
  assert.equal(request.targets[0].skillName, 'demo');
  assert.equal(request.targets[0].skillPath, 'skill:demo/assets/rules.md');
  assert.match(JSON.stringify(request.sessionScope), /skill:demo\/assets\/rules\.md/);

  const plain = buildApprovalRequest({ tool: 'edit_file', plan: { ...plan, targets: [{ path: 'a.md', kind: 'file' }] }, askClasses: ['write'], mode: 'smart' });
  assert.equal('skillName' in plain.targets[0], false);
});

function cardDto(fields) {
  return createToolApprovalRequestDto({ requestId: 'r1', mode: 'smart', ...fields });
}

test('card: the contract carries the skill of a target and the skill folders of a run', () => {
  const write = cardDto({
    tool: 'edit_file', riskClasses: ['write'],
    targets: [{ path: '/abs/demo/assets/rules.md', kind: 'file', exists: true, skillName: 'demo', skillPath: 'skill:demo/assets/rules.md' }],
  });
  assert.equal(write.targets[0].skillName, 'demo');
  assert.equal(write.targets[0].skillPath, 'skill:demo/assets/rules.md');

  const run = cardDto({
    tool: 'shell_execute', riskClasses: ['execute'], targets: [],
    preview: { kind: 'text', text: 'ls', isolation: { isolated: true, domains: [], skillFolders: [{ name: 'demo', path: '/s/demo', extra: 1 }, { name: '' }] } },
  });
  assert.deepEqual(run.preview.isolation.skillFolders, [{ name: 'demo', path: '/s/demo' }]);
});

test('card: says which skill a write changes and where a run may write (en/de)', async () => {
  const { setLocale } = await loadRendererI18n();
  const { buildApprovalCardView } = await loadRenderer('tool-approval-view.js');
  const write = cardDto({
    tool: 'edit_file', riskClasses: ['write'],
    targets: [{ path: '/Users/u/.claude/skills/demo/assets/rules.md', kind: 'file', exists: true, skillName: 'demo', skillPath: 'skill:demo/assets/rules.md' }],
  });
  const read = cardDto({
    tool: 'read_file_text', riskClasses: ['read'],
    targets: [{ path: 'skill:demo/assets/rules.md', kind: 'file', exists: true, skillName: 'demo', skillPath: 'skill:demo/assets/rules.md' }],
  });
  const one = cardDto({
    tool: 'shell_execute', riskClasses: ['execute'], targets: [],
    preview: { kind: 'text', text: 'ls', isolation: { isolated: true, domains: [], skillFolders: [{ name: 'demo', path: '/Users/u/.claude/skills/demo' }] } },
  });
  const two = cardDto({
    tool: 'shell_execute', riskClasses: ['execute'], targets: [],
    preview: {
      kind: 'text', text: 'ls',
      isolation: { isolated: true, domains: [], skillFolders: [{ name: 'a', path: '/s/a' }, { name: 'b', path: '/s/b' }] },
    },
  });
  try {
    setLocale('en');
    const view = buildApprovalCardView(write);
    assert.equal(view.headline.targetLabel, 'skill:demo/assets/rules.md');
    assert.equal(view.targets[0].path, 'skill:demo/assets/rules.md');
    assert.ok(view.targets[0].notes.includes('changes skill demo wherever it is switched on'));
    assert.ok(buildApprovalCardView(read).targets[0].notes.includes('from skill demo'));
    assert.deepEqual(buildApprovalCardView(one, { homeDir: '/Users/u' }).isolation.skillFolders, {
      prefix: 'Loaded skills:',
      text: 'also writes in the folder of demo, ~/.claude/skills/demo.',
    });
    assert.equal(buildApprovalCardView(two).isolation.skillFolders.text, 'also writes in their folders: a (/s/a), b (/s/b).');
    assert.equal(buildApprovalCardView(cardDto({
      tool: 'shell_execute', riskClasses: ['execute'], targets: [],
      preview: { kind: 'text', text: 'ls', isolation: { isolated: true, domains: [] } },
    })).isolation.skillFolders, null);

    setLocale('de');
    assert.ok(buildApprovalCardView(write).targets[0].notes.includes('ändert den Skill demo überall, wo er eingeschaltet ist'));
    assert.deepEqual(buildApprovalCardView(one, { homeDir: '/Users/u' }).isolation.skillFolders, {
      prefix: 'Geladene Skills:',
      text: 'schreibt auch in den Ordner von demo, ~/.claude/skills/demo.',
    });
  } finally {
    setLocale('en');
  }
});

test('card: a command in a skill folder says why it cannot be remembered (en/de)', async () => {
  const plan = {
    riskClasses: ['execute'],
    planKey: 'p',
    targets: [],
    shellCommand: { command: 'ls', cwd: '', networkDomains: [], stdin: false, skillFolder: true },
  };
  const request = buildApprovalRequest({ tool: 'shell_execute', plan, askClasses: ['execute'], mode: 'smart', workspaceRoot: '/ws' });
  assert.equal(request.alwaysUnavailableReason, 'skill-folder');
  assert.equal(request.alwaysRule, undefined);

  const { setLocale } = await loadRendererI18n();
  const { alwaysActionHint } = await loadRenderer('tool-approval-view.js');
  const dto = cardDto({ tool: 'shell_execute', riskClasses: ['execute'], targets: [], alwaysUnavailableReason: 'skill-folder' });
  try {
    setLocale('en');
    assert.match(alwaysActionHint(dto), /A command in a skill folder cannot be remembered/);
    setLocale('de');
    assert.match(alwaysActionHint(dto), /Ein Befehl im Skill-Ordner lässt sich nicht merken/);
  } finally {
    setLocale('en');
  }
});
