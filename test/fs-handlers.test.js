const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createFilesystemIpcAdapter } = require('../src/main/adapters/filesystem-ipc-adapter');
const { registerFsHandlers } = require('../src/main/ipc/fs-handlers');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

async function createSymlinkOrSkip(t, target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) {
      t.skip(`Symlinks werden auf dieser Plattform nicht unterstützt: ${e.code}`);
      return false;
    }
    throw e;
  }
}

async function setup(t) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const workspace = path.join(tmpDir, 'workspace');
  const outside = path.join(tmpDir, 'outside');
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(workspace, 'inside.txt'), 'inside', 'utf8');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');

  let activeWorkspaceRoot = workspace;
  const fsService = createFsService({ fs, path, maxReadFileBytes: 2 * 1024 * 1024 });
  const filesystem = createFilesystemIpcAdapter({
    fsService,
    getActiveWorkspaceRoot: () => activeWorkspaceRoot,
  });
  const ipcMain = createMockIpcMain();
  const popups = [];
  const pushed = [];
  const mainWindow = {
    id: 'main',
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => pushed.push({ channel, payload }) },
  };
  registerFsHandlers({
    ipcMain,
    filesystem,
    REQ,
    PUSH,
    fileContextMenu: { popup: (absPath, win, opts) => popups.push({ absPath, win, opts }) },
    getMainWindow: () => mainWindow,
  });
  return {
    ipcMain,
    fsService,
    workspace,
    outside,
    popups,
    pushed,
    mainWindow,
    setWorkspace(root) {
      activeWorkspaceRoot = root;
    },
  };
}

async function seedMentionFixture(workspace) {
  const dirs = ['src/main', 'docs', '.hidden', '.git', 'node_modules'];
  for (const dir of dirs) await fs.mkdir(path.join(workspace, dir), { recursive: true });
  const files = {
    '.gitignore': 'node_modules/\n*.log\n',
    'debug.log': 'x',
    'src/main/index.js': 'x',
    'docs/guide.md': 'x',
    '.hidden/h.txt': 'x',
    '.git/config': 'x',
    'node_modules/mod.js': 'x',
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.writeFile(path.join(workspace, rel), content, 'utf8');
  }
}

test('listWorkspacePaths lists the workspace breadth-first with find_files exclusions', async (t) => {
  const { ipcMain, workspace } = await setup(t);
  await seedMentionFixture(workspace);

  const result = await ipcMain.invoke(REQ.FS_LIST_WORKSPACE_PATHS);

  assert.equal(result.error, undefined);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries, [
    { path: 'inside.txt', kind: 'file' },
    { path: 'docs', kind: 'directory' },
    { path: 'src', kind: 'directory' },
    { path: 'docs/guide.md', kind: 'file' },
    { path: 'src/main', kind: 'directory' },
    { path: 'src/main/index.js', kind: 'file' },
  ]);
  const paths = result.entries.map((e) => e.path);
  for (const excluded of ['.hidden', '.hidden/h.txt', '.git', 'node_modules', 'debug.log', '.gitignore']) {
    assert.ok(!paths.includes(excluded), `${excluded} darf nicht gelistet werden`);
  }
});

test('listWorkspacePaths returns an empty list without an open workspace', async (t) => {
  const { ipcMain, setWorkspace } = await setup(t);
  setWorkspace(null);

  const result = await ipcMain.invoke(REQ.FS_LIST_WORKSPACE_PATHS);
  assert.deepEqual(result.entries, []);
  assert.match(result.error, /Kein Arbeitsordner/);
});

test('listWorkspacePaths caps the list and reports truncation', async (t) => {
  const { fsService, workspace } = await setup(t);
  await seedMentionFixture(workspace);

  const result = await fsService.listWorkspacePaths(workspace, { maxEntries: 2 });
  assert.equal(result.truncated, true);
  assert.deepEqual(result.entries.map((e) => e.path), ['inside.txt', 'docs']);
});

