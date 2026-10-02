const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const net = require('net');
const Module = require('module');
const { execFileSync } = require('child_process');
const { createFsService } = require('../src/main/services/fs-service');
const { createFilesystemIpcAdapter } = require('../src/main/adapters/filesystem-ipc-adapter');
const { registerFsHandlers } = require('../src/main/ipc/fs-handlers');
const { REQUEST_CHANNELS: REQ, PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

// CR-B17-05 (#646): the sources of an import are bound to what the user
// dropped, refused by their real path as well, and a drop that cannot be
// copied completely leaves nothing behind.

const PRELOAD = require.resolve('../src/preload/index.js');
const skipOnWindows = { skip: process.platform === 'win32' };

/** A File the user dropped: Electron's webUtils knows its path. */
class DroppedFile {
  constructor(nativePath) {
    this.name = path.basename(nativePath);
    this.nativePath = nativePath;
  }
}

/** A File page script made itself: a File, but not one from the disk. */
class PageMadeFile {
  constructor(name) {
    this.name = name;
  }
}

// What webUtils.getPathForFile does: a path for a File from the file system,
// '' for any other File, a TypeError for everything that is not a File.
const fakeWebUtils = {
  getPathForFile(file) {
    if (file instanceof DroppedFile) return file.nativePath;
    if (file instanceof PageMadeFile) return '';
    throw new TypeError('getPathForFile expected to receive a File object but one was not provided');
  },
};

/** Loads the real preload with a stand-in for 'electron' and returns what it exposes. */
function loadPreload(ipcRenderer) {
  let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_key, api) => { exposed = api; } },
    ipcRenderer,
    webUtils: fakeWebUtils,
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    if (request === 'electron') return electron;
    return originalLoad.call(this, request, ...rest);
  };
  try {
    delete require.cache[PRELOAD];
    require(PRELOAD);
  } finally {
    Module._load = originalLoad;
    delete require.cache[PRELOAD];
  }
  return exposed;
}

async function makeFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-b17-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'ws');
  const home = path.join(base, 'home');
  await fs.mkdir(workspace);
  await fs.mkdir(home);
  return { base, workspace, home };
}

/** The real handlers, adapter and service behind a preload whose invoke goes straight to them. */
function wireApp(workspace, { dialogResponse = 0 } = {}) {
  const fsService = createFsService({ fs, path, maxReadFileBytes: 2 * 1024 * 1024 });
  const filesystem = createFilesystemIpcAdapter({ fsService, getActiveWorkspaceRoot: () => workspace });
  const ipcMain = createMockIpcMain();
  const messageBoxes = [];
  registerFsHandlers({
    ipcMain,
    filesystem,
    REQ,
    PUSH,
    getMainWindow: () => null,
    dialog: { showMessageBox: async (options) => { messageBoxes.push(options); return { response: dialogResponse }; } },
  });
  const invoked = [];
  const api = loadPreload({
    invoke: (channel, ...args) => {
      invoked.push({ channel, args });
      return ipcMain.invoke(channel, ...args);
    },
    on() {},
    removeListener() {},
  });
  return { api, ipcMain, invoked, messageBoxes, fsService, filesystem };
}

test('the preload no longer hands page script a way to turn a File into a path (#646)', () => {
  const api = loadPreload({ invoke: async () => ({}), on() {}, removeListener() {} });
  assert.equal(api.getPathForFile, undefined);
  assert.equal(typeof api.importItems, 'function');
  assert.equal(typeof api.inspectImport, 'function');
});

test('a source given as a string is not copied — not even a credentials file (#646)', async (t) => {
  const { workspace, home } = await makeFixture(t);
  await fs.writeFile(path.join(home, '.git-credentials'), 'https://user:ghp_FAKE@github.com\n');
  await fs.writeFile(path.join(home, 'notes.txt'), 'plain');
  const { api, invoked, messageBoxes } = wireApp(workspace);

  const sources = [path.join(home, '.git-credentials'), path.join(home, 'notes.txt')];
  const inspection = await api.inspectImport(sources, workspace);
  const result = await api.importItems(sources, workspace);

  assert.deepEqual(inspection, { ok: true, copied: [], dirs: 0, files: 0, bytes: 0 });
  assert.deepEqual(result, { ok: true, copied: [], dirs: 0, files: 0, bytes: 0 });
  assert.deepEqual(invoked, [], 'nothing the page named reaches main');
  assert.deepEqual(messageBoxes, []);
  assert.deepEqual(await fs.readdir(workspace), []);
});

test('objects that only look like a File, and Files the page made, are dropped too (#646)', async (t) => {
  const { workspace, home } = await makeFixture(t);
  await fs.writeFile(path.join(home, 'notes.txt'), 'plain');
  const { api, invoked } = wireApp(workspace);

  const result = await api.importItems(
    [{ name: 'notes.txt', path: path.join(home, 'notes.txt') }, new PageMadeFile('notes.txt')],
    workspace
  );
  // Not an array at all: a FileList-like object or a bare string.
  await api.importItems(path.join(home, 'notes.txt'), workspace);
  await api.importItems({ 0: new DroppedFile(path.join(home, 'notes.txt')), length: 1 }, workspace);

  assert.deepEqual(result.copied, []);
  assert.deepEqual(invoked, []);
  assert.deepEqual(await fs.readdir(workspace), []);
});

