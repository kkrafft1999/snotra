// New file, new folder and rename from the tree (#349), in main: the service
// on a real disk, the workspace boundary at the IPC channels, and what the
// context menu sends back to the renderer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createFilesystemIpcAdapter } = require('../src/main/adapters/filesystem-ipc-adapter');
const { registerFsHandlers } = require('../src/main/ipc/fs-handlers');
const { createFileContextMenu } = require('../src/main/services/file-context-menu');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

async function setup(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-create-')));
  t.after(async () => {
    // A test may leave a folder read-only; rm needs to get in again.
    await fs.chmod(path.join(dir, 'ws', 'locked'), 0o755).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const workspace = path.join(dir, 'ws');
  const outside = path.join(dir, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);

  const fsService = createFsService({ fs, path, maxReadFileBytes: 1 << 20 });
  const filesystem = createFilesystemIpcAdapter({ fsService, getActiveWorkspaceRoot: () => workspace });
  const ipcMain = createMockIpcMain();
  const built = [];
  const sent = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (channel, payload) => sent.push([channel, payload]), getZoomFactor: () => 1 },
  };
  const fileContextMenu = createFileContextMenu({
    Menu: { buildFromTemplate: (template) => { built.push(template); return { template, popup() {} }; } },
    shell: { openPath: async () => '', showItemInFolder() {}, trashItem: async () => {} },
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    platform: process.platform,
  });
  registerFsHandlers({
    ipcMain,
    filesystem,
    REQ,
    PUSH,
    fileContextMenu,
    getMainWindow: () => win,
    getWorkspaceRoot: () => workspace,
  });
  return { dir, workspace, outside, ipcMain, built, sent, fsService };
}

const create = (ipcMain, parent, name, kind = 'file') => ipcMain.invoke(REQ.FS_CREATE_ITEM, parent, name, kind);
const rename = (ipcMain, itemPath, name) => ipcMain.invoke(REQ.FS_RENAME_ITEM, itemPath, name);
const exists = (p) => fs.lstat(p).then(() => true, () => false);

/** Whether this temp directory folds case, as APFS and NTFS do by default. */
async function foldsCase(dir) {
  const probe = path.join(dir, 'case-probe');
  await fs.writeFile(probe, '');
  const folds = await exists(path.join(dir, 'CASE-PROBE'));
  await fs.rm(probe);
  return folds;
}

test('creates an empty file and an empty folder, with spaces and umlauts in the name', async (t) => {
  const { workspace, ipcMain } = await setup(t);

  const file = await create(ipcMain, workspace, '  Übersicht März.md ');
  assert.deepEqual(file, { ok: true, path: path.join(workspace, 'Übersicht März.md') });
  assert.equal(await fs.readFile(file.path, 'utf8'), '');

  const folder = await create(ipcMain, workspace, 'neue Ablage', 'directory');
  assert.deepEqual(folder, { ok: true, path: path.join(workspace, 'neue Ablage') });
  assert.equal((await fs.stat(folder.path)).isDirectory(), true);

  const nested = await create(ipcMain, folder.path, 'a'.repeat(200) + '.txt');
  assert.equal(nested.ok, true);
});

test('never creates over an existing name, file or folder', async (t) => {
  const { workspace, ipcMain } = await setup(t);
  await fs.writeFile(path.join(workspace, 'notes.md'), 'keep me');
  await fs.mkdir(path.join(workspace, 'docs'));

  assert.equal((await create(ipcMain, workspace, 'notes.md')).reason, 'exists');
  assert.equal((await create(ipcMain, workspace, 'notes.md', 'directory')).reason, 'exists');
  assert.equal((await create(ipcMain, workspace, 'docs')).reason, 'exists');
  assert.equal(await fs.readFile(path.join(workspace, 'notes.md'), 'utf8'), 'keep me');
});

test('an invalid name is refused with its reason, and nothing is written', async (t) => {
  const { workspace, ipcMain } = await setup(t);

  assert.equal((await create(ipcMain, workspace, '')).reason, 'empty');
  assert.equal((await create(ipcMain, workspace, '..', 'directory')).reason, 'dots');
  assert.equal((await create(ipcMain, workspace, 'aux.txt')).reason, 'reserved');
  assert.deepEqual(
    await create(ipcMain, workspace, 'a:b.md'),
    { error: 'character', reason: 'character', character: ':' },
  );
  assert.equal((await create(ipcMain, workspace, 'x', 'symlink')).reason, 'failed');
  assert.deepEqual(await fs.readdir(workspace), []);
});