test('readDirectory lists workspace entries and denies paths outside', async (t) => {
  const { ipcMain, workspace, outside } = await setup(t);

  const inside = await ipcMain.invoke(REQ.FS_READ_DIRECTORY, workspace);
  assert.deepEqual(inside.map((e) => e.name), ['inside.txt']);

  const denied = await ipcMain.invoke(REQ.FS_READ_DIRECTORY, outside);
  assert.deepEqual(denied, [], 'directories outside the workspace must not be listed');
});

test('readDirectory denies traversal via .. segments', async (t) => {
  const { ipcMain, workspace } = await setup(t);
  const sneaky = path.join(workspace, '..', 'outside');
  const denied = await ipcMain.invoke(REQ.FS_READ_DIRECTORY, sneaky);
  assert.deepEqual(denied, []);
});

test('readDirectory denies a symlink to a directory outside the workspace', async (t) => {
  const { ipcMain, workspace, outside } = await setup(t);
  const linkPath = path.join(workspace, 'outside-link');
  const linked = await createSymlinkOrSkip(
    t,
    outside,
    linkPath,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  if (!linked) return;

  const denied = await ipcMain.invoke(REQ.FS_READ_DIRECTORY, linkPath);
  assert.deepEqual(denied, []);
});

test('readFile denies files outside the workspace and reads files inside', async (t) => {
  const { ipcMain, workspace, outside } = await setup(t);

  const ok = await ipcMain.invoke(REQ.FS_READ_FILE, path.join(workspace, 'inside.txt'));
  assert.equal(ok.content, 'inside');

  const denied = await ipcMain.invoke(REQ.FS_READ_FILE, path.join(outside, 'secret.txt'));
  assert.ok(denied.error, 'reading outside the workspace must fail');
  assert.equal(denied.content, undefined);
});

test('readFile denies a symlink to a file outside the workspace', async (t) => {
  const { ipcMain, workspace, outside } = await setup(t);
  const linkPath = path.join(workspace, 'secret-link.txt');
  const linked = await createSymlinkOrSkip(
    t,
    path.join(outside, 'secret.txt'),
    linkPath,
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linked) return;

  const denied = await ipcMain.invoke(REQ.FS_READ_FILE, linkPath);
  assert.match(denied.error, /außerhalb/);
  assert.equal(denied.content, undefined);
});

test('readFile denies prefix-sibling directories (workspace-evil trick)', async (t) => {
  const { ipcMain, workspace } = await setup(t);
  const sibling = `${workspace}-evil`;
  await fs.mkdir(sibling, { recursive: true });
  await fs.writeFile(path.join(sibling, 'x.txt'), 'x', 'utf8');
  const denied = await ipcMain.invoke(REQ.FS_READ_FILE, path.join(sibling, 'x.txt'));
  assert.ok(denied.error);
});

test('all handlers deny access when no workspace is open', async (t) => {
  const { ipcMain, workspace, setWorkspace } = await setup(t);
  setWorkspace(null);

  assert.deepEqual(await ipcMain.invoke(REQ.FS_READ_DIRECTORY, workspace), []);
  const read = await ipcMain.invoke(REQ.FS_READ_FILE, path.join(workspace, 'inside.txt'));
  assert.match(read.error, /Kein Arbeitsordner/);
  const move = await ipcMain.invoke(
    REQ.FS_MOVE_ITEM,
    path.join(workspace, 'inside.txt'),
    workspace
  );
  assert.match(move.error, /Kein Arbeitsordner/);
});

test('moveItem moves files within the workspace', async (t) => {
  const { ipcMain, workspace } = await setup(t);
  const destDir = path.join(workspace, 'sub');
  await fs.mkdir(destDir);

  const res = await ipcMain.invoke(REQ.FS_MOVE_ITEM, path.join(workspace, 'inside.txt'), destDir);
  assert.equal(res.ok, true);
  assert.equal(res.newPath, path.join(destDir, 'inside.txt'));
  assert.equal(await fs.readFile(res.newPath, 'utf8'), 'inside');
});

test('moveItem denies source or destination outside the workspace', async (t) => {
  const { ipcMain, workspace, outside } = await setup(t);

  const fromOutside = await ipcMain.invoke(
    REQ.FS_MOVE_ITEM,
    path.join(outside, 'secret.txt'),
    workspace
  );
  assert.ok(fromOutside.error, 'moving a file from outside the workspace must fail');

  const toOutside = await ipcMain.invoke(
    REQ.FS_MOVE_ITEM,
    path.join(workspace, 'inside.txt'),
    outside
  );
  assert.ok(toOutside.error, 'moving a file out of the workspace must fail');
  assert.equal(await fs.readFile(path.join(workspace, 'inside.txt'), 'utf8'), 'inside');
});

test('moveItem denies symlinked sources and destinations outside the workspace', async (t) => {
  const { ipcMain, workspace, outside } = await setup(t);
  const sourceLink = path.join(workspace, 'secret-link.txt');
  const destinationLink = path.join(workspace, 'outside-link');
  const linkedSource = await createSymlinkOrSkip(
    t,
    path.join(outside, 'secret.txt'),
    sourceLink,
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linkedSource) return;
  const linkedDestination = await createSymlinkOrSkip(
    t,
    outside,
    destinationLink,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  if (!linkedDestination) return;

  const fromSymlink = await ipcMain.invoke(REQ.FS_MOVE_ITEM, sourceLink, workspace);
  assert.match(fromSymlink.error, /außerhalb/);

  const toSymlink = await ipcMain.invoke(
    REQ.FS_MOVE_ITEM,
    path.join(workspace, 'inside.txt'),
    destinationLink
  );
  assert.match(toSymlink.error, /außerhalb/);
  assert.equal(await fs.readFile(path.join(workspace, 'inside.txt'), 'utf8'), 'inside');
});

test('FS_SHOW_FILE_CONTEXT_MENU: Datei im Workspace öffnet das Menü am Hauptfenster (#58)', async (t) => {
  const { ipcMain, workspace, popups, mainWindow } = await setup(t);
  const target = path.join(workspace, 'inside.txt');
  const result = await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, target);
  assert.deepEqual(result, { ok: true });
  assert.equal(popups.length, 1);
  assert.equal(popups[0].absPath, target);
  assert.equal(popups[0].win, mainWindow);
});

test('FS_SHOW_FILE_CONTEXT_MENU: onDeleted pusht FS_ITEM_DELETED an den Renderer (#59)', async (t) => {
  const { ipcMain, workspace, popups, pushed } = await setup(t);
  const target = path.join(workspace, 'inside.txt');
  await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, target);
  popups[0].opts.onDeleted(target);
  assert.deepEqual(pushed, [{ channel: PUSH.FS_ITEM_DELETED, payload: { path: target } }]);
});

