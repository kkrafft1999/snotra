// File tools outside the open folder (#792, step 4): what a card may offer,
// how a grant becomes a root, how the planner reports a path outside, and
// that the tools then read and write exactly there and nowhere else. The
// engine's side is in chat-engine-permissions.test.js, the card's in
// sandbox-approval-card-dom.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createOutsideAccess, outsideRootsFrom, OUTSIDE_WORKSPACE } = require('../src/main/services/outside-access');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createToolCallPlanner } = require('../src/main/tools/tool-call-planner');
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');
const { normalizeSandboxOutside } = require('../src/shared/contracts/chat');
const { toolTraceEntryForStore } = require('../src/main/services/chat-history-normalization');

const posixOnly = { skip: process.platform === 'win32' ? 'POSIX paths' : false };

// ── What a card may offer ───────────────────────────────────────────────────

const HOME = '/Users/me';
function access(realPaths = {}) {
  return createOutsideAccess({
    path: path.posix,
    homeDir: HOME,
    platform: 'darwin',
    userDataPath: `${HOME}/Library/Application Support/Snotra AI`,
    globalSkillRoots: [`${HOME}/.snotra/skills`],
    realPath: async (p) => realPaths[p] || p,
  });
}
const offered = async (a, absPath, isDirectory, mode) =>
  (await a.offer({ absPath, isDirectory, access: mode })).map((o) => `${o.file ? 'file' : 'folder'} ${o.path}`);

test('a file is offered as itself and as its folder — never a folder many programs share', posixOnly, async () => {
  const a = access();
  assert.deepEqual(await offered(a, `${HOME}/Documents/move/plan.md`, false, 'read'),
    [`file ${HOME}/Documents/move/plan.md`, `folder ${HOME}/Documents/move`]);
  assert.deepEqual(await offered(a, `${HOME}/Documents/plan.md`, false, 'read'), [`file ${HOME}/Documents/plan.md`]);
  assert.deepEqual(await offered(a, '/opt/data/sets', true, 'read'), ['folder /opt/data/sets', 'folder /opt/data']);
  assert.deepEqual(await offered(a, '/etc/hosts', false, 'read'), ['file /etc/hosts']);
  assert.deepEqual(await offered(a, `${HOME}/notes/todo.md`, false, 'write'),
    [`file ${HOME}/notes/todo.md`, `folder ${HOME}/notes`]);
});

test('never the home folder, a disk\'s root or Snotra\'s storage — for reading or writing', posixOnly, async () => {
  const a = access();
  for (const mode of ['read', 'write']) {
    assert.deepEqual(await offered(a, HOME, true, mode), [], `home, ${mode}`);
    assert.deepEqual(await offered(a, '/', true, mode), [], `root, ${mode}`);
    assert.deepEqual(await offered(a, `${HOME}/Library/Application Support/Snotra AI/llm-config.json`, false, mode), [], `own storage, ${mode}`);
    assert.deepEqual(await offered(a, `${HOME}/Library/Application Support`, true, mode), [], `around own storage, ${mode}`);
  }
});

test('credentials: read exactly, never a folder around them, never written; shell start-up files never written', posixOnly, async () => {
  const a = access();
  assert.deepEqual(await offered(a, `${HOME}/.ssh/config`, false, 'read'), [`file ${HOME}/.ssh/config`]);
  assert.deepEqual(await offered(a, `${HOME}/.ssh`, true, 'read'), [`folder ${HOME}/.ssh`]);
  assert.deepEqual(await offered(a, `${HOME}/Library`, true, 'read'), [], 'it holds the keychain');
  assert.deepEqual(await offered(a, `${HOME}/.ssh/config`, false, 'write'), []);
  assert.deepEqual(await offered(a, `${HOME}/.zshrc`, false, 'write'), []);
  assert.deepEqual(await offered(a, `${HOME}/.zshrc`, false, 'read'), [`file ${HOME}/.zshrc`]);
  assert.deepEqual(await offered(a, `${HOME}/.snotra/skills/demo/SKILL.md`, false, 'write'), []);
});

test('a link is judged by where it leads', posixOnly, async () => {
  const a = access({ '/tmp/keys': `${HOME}/.ssh`, '/tmp/keys/id': `${HOME}/.ssh/id` });
  assert.deepEqual(await offered(a, '/tmp/keys/id', false, 'write'), []);
  assert.equal(await a.isAllowed({ path: '/tmp/keys', file: false, access: 'write' }), false);
  assert.equal(await a.isAllowed({ path: '/opt/data', file: false, access: 'write' }), true);
});

