// A global skill folder inside the open folder stays read-only (#650).
//
// "The workspace wins" made an absolute or relative path into
// `~/.snotra/skills` or `~/.agents/skills` a plain workspace write as soon as
// the open folder was the home folder or another ancestor — a way around the
// read-only rule of #548. Workspace skills and `.agents/data` are project
// files and stay writable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');

const READ_ONLY = /Skill folders are read-only\. Keep what a skill produces in "\.agents\/data\/" in the open folder\./;
const SKILL_TEXT = '---\nname: demo\ndescription: d\n---\n\nBe helpful.\n';

async function makeHome(t) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-global-skill-')));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const snotraSkills = path.join(home, '.snotra', 'skills');
  const agentsSkills = path.join(home, '.agents', 'skills');
  const demo = path.join(snotraSkills, 'demo');
  const legacy = path.join(agentsSkills, 'legacy');
  for (const dir of [demo, legacy]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), SKILL_TEXT, 'utf8');
  }
  const fsService = createFsService({
    fs,
    path,
    maxReadFileBytes: 1024 * 1024,
    maxWriteFileBytes: 1024 * 1024,
    globalSkillRoots: [snotraSkills, agentsSkills],
  });
  const registry = createWorkspaceToolRegistry({ fsService });
  const planner = createToolCallPlanner({ fsService, fs, path, canTrash: false });
  const skillRoots = [{ name: 'demo', dir: demo }, { name: 'legacy', dir: legacy }];
  return { home, demo, legacy, fsService, registry, planner, skillRoots };
}

/** Every write tool, aimed at one file. */
function writeCalls(target) {
  return [
    ['write_file_text', { relative_path: target, content: 'INJECTED\n' }],
    ['edit_file', { relative_path: target, old_string: 'Be helpful.', new_string: 'INJECTED' }],
    ['apply_patch', { relative_path: target, edits: [{ old_string: 'Be helpful.', new_string: 'INJECTED' }] }],
  ];
}

test('every write tool refuses a global skill folder the open folder contains', async (t) => {
  const { home, demo, legacy, registry, planner, skillRoots } = await makeHome(t);
  for (const workspaceRoot of [home, path.join(home, '.snotra'), path.join(home, '.agents')]) {
    for (const skillDir of [demo, legacy]) {
      if (!skillDir.startsWith(workspaceRoot + path.sep)) continue;
      const file = path.join(skillDir, 'SKILL.md');
      const relative = path.relative(workspaceRoot, file).split(path.sep).join('/');
      for (const target of [file, relative]) {
        for (const [tool, args] of writeCalls(target)) {
          const label = `${tool} ${target} in ${path.relative(home, workspaceRoot) || '~'}`;
          const plan = await planner.plan(registry.getDefinition(tool), args, { workspaceRoot, skillRoots });
          assert.equal(plan.reason, 'hard_limit', label);
          assert.match(plan.error, READ_ONLY, label);
          // Execution checks again, whatever the plan said.
          const out = JSON.parse(await registry.execute(tool, args, { approved: true, workspaceRoot, skillRoots }));
          assert.match(out.error, READ_ONLY, label);
        }
      }
      assert.equal(await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), SKILL_TEXT);
    }
  }
});

test('a new skill cannot be planted in a global skill folder either', async (t) => {
  const { home, registry, planner, skillRoots } = await makeHome(t);
  for (const target of ['.snotra/skills/evil/SKILL.md', path.join(home, '.agents', 'skills', 'evil', 'SKILL.md')]) {
    const args = { relative_path: target, content: SKILL_TEXT };
    const plan = await planner.plan(registry.getDefinition('write_file_text'), args, { workspaceRoot: home, skillRoots });
    assert.equal(plan.reason, 'hard_limit', target);
    assert.match(plan.error, READ_ONLY);
  }
  await assert.rejects(fs.access(path.join(home, '.snotra', 'skills', 'evil')));
  await assert.rejects(fs.access(path.join(home, '.agents', 'skills', 'evil')));
});

test('a symlink inside the open folder does not lead around it', { skip: process.platform === 'win32' }, async (t) => {
  const { home, registry, planner, skillRoots } = await makeHome(t);
  await fs.symlink(path.join(home, '.agents', 'skills'), path.join(home, 'linked-skills'));
  const args = { relative_path: 'linked-skills/legacy/SKILL.md', content: 'INJECTED\n' };
  const plan = await planner.plan(registry.getDefinition('write_file_text'), args, { workspaceRoot: home, skillRoots });
  assert.equal(plan.reason, 'hard_limit');
  assert.match(plan.error, READ_ONLY);
});

test('reading a global skill through the open folder still works', async (t) => {
  const { home, registry, planner, skillRoots } = await makeHome(t);
  const args = { relative_path: '.snotra/skills/demo/SKILL.md' };
  const plan = await planner.plan(registry.getDefinition('read_file_text'), args, { workspaceRoot: home, skillRoots });
  assert.equal(plan.error, undefined);
  const out = JSON.parse(await registry.execute('read_file_text', args, { approved: true, workspaceRoot: home, skillRoots }));
  assert.equal(out.error, undefined);
  assert.match(out.content, /Be helpful\./);
});

test('.agents/data next to a global skill folder stays an ordinary write', async (t) => {
  const { home, registry, planner, skillRoots } = await makeHome(t);
  const args = { relative_path: '.agents/data/x.md', content: '- Anna\n' };
  const plan = await planner.plan(registry.getDefinition('write_file_text'), args, { workspaceRoot: home, skillRoots });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.riskClasses, ['write']);
  const out = JSON.parse(await registry.execute('write_file_text', args, { approved: true, workspaceRoot: home, skillRoots }));
  assert.equal(out.error, undefined);
  assert.equal(await fs.readFile(path.join(home, '.agents', 'data', 'x.md'), 'utf8'), '- Anna\n');
});

test('a workspace skill is a project file and stays writable', async (t) => {
  const { home, registry, planner, skillRoots } = await makeHome(t);
  const project = path.join(home, 'project');
  const local = path.join(project, '.agents', 'skills', 'local');
  await fs.mkdir(local, { recursive: true });
  await fs.writeFile(path.join(local, 'SKILL.md'), SKILL_TEXT, 'utf8');
  const roots = [...skillRoots, { name: 'local', dir: local }];
  for (const target of ['.agents/skills/local/SKILL.md', path.join(local, 'SKILL.md')]) {
    const args = { relative_path: target, old_string: 'Be helpful.', new_string: 'Be brief.' };
    const plan = await planner.plan(registry.getDefinition('edit_file'), args, { workspaceRoot: project, skillRoots: roots });
    assert.equal(plan.error, undefined, target);
    const out = JSON.parse(await registry.execute('edit_file', args, { approved: true, workspaceRoot: project, skillRoots: roots }));
    assert.equal(out.error, undefined, target);
    await fs.writeFile(path.join(local, 'SKILL.md'), SKILL_TEXT, 'utf8');
  }
});