test('paths outside the workspace are refused in main, whatever the renderer sends', async (t) => {
  const { workspace, outside, ipcMain } = await setup(t);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
  await fs.writeFile(path.join(workspace, 'inside.txt'), 'x');

  // Creating in a folder outside, or climbing out by the name.
  assert.equal((await create(ipcMain, outside, 'planted.txt')).reason, 'refused');
  assert.equal((await create(ipcMain, path.join(workspace, '..', 'outside'), 'planted.txt')).reason, 'refused');
  assert.equal((await create(ipcMain, workspace, '../outside/planted.txt')).reason, 'separator');
  assert.equal((await create(ipcMain, workspace, '..\\outside\\planted.txt')).reason, 'separator');
  assert.equal(await exists(path.join(outside, 'planted.txt')), false);

  // Renaming something outside, or renaming out of the workspace.
  assert.equal((await rename(ipcMain, path.join(outside, 'secret.txt'), 'taken.txt')).reason, 'refused');
  assert.equal((await rename(ipcMain, path.join(workspace, 'inside.txt'), '../outside/x.txt')).reason, 'separator');
  assert.equal(await exists(path.join(workspace, 'inside.txt')), true);
  assert.deepEqual((await fs.readdir(outside)).sort(), ['secret.txt']);

  // The open folder itself has no rename.
  assert.equal((await rename(ipcMain, workspace, 'other')).reason, 'root');
  assert.equal(await exists(workspace), true);
});

test('a folder link that leads out of the workspace is no place to create in', { skip: process.platform === 'win32' }, async (t) => {
  const { workspace, outside, ipcMain } = await setup(t);
  await fs.symlink(outside, path.join(workspace, 'escape'));

  assert.equal((await create(ipcMain, path.join(workspace, 'escape'), 'planted.txt')).reason, 'refused');
  assert.deepEqual(await fs.readdir(outside), []);
});

test('renames a file and a folder in place; the folder keeps what is in it', async (t) => {
  const { workspace, ipcMain } = await setup(t);
  await fs.writeFile(path.join(workspace, 'draft.md'), 'text');
  await fs.mkdir(path.join(workspace, 'docs'));
  await fs.writeFile(path.join(workspace, 'docs', 'a.md'), 'a');

  assert.deepEqual(
    await rename(ipcMain, path.join(workspace, 'draft.md'), 'Entwurf für Jörg.md'),
    { ok: true, path: path.join(workspace, 'Entwurf für Jörg.md') },
  );
  assert.equal(await fs.readFile(path.join(workspace, 'Entwurf für Jörg.md'), 'utf8'), 'text');

  const folder = await rename(ipcMain, path.join(workspace, 'docs'), 'documentation');
  assert.equal(folder.ok, true);
  assert.equal(await fs.readFile(path.join(workspace, 'documentation', 'a.md'), 'utf8'), 'a');
  assert.equal(await exists(path.join(workspace, 'docs')), false);
});

test('the same name is no change, and an existing other name is refused', async (t) => {
  const { workspace, ipcMain } = await setup(t);
  await fs.writeFile(path.join(workspace, 'a.md'), 'a');
  await fs.writeFile(path.join(workspace, 'b.md'), 'b');

  assert.deepEqual(
    await rename(ipcMain, path.join(workspace, 'a.md'), 'a.md'),
    { ok: true, path: path.join(workspace, 'a.md'), unchanged: true },
  );
  assert.equal((await rename(ipcMain, path.join(workspace, 'a.md'), 'b.md')).reason, 'exists');
  assert.equal(await fs.readFile(path.join(workspace, 'b.md'), 'utf8'), 'b');
  assert.equal((await rename(ipcMain, path.join(workspace, 'gone.md'), 'c.md')).reason, 'missing');
});

test('a case-only rename shows the new spelling on every platform', async (t) => {
  const { dir, workspace, ipcMain } = await setup(t);
  await fs.writeFile(path.join(workspace, 'readme.md'), 'hello');

  const result = await rename(ipcMain, path.join(workspace, 'readme.md'), 'README.md');

  assert.deepEqual(result, { ok: true, path: path.join(workspace, 'README.md') });
  assert.deepEqual(await fs.readdir(workspace), ['README.md']);
  assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), 'hello');
  if (!(await foldsCase(dir))) {
    // Where case counts, two names that differ in case are two entries.
    await fs.writeFile(path.join(workspace, 'notes.md'), 'n');
    assert.equal((await rename(ipcMain, path.join(workspace, 'README.md'), 'NOTES.md')).ok, true);
    await fs.writeFile(path.join(workspace, 'Notes.md'), 'N');
    assert.equal((await rename(ipcMain, path.join(workspace, 'NOTES.md'), 'Notes.md')).reason, 'exists');
  }
});

