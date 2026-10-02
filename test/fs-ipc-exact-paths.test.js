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

// CR-B17-08 (#649): the tree's paths are used exactly as sent, and whether a
// path is a folder is main's own lstat, not a flag from the renderer.

// Windows drops trailing spaces from names, so the twin pair cannot exist there.
const skipOnWindows = { skip: process.platform === 'win32' };

async function setup(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-exact-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'ws');
  await fs.mkdir(workspace);

  const fsService = createFsService({ fs, path, maxReadFileBytes: 1 << 20 });
  const filesystem = createFilesystemIpcAdapter({ fsService, getActiveWorkspaceRoot: () => workspace });
  const ipcMain = createMockIpcMain();
  const built = [];
  const dialogs = [];
  // The real menu service; only Electron's Menu, shell and dialog are stand-ins.
  const fileContextMenu = createFileContextMenu({
    Menu: {
      buildFromTemplate: (template) => {
        built.push(template);
        return { template, popup() {} };
      },
    },
    shell: { openPath: async () => '', showItemInFolder() {}, trashItem: async () => {} },
    dialog: { showMessageBox: async (...args) => { dialogs.push(args[args.length - 1]); return { response: 1 }; } },
    platform: process.platform,
  });
  const popups = [];
  const recordingMenu = {
    popup: (absPath, win, opts) => {
      popups.push({ absPath, opts });
      return fileContextMenu.popup(absPath, win, opts);
    },
  };
  registerFsHandlers({
    ipcMain,
    filesystem,
    REQ,
    PUSH,
    fileContextMenu: recordingMenu,
    getMainWindow: () => null,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  });
  return { workspace, ipcMain, built, dialogs, popups, fsService };
}

async function makeTwins(workspace) {
  const plain = path.join(workspace, 'report.txt');
  const spaced = path.join(workspace, 'report.txt ');
  await fs.writeFile(plain, 'plain');
  await fs.writeFile(spaced, 'spaced');
  return { plain, spaced };
}

test('fs:readFile previews the name with the trailing space, not its twin (#649)', skipOnWindows, async (t) => {
  const { workspace, ipcMain } = await setup(t);
  const { plain, spaced } = await makeTwins(workspace);

  assert.equal((await ipcMain.invoke(REQ.FS_READ_FILE, spaced)).content, 'spaced');
  assert.equal((await ipcMain.invoke(REQ.FS_READ_FILE, plain)).content, 'plain');
});

test('fs:moveItem moves exactly the entry the tree named (#649)', skipOnWindows, async (t) => {
  const { workspace, ipcMain } = await setup(t);
  const { plain, spaced } = await makeTwins(workspace);
  const dest = path.join(workspace, 'archive');
  await fs.mkdir(dest);

  const result = await ipcMain.invoke(REQ.FS_MOVE_ITEM, spaced, dest);

  assert.deepEqual(result, { ok: true, newPath: path.join(dest, 'report.txt ') });
  assert.equal(await fs.readFile(path.join(dest, 'report.txt '), 'utf8'), 'spaced');
  assert.equal(await fs.readFile(plain, 'utf8'), 'plain', 'the twin stays where it was');
});

test('fs:showFileContextMenu opens the menu for the exact, untrimmed path (#649)', skipOnWindows, async (t) => {
  const { workspace, ipcMain, popups, dialogs, built } = await setup(t);
  const { spaced } = await makeTwins(workspace);

  const result = await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, spaced);

  assert.deepEqual(result, { ok: true });
  assert.equal(popups[0].absPath, spaced);
  await built[0].find((item) => item.label === 'Delete…').click();
  assert.equal(dialogs[0].message, 'Delete “report.txt ”?');
  assert.match(dialogs[0].detail, new RegExp(`^${spaced.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`));
});

test('a path without a twin that ends in a space can still be previewed (#649)', skipOnWindows, async (t) => {
  const { workspace, ipcMain } = await setup(t);
  const lonely = path.join(workspace, 'draft ');
  await fs.writeFile(lonely, 'draft');

  assert.equal((await ipcMain.invoke(REQ.FS_READ_FILE, lonely)).content, 'draft');
});

test('a wrong isDirectory from the renderer still gets the folder menu and wording (#649)', async (t) => {
  const { workspace, ipcMain, built, dialogs, popups } = await setup(t);
  const folder = path.join(workspace, 'src');
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'index.js'), 'x');

  // An old or compromised renderer still sends the flag; it is ignored.
  const result = await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, folder, { isDirectory: false });

  assert.deepEqual(result, { ok: true });
  assert.equal(popups[0].opts.isDirectory, true);
  const labels = built[0].map((item) => item.label ?? item.type);
  assert.equal(labels.includes('Open'), false, 'a folder offers no "Open"');
  await built[0].find((item) => item.label === 'Delete…').click();
  assert.match(dialogs[0].detail, /The folder and everything in it will be moved to the trash\./);
});

test('a wrong isDirectory cannot take "Open" away from a file either (#649)', async (t) => {
  const { workspace, ipcMain, built, popups } = await setup(t);
  const file = path.join(workspace, 'notes.md');
  await fs.writeFile(file, '# notes');

  await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, file, { isDirectory: true });

  assert.equal(popups[0].opts.isDirectory, false);
  assert.equal(built[0][0].label, 'Open');
});

test('a link to a folder counts as a link: "Open" is offered, the wording is the file one (#649)', skipOnWindows, async (t) => {
  const { workspace, ipcMain, built, popups } = await setup(t);
  await fs.mkdir(path.join(workspace, 'real'));
  const link = path.join(workspace, 'shortcut');
  await fs.symlink(path.join(workspace, 'real'), link);

  await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, link);

  assert.equal(popups[0].opts.isDirectory, false);
  assert.equal(built[0][0].label, 'Open');
});

test('a path that is gone gives an error instead of a menu (#649)', async (t) => {
  const { workspace, ipcMain, popups } = await setup(t);

  const result = await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, path.join(workspace, 'gone.txt'));

  assert.match(result.error, /ENOENT/);
  assert.deepEqual(popups, []);
});

test('only the model\'s paths are trimmed, where they are typed (#649)', async (t) => {
  const { workspace, fsService } = await setup(t);

  assert.deepEqual(
    fsService.assertAbsolutePathInWorkspace(workspace, path.join(workspace, 'report.txt ')),
    { absPath: path.join(workspace, 'report.txt ') }
  );
  assert.deepEqual(fsService.resolveWorkspacePath(workspace, '  docs/report.txt  '), {
    absPath: path.join(workspace, 'docs', 'report.txt'),
  });
  const forTool = await fsService.resolveWorkspacePathForAccess(workspace, ' notes.md ');
  assert.equal(forTool.absPath, path.join(workspace, 'notes.md'));
});