test('a dropped File is resolved in the preload and copied; a string next to it is not (#646)', async (t) => {
  const { workspace, home } = await makeFixture(t);
  await fs.writeFile(path.join(home, 'dropped.txt'), 'dropped');
  await fs.writeFile(path.join(home, 'named.txt'), 'named');
  const { api, invoked } = wireApp(workspace);

  const files = [new DroppedFile(path.join(home, 'dropped.txt')), path.join(home, 'named.txt')];
  const inspection = await api.inspectImport(files, workspace);
  const result = await api.importItems(files, workspace);

  assert.equal(inspection.files, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.copied, [path.join(workspace, 'dropped.txt')]);
  assert.deepEqual(invoked.map((call) => call.args[0]), [
    [path.join(home, 'dropped.txt')],
    [path.join(home, 'dropped.txt')],
  ]);
  assert.deepEqual(await fs.readdir(workspace), ['dropped.txt']);
});

test('a source whose real path is sensitive is refused, though its written path is not (#646)', skipOnWindows, async (t) => {
  const { base, workspace, home } = await makeFixture(t);
  await fs.mkdir(path.join(home, '.kube'));
  await fs.writeFile(path.join(home, '.kube', 'config'), 'users:\n- user:\n    token: FAKE\n');
  // A file manager keeps the path as written: ~/k8s → ~/.kube arrives as k8s/config.
  await fs.symlink(path.join(home, '.kube'), path.join(base, 'k8s'));
  const { filesystem } = wireApp(workspace);

  const inspected = await filesystem.inspectImport([path.join(base, 'k8s', 'config')], workspace);
  const imported = await filesystem.importItems([path.join(base, 'k8s', 'config')], workspace);
  const folder = await filesystem.importItems([path.join(base, 'k8s')], workspace);

  assert.match(inspected.error, /looks like credentials \(pattern \.kube\/\*\*\)/);
  assert.match(imported.error, /looks like credentials/);
  assert.match(folder.error, /looks like credentials/, 'the link to the folder itself counts as well');
  assert.deepEqual(await fs.readdir(workspace), []);
});

test('the written path still counts on its own (#646)', async (t) => {
  const { workspace, home } = await makeFixture(t);
  await fs.mkdir(path.join(home, '.ssh'));
  await fs.writeFile(path.join(home, '.ssh', 'known_hosts'), 'github.com ssh-ed25519 AAAA');
  const { filesystem } = wireApp(workspace);

  const result = await filesystem.importItems([path.join(home, '.ssh', 'known_hosts')], workspace);

  assert.match(result.error, /looks like credentials \(pattern \.ssh\/\*\*\)/);
  assert.deepEqual(await fs.readdir(workspace), []);
});

async function makeFifo(t, fifoPath) {
  try {
    execFileSync('mkfifo', [fifoPath]);
    return true;
  } catch (err) {
    t.skip(`mkfifo is not available: ${err.message}`);
    return false;
  }
}

async function makeSocket(t, socketPath) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
}

test('a FIFO and a socket inside a dropped folder are skipped and reported, the rest arrives (#646)', skipOnWindows, async (t) => {
  const { workspace, home } = await makeFixture(t);
  const project = path.join(home, 'p');
  await fs.mkdir(path.join(project, 'a'), { recursive: true });
  await fs.mkdir(path.join(project, '.git'));
  await fs.writeFile(path.join(project, 'a', 'one.txt'), '1');
  await fs.writeFile(path.join(project, 'z.txt'), 'z');
  if (!(await makeFifo(t, path.join(project, 'a', 'pipe')))) return;
  // core.fsmonitor leaves a socket like this one in .git.
  await makeSocket(t, path.join(project, '.git', 's'));
  const { ipcMain, messageBoxes } = wireApp(workspace);

  const result = await ipcMain.invoke(REQ.FS_IMPORT_ITEMS, [project], workspace);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.skippedOther, 2);
  assert.equal(result.files, 2, 'the dialog counted what is really copied');
  assert.deepEqual(result.copied, [path.join(workspace, 'p')]);
  assert.match(messageBoxes[0].detail, /2 items are neither files nor folders/);
  assert.deepEqual((await fs.readdir(path.join(workspace, 'p'))).sort(), ['.git', 'a', 'z.txt']);
  assert.deepEqual(await fs.readdir(path.join(workspace, 'p', 'a')), ['one.txt']);
  assert.deepEqual(await fs.readdir(path.join(workspace, 'p', '.git')), []);
});