test('the detour for a case-only rename: same inode, through a temporary name (#349)', async () => {
  // A stand-in for APFS/NTFS, so Linux CI runs this path too.
  const renames = [];
  const fakeFs = {
    lstat: async () => ({ ino: 42n, dev: 1n }),
    rename: async (from, to) => { renames.push([path.basename(from), path.basename(to)]); },
  };
  const service = createFsService({ fs: fakeFs, path, maxReadFileBytes: 1, randomSuffix: () => 'r4nd' });

  const result = await service.renameItem(path.join('/ws', 'readme.md'), 'README.md');

  assert.deepEqual(result, { ok: true, path: path.join('/ws', 'README.md') });
  assert.deepEqual(renames, [['readme.md', '.snotra-rename-r4nd'], ['.snotra-rename-r4nd', 'README.md']]);
});

test('a failed second step of the detour puts the entry back under its old name', async () => {
  const renames = [];
  const fakeFs = {
    lstat: async () => ({ ino: 42n, dev: 1n }),
    rename: async (from, to) => {
      renames.push([path.basename(from), path.basename(to)]);
      if (path.basename(to) === 'README.md') throw Object.assign(new Error('busy'), { code: 'EACCES' });
    },
  };
  const service = createFsService({ fs: fakeFs, path, maxReadFileBytes: 1, randomSuffix: () => 'r4nd', platform: 'linux' });

  const result = await service.renameItem(path.join('/ws', 'readme.md'), 'README.md');

  assert.equal(result.reason, 'permission');
  assert.deepEqual(renames.at(-1), ['.snotra-rename-r4nd', 'readme.md']);
});

test('another entry whose name only folds equal is still refused', async () => {
  // Two inodes: on a case-sensitive disk `Readme.md` and `README.md` are two files.
  const fakeFs = {
    lstat: async (p) => ({ ino: p.endsWith('README.md') ? 7n : 8n, dev: 1n }),
    rename: async () => { throw new Error('must not rename'); },
  };
  const service = createFsService({ fs: fakeFs, path, maxReadFileBytes: 1 });

  assert.equal((await service.renameItem(path.join('/ws', 'Readme.md'), 'README.md')).reason, 'exists');
});

test('a read-only folder says so instead of failing silently', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async (t) => {
  const { workspace, ipcMain } = await setup(t);
  const locked = path.join(workspace, 'locked');
  await fs.mkdir(locked);
  await fs.writeFile(path.join(locked, 'kept.md'), 'k');
  await fs.chmod(locked, 0o555);

  assert.equal((await create(ipcMain, locked, 'new.md')).reason, 'permission');
  assert.equal((await create(ipcMain, locked, 'sub', 'directory')).reason, 'permission');
  assert.equal((await rename(ipcMain, path.join(locked, 'kept.md'), 'moved.md')).reason, 'permission');
});

test('the context menu sends where to create and what to rename back to the tree', async (t) => {
  const { workspace, ipcMain, built, sent } = await setup(t);
  const folder = path.join(workspace, 'docs');
  const file = path.join(folder, 'a.md');
  await fs.mkdir(folder);
  await fs.writeFile(file, 'a');
  const labels = (template) => template.map((item) => item.label ?? item.type);
  const click = (template, label) => template.find((item) => item.label === label).click();

  await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, file);
  const fileMenu = built.at(-1);
  assert.deepEqual(labels(fileMenu).slice(0, 4), ['Open', 'separator', 'New File…', 'New Folder…']);
  assert.deepEqual(labels(fileMenu).slice(-2), ['Rename…', 'Delete…']);
  assert.equal(fileMenu.find((item) => item.label === 'Rename…').accelerator, 'F2');
  assert.equal(fileMenu.find((item) => item.label === 'Rename…').registerAccelerator, false);
  click(fileMenu, 'New File…');
  click(fileMenu, 'Rename…');
  // Next to a file: in its folder.
  assert.deepEqual(sent.splice(0), [
    [PUSH.FS_BEGIN_CREATE, { path: folder, kind: 'file' }],
    [PUSH.FS_BEGIN_RENAME, { path: file }],
  ]);

  await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, folder);
  const folderMenu = built.at(-1);
  assert.equal(labels(folderMenu)[0], 'New File…');
  click(folderMenu, 'New Folder…');
  // On a folder: inside it.
  assert.deepEqual(sent.splice(0), [[PUSH.FS_BEGIN_CREATE, { path: folder, kind: 'directory' }]]);
});

test('the open folder\'s own menu offers "New" but neither rename nor delete', async (t) => {
  const { workspace, ipcMain, built, sent } = await setup(t);

  await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, workspace);
  const labels = built.at(-1).map((item) => item.label ?? item.type);

  assert.equal(labels.includes('Rename…'), false);
  assert.equal(labels.includes('Delete…'), false);
  assert.deepEqual(labels.slice(0, 3), ['New File…', 'New Folder…', 'separator']);
  built.at(-1).find((item) => item.label === 'New File…').click();
  assert.deepEqual(sent, [[PUSH.FS_BEGIN_CREATE, { path: workspace, kind: 'file' }]]);
});
