// A folder opens even when `last-folder.json` cannot be written (#650).
//
// `activate()` awaited `persistLastFolder` uncaught before setting the root:
// with a full disk or a read-only userData the dialog handler rejected, the
// root stayed unset and the renderer ended in an unhandled rejection. #473
// had already settled that opening the folder goes on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createWorkspaceActivation } = require('../src/main/services/workspace-activation');
const { registerDialogHandlers } = require('../src/main/ipc/dialog-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');

async function makeFolder(t) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-activation-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  return path.resolve(folder);
}

/** A store whose disk is full: every write fails with ENOSPC. */
function fullDiskStore(known = []) {
  return {
    getValidatedFolderHistory: async () => known,
    getValidatedLastFolder: async () => null,
    persistLastFolder: async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
  };
}

function makeActivation(store) {
  const warnings = [];
  let root = null;
  const activation = createWorkspaceActivation({
    fs,
    path,
    workspaceFolderStore: store,
    setActiveWorkspaceRoot: (folder) => {
      root = folder;
    },
    log: { warn: (message) => warnings.push(message) },
  });
  return { activation, warnings, root: () => root };
}

test('a chosen folder opens although remembering it fails, and the failure is logged', async (t) => {
  const folder = await makeFolder(t);
  const { activation, warnings, root } = makeActivation(fullDiskStore());
  assert.equal(await activation.activateChosenFolder(folder), folder);
  assert.equal(root(), folder);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^Could not remember the last opened folder: ENOSPC/);
});

test('a known folder opens although remembering it fails', async (t) => {
  const folder = await makeFolder(t);
  const { activation, warnings, root } = makeActivation(fullDiskStore([folder]));
  assert.equal(await activation.activateKnownFolder(folder), folder);
  assert.equal(root(), folder);
  assert.equal(warnings.length, 1);
});

test('the folder dialog resolves with the folder instead of rejecting', async (t) => {
  const folder = await makeFolder(t);
  const store = fullDiskStore();
  const { activation, root } = makeActivation(store);
  const handlers = {};
  registerDialogHandlers({
    ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [folder] }) },
    getMainWindow: () => null,
    workspaceActivation: activation,
    workspaceFolderStore: store,
    REQ,
  });
  assert.equal(await handlers[REQ.DIALOG_OPEN_FOLDER](), folder);
  assert.equal(root(), folder);
});

test('a folder that is gone still does not open', async (t) => {
  const folder = await makeFolder(t);
  const { activation, warnings, root } = makeActivation(fullDiskStore());
  assert.equal(await activation.activateChosenFolder(path.join(folder, 'missing')), null);
  assert.equal(root(), null);
  assert.deepEqual(warnings, []);
});
