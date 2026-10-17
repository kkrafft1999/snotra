'use strict';

// "Make global" for a skill of the open folder (#764): the service moves the
// folder to ~/.snotra/skills and refuses a taken name; the handler confirms
// natively first and carries the switch-on over to the global list.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createSkillsService } = require('../src/main/services/skills-service');
const { registerSkillMoveHandlers } = require('../src/main/ipc/skill-move-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { SKILL_SOURCES } = require('../src/shared/contracts/skills');
const { createMockIpcMain } = require('./helpers/mock-ipc');
const { createNativeConfirmationAdapter } = require('../src/main/adapters/native-confirmation-adapter');

/** The dialog for notices, and the confirmation port over the same dialog (#980). */
function withDialog(dialog) {
  return { dialog, confirmations: createNativeConfirmationAdapter({ dialog }) };
}

async function makeTree(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-make-global-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(home, { recursive: true });
  return { workspace, home };
}

async function writeSkill(baseDir, name, extra = {}) {
  const skillDir = path.join(baseDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: Notes\n---\n\nDo it.\n`, 'utf8');
  for (const [file, text] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(skillDir, file)), { recursive: true });
    await fs.writeFile(path.join(skillDir, file), text, 'utf8');
  }
  return skillDir;
}

const workspaceSkills = (workspace) => path.join(workspace, '.agents', 'skills');
const globalSkills = (home) => path.join(home, '.snotra', 'skills');
const exists = (target) => fs.lstat(target).then(() => true, () => false);

function makeService(home, fsImpl = fs) {
  return createSkillsService({ fs: fsImpl, path, os: { homedir: () => home } });
}

test('a workspace skill moves to ~/.snotra/skills with everything in it, and the catalogue shows it there', async (t) => {
  const { workspace, home } = await makeTree(t);
  await writeSkill(workspaceSkills(workspace), 'release-notes', { 'templates/entry.md': 'Template' });
  const service = makeService(home);
  // Scanned once before, so a stale cache would still show the old source.
  await service.listCatalog({ workspaceRoot: workspace });

  const plan = await service.planMakeGlobal({ workspaceRoot: workspace, name: 'release-notes' });
  assert.equal(plan.from, path.join(workspaceSkills(workspace), 'release-notes'));
  assert.equal(plan.to, path.join(globalSkills(home), 'release-notes'));
  assert.equal(plan.conflict, false);

  const result = await service.makeGlobal({ workspaceRoot: workspace, name: 'release-notes' });
  assert.equal(result.ok, true);
  assert.equal(await exists(plan.from), false, 'gone from the project');
  assert.equal(await fs.readFile(path.join(plan.to, 'templates', 'entry.md'), 'utf8'), 'Template');

  const { skills } = await service.listCatalog({ workspaceRoot: workspace });
  assert.deepEqual(skills.map((skill) => [skill.name, skill.source]), [['release-notes', SKILL_SOURCES.USER_SNOTRA]]);
});

test('a name taken in ~/.snotra/skills is refused and nothing moves', async (t) => {
  const { workspace, home } = await makeTree(t);
  await writeSkill(workspaceSkills(workspace), 'pdf');
  await writeSkill(globalSkills(home), 'pdf');
  await fs.writeFile(path.join(globalSkills(home), 'pdf', 'mine.txt'), 'keep me', 'utf8');
  const service = makeService(home);

  assert.equal((await service.planMakeGlobal({ workspaceRoot: workspace, name: 'pdf' })).conflict, true);
  const result = await service.makeGlobal({ workspaceRoot: workspace, name: 'pdf' });
  assert.equal(result.error, 'conflict');
  assert.equal(await exists(path.join(workspaceSkills(workspace), 'pdf', 'SKILL.md')), true, 'still in the project');
  assert.equal(await fs.readFile(path.join(globalSkills(home), 'pdf', 'mine.txt'), 'utf8'), 'keep me');
});

test('only a usable skill of the open folder can be made global', async (t) => {
  const { workspace, home } = await makeTree(t);
  await writeSkill(globalSkills(home), 'already-global');
  await fs.mkdir(path.join(workspaceSkills(workspace), 'broken'), { recursive: true });
  const service = makeService(home);

  for (const name of ['already-global', 'broken', 'missing', '../escape', '', null]) {
    assert.equal((await service.makeGlobal({ workspaceRoot: workspace, name })).error, 'not-found', String(name));
  }
  assert.equal((await service.planMakeGlobal({ workspaceRoot: null, name: 'release-notes' })).error, 'no-workspace');
});

test('across volumes the folder is copied and the original removed', async (t) => {
  const { workspace, home } = await makeTree(t);
  await writeSkill(workspaceSkills(workspace), 'notes', { 'a/b.txt': 'deep' });
  const crossDevice = {
    ...fs,
    rename: async () => {
      const error = new Error('cross-device link not permitted');
      error.code = 'EXDEV';
      throw error;
    },
  };
  const service = makeService(home, crossDevice);

  assert.equal((await service.makeGlobal({ workspaceRoot: workspace, name: 'notes' })).ok, true);
  assert.equal(await exists(path.join(workspaceSkills(workspace), 'notes')), false);
  assert.equal(await fs.readFile(path.join(globalSkills(home), 'notes', 'a', 'b.txt'), 'utf8'), 'deep');
});

test('a skill switched on in this folder is switched on globally afterwards; one switched off stays off', async (t) => {
  const { workspace, home } = await makeTree(t);
  await writeSkill(workspaceSkills(workspace), 'on-here');
  await writeSkill(workspaceSkills(workspace), 'off-here');
  const service = makeService(home);
  const key = path.resolve(workspace);
  const stored = { activeSkills: ['some-global'], activeWorkspaceSkills: { [key]: ['on-here'], '/other': ['on-here'] } };

  assert.equal(await service.switchOnAfterMakeGlobal({ workspaceRoot: workspace, name: 'off-here', ...stored }), null);
  assert.deepEqual(await service.switchOnAfterMakeGlobal({ workspaceRoot: workspace, name: 'on-here', ...stored }), {
    activeSkills: ['some-global', 'on-here'],
    // Another folder's list is not this move's business.
    activeWorkspaceSkills: { '/other': ['on-here'] },
  });
});

// --- The handler ------------------------------------------------------------

function setupHandler({ workspace, home, answer = 0, prefs = {} }) {
  const ipcMain = createMockIpcMain();
  const service = makeService(home);
  const boxes = [];
  let stored = { activeSkills: null, activeWorkspaceSkills: null, ...prefs };
  registerSkillMoveHandlers({
    ipcMain,
    REQ,
    skillsService: service,
    uiPrefsStore: {
      readUIPrefs: async () => structuredClone(stored),
      updateUIPrefs: async (fn) => { stored = await fn(structuredClone(stored)); },
    },
    getActiveWorkspaceRoot: () => workspace,
    ...withDialog({ showMessageBox: async (options) => { boxes.push(options); return { response: answer }; } }),
    getLocale: () => 'en',
  });
  return { invoke: (name) => ipcMain.invoke(REQ.SKILLS_MAKE_GLOBAL, name), boxes, prefs: () => stored };
}

test('the handler asks first, naming both paths, and Cancel is the default', async (t) => {
  const { workspace, home } = await makeTree(t);
  await writeSkill(workspaceSkills(workspace), 'release-notes');
  const { invoke, boxes } = setupHandler({ workspace, home, answer: 1 });

  assert.deepEqual(await invoke('release-notes'), { cancelled: true });
  assert.equal(boxes.length, 1);
  const [box] = boxes;
  assert.equal(box.message, 'Make the skill “release-notes” global?');
  assert.ok(box.detail.includes(path.join(workspaceSkills(workspace), 'release-notes')), box.detail);
  assert.ok(box.detail.includes(path.join(globalSkills(home), 'release-notes')), box.detail);
  assert.equal(box.defaultId, 1);
  assert.equal(box.cancelId, 1);
  assert.equal(await exists(path.join(workspaceSkills(workspace), 'release-notes')), true, 'nothing moved');
});

test('the handler moves on "Make global" and carries the switch-on over', async (t) => {
  const { workspace, home } = await makeTree(t);
  await writeSkill(workspaceSkills(workspace), 'release-notes');
  const key = path.resolve(workspace);
  const { invoke, boxes, prefs } = setupHandler({
    workspace,
    home,
    prefs: { activeSkills: [], activeWorkspaceSkills: { [key]: ['release-notes'] } },
  });

  const result = await invoke('release-notes');
  assert.equal(result.ok, true);
  assert.ok(boxes[0].detail.includes('switched on in every folder'), 'the dialog says it stays on');
  assert.equal(await exists(path.join(globalSkills(home), 'release-notes', 'SKILL.md')), true);
  assert.deepEqual(prefs().activeSkills, ['release-notes']);
  assert.deepEqual(prefs().activeWorkspaceSkills, {});
});

test('the handler refuses a taken name with a dialog and asks nothing', async (t) => {
  const { workspace, home } = await makeTree(t);
  await writeSkill(workspaceSkills(workspace), 'pdf');
  await writeSkill(globalSkills(home), 'pdf');
  const { invoke, boxes } = setupHandler({ workspace, home });

  const result = await invoke('pdf');
  assert.equal(result.conflict, true);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].type, 'error');
  assert.equal(boxes[0].message, 'There already is a global skill named “pdf”');
  assert.ok(boxes[0].detail.includes(path.join(globalSkills(home), 'pdf')));
  assert.equal(await exists(path.join(workspaceSkills(workspace), 'pdf', 'SKILL.md')), true);
});