test('a grant becomes a root: a folder as itself, a file as its folder with that one name', () => {
  assert.deepEqual(outsideRootsFrom([
    { path: '/opt/data', file: false, access: 'read' },
    { path: '/opt/notes/todo.md', file: true, access: 'write' },
    { path: 'relative', file: false },
    null,
  ], path.posix), [
    { root: '/opt/data', only: null, access: 'read' },
    { root: '/opt/notes', only: 'todo.md', access: 'write' },
  ]);
});

// ── Resolving, planning and running against a grant ─────────────────────────

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-outside-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const workspace = path.join(home, 'project');
  const notes = path.join(home, 'notes');
  const userData = path.join(home, 'user-data');
  for (const dir of [workspace, path.join(notes, 'sub'), userData, path.join(home, '.ssh')]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(notes, 'todo.md'), '- boxes\n');
  await fs.writeFile(path.join(notes, 'other.md'), 'other\n');
  await fs.writeFile(path.join(home, '.ssh', 'config'), 'Host x\n');
  await fs.symlink('/etc', path.join(notes, 'sub', 'etc'));
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024, homeDir: home });
  const outsideAccess = createOutsideAccess({
    path, homeDir: home, platform: process.platform, userDataPath: userData,
    realPath: (p) => fsService.resolveExistingRealPath(p),
  });
  const registry = createWorkspaceToolRegistry({ fsService });
  const planner = createToolCallPlanner({ fsService, fs, path, protectedRoots: [userData], canTrash: false, outsideAccess });
  return { base, home, workspace, notes, fsService, registry, planner };
}

test('fs-service reports a path outside the open folder, and resolves it through a grant', posixOnly, async (t) => {
  const { workspace, notes, fsService } = await fixture(t);
  const todo = path.join(notes, 'todo.md');
  for (const spelling of [todo, '~/notes/todo.md', '../notes/todo.md']) {
    assert.deepEqual(await fsService.resolveToolPath(workspace, spelling),
      { error: 'Path is outside the workspace folder.', code: OUTSIDE_WORKSPACE, absPath: todo }, spelling);
  }
  const read = outsideRootsFrom([{ path: notes, file: false, access: 'read' }], path);
  const resolved = await fsService.resolveToolPath(workspace, todo, { outsideRoots: read });
  assert.deepEqual(resolved, { absPath: todo, root: notes, prefix: `${notes}/`, skillName: null, outside: true });
  assert.equal((await fsService.resolveToolPath(workspace, todo, { outsideRoots: read, access: 'write' })).code,
    OUTSIDE_WORKSPACE, 'a read grant does not write');
  assert.match((await fsService.resolveToolPath(workspace, path.join(notes, 'sub', 'etc', 'hosts'), { outsideRoots: read })).error,
    /outside what the user allowed/, 'a link out of the granted folder stays closed');
  const file = outsideRootsFrom([{ path: todo, file: true, access: 'write' }], path);
  assert.equal((await fsService.resolveToolPath(workspace, '~/notes/todo.md', { outsideRoots: file, access: 'write' })).absPath, todo);
  assert.equal((await fsService.resolveToolPath(workspace, path.join(notes, 'other.md'), { outsideRoots: file })).code,
    OUTSIDE_WORKSPACE, 'a file grant opens that one file');
});

test('the planner offers a path outside instead of refusing it, and refuses what may not be offered', posixOnly, async (t) => {
  const { home, workspace, notes, registry, planner } = await fixture(t);
  const todo = path.join(notes, 'todo.md');
  const plan = await planner.plan(registry.getDefinition('edit_file'),
    { relative_path: '~/notes/todo.md', old_string: 'boxes', new_string: 'order boxes' }, { workspaceRoot: workspace });
  assert.equal(plan.error, undefined);
  assert.equal(plan.outside, true);
  assert.deepEqual(plan.riskClasses, ['write']);
  const [target] = plan.targets;
  assert.deepEqual(
    { path: target.path, absPath: target.absPath, kind: target.kind, access: target.access, exists: target.exists, rulePaths: target.rulePaths },
    { path: '~/notes/todo.md', absPath: todo, kind: 'file', access: 'write', exists: true, rulePaths: [todo] },
  );
  assert.deepEqual(target.outside.offers, [
    { path: todo, file: true, access: 'write' },
    { path: notes, file: false, access: 'write' },
  ]);

  const homeListing = await planner.plan(registry.getDefinition('list_directory'), { relative_path: home }, { workspaceRoot: workspace });
  assert.equal(homeListing.reason, 'hard_limit');
  assert.match(homeListing.error, /^Path is outside the workspace folder\. This location cannot be opened/);

  const ssh = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: '~/.ssh/config' }, { workspaceRoot: workspace });
  assert.deepEqual(ssh.riskClasses, ['read', 'read-sensitive'], 'a place with credentials is sensitive outside as well');
  assert.equal(ssh.targets[0].sensitive, true);
});