test('FS_SHOW_FILE_CONTEXT_MENU: Pfad außerhalb des Workspace wird abgelehnt (#58)', async (t) => {
  const { ipcMain, outside, popups } = await setup(t);
  const result = await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, path.join(outside, 'secret.txt'));
  assert.match(result.error, /außerhalb/);
  assert.deepEqual(popups, []);
});

test('FS_SHOW_FILE_CONTEXT_MENU: Symlink aus dem Workspace heraus wird abgelehnt (#58)', async (t) => {
  const { ipcMain, workspace, outside, popups } = await setup(t);
  const link = path.join(workspace, 'escape.txt');
  if (!(await createSymlinkOrSkip(t, path.join(outside, 'secret.txt'), link, 'file'))) return;
  const result = await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, link);
  assert.match(result.error, /außerhalb/);
  assert.deepEqual(popups, []);
});

test('FS_SHOW_FILE_CONTEXT_MENU: ohne Menü-Service kommt ein Fehler statt einer Exception (#58)', async (t) => {
  const { fsService, workspace } = await setup(t);
  const ipcMain = createMockIpcMain();
  const filesystem = createFilesystemIpcAdapter({ fsService, getActiveWorkspaceRoot: () => workspace });
  registerFsHandlers({ ipcMain, filesystem, REQ });
  const result = await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, path.join(workspace, 'inside.txt'));
  assert.match(result.error, /nicht verfügbar/);
});