test('a dropped FIFO itself is skipped, not half copied (#646)', skipOnWindows, async (t) => {
  const { workspace, home } = await makeFixture(t);
  await fs.writeFile(path.join(home, 'keep.txt'), 'k');
  if (!(await makeFifo(t, path.join(home, 'pipe')))) return;
  const { fsService } = wireApp(workspace);

  const result = await fsService.importExternalItems([path.join(home, 'pipe'), path.join(home, 'keep.txt')], workspace);

  assert.equal(result.ok, true, result.error);
  assert.equal(result.skippedOther, 1);
  assert.deepEqual(result.copied, [path.join(workspace, 'keep.txt')]);
  assert.deepEqual(await fs.readdir(workspace), ['keep.txt']);
});

test('the German dialog names skipped pipes and sockets as well (#646)', async () => {
  const { MESSAGES } = require('../src/shared/i18n');
  assert.match(MESSAGES.de['import.skipped.other.one'], /weder Datei noch Ordner/);
  assert.match(MESSAGES.de['import.skipped.other.other'], /weder Dateien noch Ordner/);
});

test('README.md and readme.md get distinct targets where the file system folds case (#646)', async (t) => {
  const { workspace, home } = await makeFixture(t);
  await fs.mkdir(path.join(home, 'upper'));
  await fs.mkdir(path.join(home, 'lower'));
  await fs.writeFile(path.join(home, 'upper', 'README.md'), 'upper');
  await fs.writeFile(path.join(home, 'lower', 'readme.md'), 'lower');
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1 << 20 });
  const sources = [path.join(home, 'upper', 'README.md'), path.join(home, 'lower', 'readme.md')];

  for (const platform of ['darwin', 'win32']) {
    const inspection = await fsService.inspectImportSources(sources, workspace, { platform });
    assert.deepEqual(
      inspection.targets.map((target) => path.basename(target.targetPath)),
      ['README.md', 'readme (2).md'],
      platform
    );
  }
  const linux = await fsService.inspectImportSources(sources, workspace, { platform: 'linux' });
  assert.deepEqual(linux.targets.map((target) => path.basename(target.targetPath)), ['README.md', 'readme.md']);

  // The real copy, with the comparison of the platform the test runs on: on
  // APFS and NTFS the second one would fail with EEXIST without the fold.
  const result = await fsService.importExternalItems(sources, workspace);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.copied.length, 2);
  const contents = await Promise.all(result.copied.map((copied) => fs.readFile(copied, 'utf8')));
  assert.deepEqual(contents, ['upper', 'lower']);
});

test('a failed import removes what it created and nothing that was there before (#646)', async (t) => {
  const { workspace, home } = await makeFixture(t);
  await fs.writeFile(path.join(home, 'first.txt'), '1');
  await fs.mkdir(path.join(home, 'folder', 'deep'), { recursive: true });
  await fs.writeFile(path.join(home, 'folder', 'a.txt'), 'a');
  await fs.writeFile(path.join(home, 'folder', 'deep', 'b.txt'), 'b');
  await fs.writeFile(path.join(home, 'last.txt'), 'last');
  await fs.writeFile(path.join(workspace, 'first.txt'), 'was here before');

  // The copy of the third source fails after the first two went through, the
  // folder half way: one file in, then the error.
  let cpCalls = 0;
  const failingFs = Object.create(fs);
  failingFs.cp = async (source, target, options) => {
    cpCalls += 1;
    if (path.basename(source) === 'folder') {
      await fs.cp(path.join(source, 'a.txt'), path.join(target, 'a.txt'));
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    }
    return fs.cp(source, target, options);
  };
  const fsService = createFsService({ fs: failingFs, path, maxReadFileBytes: 1 << 20 });

  const result = await fsService.importExternalItems(
    [path.join(home, 'first.txt'), path.join(home, 'last.txt'), path.join(home, 'folder')],
    workspace
  );

  assert.match(result.error, /Copying failed: ENOSPC/);
  assert.deepEqual(result.copied, [], 'nothing of this import is left');
  assert.equal(cpCalls, 3);
  assert.deepEqual(await fs.readdir(workspace), ['first.txt']);
  assert.equal(await fs.readFile(path.join(workspace, 'first.txt'), 'utf8'), 'was here before');
});

test('a folder that turned up at the target since the check is not merged into or removed (#646)', async (t) => {
  const { workspace, home } = await makeFixture(t);
  await fs.mkdir(path.join(home, 'docs'));
  await fs.writeFile(path.join(home, 'docs', 'new.txt'), 'new');
  const racingFs = Object.create(fs);
  racingFs.mkdir = async (target, options) => {
    // Somebody else creates the folder between the check and the copy.
    if (target === path.join(workspace, 'docs')) {
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'theirs.txt'), 'theirs');
    }
    return fs.mkdir(target, options);
  };
  const fsService = createFsService({ fs: racingFs, path, maxReadFileBytes: 1 << 20 });

  const result = await fsService.importExternalItems([path.join(home, 'docs')], workspace);

  assert.match(result.error, /EEXIST/);
  assert.deepEqual(result.copied, []);
  assert.deepEqual(await fs.readdir(path.join(workspace, 'docs')), ['theirs.txt']);
});