test('with a grant the call is planned like one in the open folder — no rule of the open folder reads its paths', posixOnly, async (t) => {
  const { workspace, notes, registry, planner } = await fixture(t);
  const todo = path.join(notes, 'todo.md');
  const plan = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: todo }, {
    workspaceRoot: workspace,
    outsideGrants: [{ path: notes, file: false, access: 'read' }],
  });
  assert.equal(plan.outside, undefined);
  assert.equal(plan.targets[0].outsideGranted, true);
  assert.deepEqual(plan.targets[0].rulePaths, [todo], 'absolute, so `**/*.md` of the open folder does not match');
  const refused = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: todo }, {
    workspaceRoot: workspace,
    outsideGrants: [{ path: '/', file: false, access: 'read' }],
  });
  assert.equal(refused.outside, true, 'a grant that may not be given is ignored');
});

test('the tools read, list and write exactly what a grant opened', posixOnly, async (t) => {
  const { workspace, notes, registry } = await fixture(t);
  const roots = outsideRootsFrom([{ path: notes, file: false, access: 'write' }], path);
  const context = { workspaceRoot: workspace, outsideRoots: roots, approved: true };
  const read = JSON.parse(await registry.execute('read_file_text', { relative_path: path.join(notes, 'todo.md') }, context));
  assert.match(read.content, /boxes/);
  const listing = JSON.parse(await registry.execute('list_directory', { relative_path: '~/notes' }, context));
  assert.deepEqual(listing.items.map((i) => i.name).sort(), ['other.md', 'sub', 'todo.md']);
  const written = JSON.parse(await registry.execute('write_file_text', { relative_path: '~/notes/new.md', content: 'new\n' }, context));
  assert.equal(written.created, true);
  assert.equal(await fs.readFile(path.join(notes, 'new.md'), 'utf8'), 'new\n');
  const edited = JSON.parse(await registry.execute('edit_file',
    { relative_path: path.join(notes, 'todo.md'), old_string: 'boxes', new_string: 'order boxes' }, context));
  assert.equal(edited.error, undefined, JSON.stringify(edited));
  assert.match(await fs.readFile(path.join(notes, 'todo.md'), 'utf8'), /order boxes/);
  const without = JSON.parse(await registry.execute('write_file_text', { relative_path: '~/notes/x.md', content: 'x' }, { workspaceRoot: workspace, approved: true }));
  assert.equal(without.error, 'Path is outside the workspace folder.');
});

// ── What travels to the card and into the history ───────────────────────────

test('the card before the call carries `before` and which places hold credentials', () => {
  const dto = createToolApprovalRequestDto({
    requestId: 'r', tool: 'read_file_text', riskClasses: ['read', 'read-sensitive'], targets: [], checkpoint: 'sandbox',
    sandbox: {
      before: true, command: '', run: {}, output: '', others: [], raw: [],
      entries: [{ kind: 'read', target: '/Users/me/.ssh/config', count: 1, folder: false, sensitive: true, allow: ['/Users/me/.ssh/config'] }],
    },
  });
  assert.equal(dto.sandbox.before, true);
  assert.deepEqual(dto.sandbox.entries[0], {
    kind: 'read', target: '/Users/me/.ssh/config', count: 1, folder: false, allow: ['/Users/me/.ssh/config'], sensitive: true,
  });
});

test('the decisions before a call outside, kept with the tool row and in the history', () => {
  const decisions = [
    { kind: 'write', target: '/opt/notes/todo.md', outcome: 'allowed', duration: 'session', pattern: '/opt/notes' },
    { kind: 'read', target: '/opt/a', outcome: 'allowed' },
    { kind: 'other', target: '/opt/b', outcome: 'denied', duration: 'session' },
    { kind: 'read', target: '', outcome: 'allowed' },
  ];
  const expected = [
    { kind: 'write', target: '/opt/notes/todo.md', outcome: 'allowed', duration: 'session', pattern: '/opt/notes' },
    { kind: 'read', target: '/opt/a', outcome: 'allowed', duration: 'call', pattern: '/opt/a' },
    { kind: 'read', target: '/opt/b', outcome: 'denied' },
  ];
  assert.deepEqual(normalizeSandboxOutside(decisions), expected);
  assert.deepEqual(toolTraceEntryForStore({ line: 'Read: /opt/a', tool: 'read_file_text', sandboxOutside: decisions }).sandboxOutside, expected);
});
