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

// #849: "Information" travels to the renderer as fs:show-info, and "Reveal"
// comes back over fs:revealItem — checked against the workspace like every
// other fs channel.

async function setup(t, { window = true } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-info-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'ws');
  await fs.mkdir(workspace);

  const fsService = createFsService({ fs, path, maxReadFileBytes: 1 << 20 });
  const filesystem = createFilesystemIpcAdapter({ fsService, getActiveWorkspaceRoot: () => workspace });
  const ipcMain = createMockIpcMain();
  const built = [];
  const dialogs = [];
  const revealed = [];
  const fileContextMenu = createFileContextMenu({
    Menu: {
      buildFromTemplate: (template) => {
        built.push(template);
        return { template, popup() {} };
      },
    },
    shell: { openPath: async () => '', showItemInFolder: (p) => revealed.push(p), trashItem: async () => {} },
    dialog: { showMessageBox: async (...args) => { dialogs.push(args[args.length - 1]); return { response: 0 }; } },
    platform: 'darwin',
    fileInfo: {
      describe: async (p, { isDirectory }) => ({
        name: path.basename(p),
        path: p,
        fields: [['Name', path.basename(p)]],
        kind: isDirectory ? 'folder' : 'file',
        type: 'File (.txt)',
        summary: '5 bytes',
        details: [['Size', '5 bytes']],
      }),
    },
  });
  const sent = [];
  const win = {
    isDestroyed: () => false,
    getContentBounds: () => ({ width: 800, height: 600 }),
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
  registerFsHandlers({
    ipcMain,
    filesystem,
    REQ,
    PUSH,
    fileContextMenu,
    getMainWindow: () => (window ? win : null),
    getWorkspaceRoot: () => workspace,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
  });
  return { dir, workspace, ipcMain, built, dialogs, revealed, sent };
}

function clickInformation(template) {
  const item = template.find((entry) => entry.label === 'Information');
  assert.ok(item, 'the menu offers "Information"');
  item.click();
  return new Promise((resolve) => setImmediate(resolve));
}

test('Information is pushed to the window with the path the tree asked for (#849)', async (t) => {
  const { workspace, ipcMain, built, dialogs, sent } = await setup(t);
  const file = path.join(workspace, 'notes.txt');
  await fs.writeFile(file, 'notes');

  await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, file, {});
  await clickInformation(built[0]);

  const pushed = sent.filter((entry) => entry.channel === PUSH.FS_SHOW_INFO);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].payload.itemPath, file);
  assert.equal(pushed[0].payload.name, 'notes.txt');
  assert.equal(pushed[0].payload.revealLabel, 'Reveal in Finder');
  assert.deepEqual(pushed[0].payload.details, [['Size', '5 bytes']]);
  assert.deepEqual(dialogs, []);
});

test('without a window the native dialog stands in (#849)', async (t) => {
  const { workspace, ipcMain, built, dialogs, sent } = await setup(t, { window: false });
  const file = path.join(workspace, 'notes.txt');
  await fs.writeFile(file, 'notes');

  await ipcMain.invoke(REQ.FS_SHOW_FILE_CONTEXT_MENU, file, {});
  await clickInformation(built[0]);

  assert.deepEqual(sent, []);
  assert.equal(dialogs.length, 1);
  assert.equal(dialogs[0].type, 'info');
});

test('fs:revealItem reveals an entry inside the workspace (#849)', async (t) => {
  const { workspace, ipcMain, revealed } = await setup(t);
  const file = path.join(workspace, 'notes.txt');
  await fs.writeFile(file, 'notes');

  assert.deepEqual(await ipcMain.invoke(REQ.FS_REVEAL_ITEM, file), { ok: true });
  assert.deepEqual(revealed, [file]);
});

test('fs:revealItem refuses a path outside the workspace (#849)', async (t) => {
  const { dir, ipcMain, revealed } = await setup(t);
  const outside = path.join(dir, 'secret.txt');
  await fs.writeFile(outside, 'secret');

  const result = await ipcMain.invoke(REQ.FS_REVEAL_ITEM, outside);
  assert.ok(result.error, 'an error instead of a reveal');
  assert.deepEqual(revealed, []);
});
