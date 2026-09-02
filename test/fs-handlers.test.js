const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createFilesystemIpcAdapter } = require('../src/main/adapters/filesystem-ipc-adapter');
const { registerFsHandlers } = require('../src/main/ipc/fs-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
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
  registerFsHandlers({
    ipcMain,
    filesystem,
    REQ,
  });
  return {
    ipcMain,
    workspace,
    outside,
    setWorkspace(root) {
      activeWorkspaceRoot = root;
    },
  };
}

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
