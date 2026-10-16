const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createFilesystemIpcAdapter } = require('../src/main/adapters/filesystem-ipc-adapter');
const { registerFsHandlers } = require('../src/main/ipc/fs-handlers');
const { REQUEST_CHANNELS: REQ } = require('../src/shared/ipc-channels');
const { createMockIpcMain } = require('./helpers/mock-ipc');

// #863: the user's own edit from the preview goes through the same checks as
// the agent's write tool, and never overwrites a file that changed meanwhile.

const sha256 = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const skipOnWindows = { skip: process.platform === 'win32' };

async function setup(t, { maxWriteFileBytes } = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-user-write-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const workspace = path.join(dir, 'ws');
  await fs.mkdir(workspace);
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1 << 20, maxWriteFileBytes });
  const filesystem = createFilesystemIpcAdapter({ fsService, getActiveWorkspaceRoot: () => workspace });
  const ipcMain = createMockIpcMain();
  registerFsHandlers({ ipcMain, filesystem, REQ, getMainWindow: () => null });
  const write = (filePath, content, options) => ipcMain.invoke(REQ.FS_WRITE_FILE, filePath, content, options);
  return { dir, workspace, write };
}

test('a file written with the hash it was read with is saved', async (t) => {
  const { workspace, write } = await setup(t);
  const file = path.join(workspace, 'note.md');
  await fs.writeFile(file, 'old\n');

  const result = await write(file, 'new\n', { baseHash: sha256('old\n') });

  assert.equal(result.ok, true);
  assert.equal(result.size, 4);
  assert.equal(typeof result.modified, 'number');
  assert.equal(await fs.readFile(file, 'utf8'), 'new\n');
});

test('a file that changed on disk is not overwritten without force', async (t) => {
  const { workspace, write } = await setup(t);
  const file = path.join(workspace, 'note.md');
  await fs.writeFile(file, 'changed by someone else\n');

  assert.deepEqual(await write(file, 'mine\n', { baseHash: sha256('what the editor read\n') }), { conflict: 'changed' });
  assert.equal(await fs.readFile(file, 'utf8'), 'changed by someone else\n');

  const forced = await write(file, 'mine\n', { baseHash: sha256('what the editor read\n'), force: true });
  assert.equal(forced.ok, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'mine\n');
});

test('a file deleted meanwhile is a conflict, and force writes it again', async (t) => {
  const { workspace, write } = await setup(t);
  const file = path.join(workspace, 'gone.txt');

  assert.deepEqual(await write(file, 'mine', { baseHash: sha256('x') }), { conflict: 'deleted' });
  await assert.rejects(fs.stat(file));
  assert.equal((await write(file, 'mine', { force: true })).ok, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'mine');
});

test('a path outside the workspace is refused, lexically and through a link', async (t) => {
  const { dir, workspace, write } = await setup(t);
  const outside = path.join(dir, 'outside.txt');
  await fs.writeFile(outside, 'secret');

  const escaped = await write(path.join(workspace, '..', 'outside.txt'), 'x', { force: true });
  assert.equal(escaped.reason, 'refused');
  const elsewhere = await write(outside, 'x', { force: true });
  assert.equal(elsewhere.reason, 'refused');
  assert.equal((await write('relative.txt', 'x', { force: true })).reason, 'refused');
  assert.equal((await write(workspace, 'x', { force: true })).reason, 'refused');
  assert.equal(await fs.readFile(outside, 'utf8'), 'secret');
});

test('a link inside the workspace pointing out of it is refused', skipOnWindows, async (t) => {
  const { dir, workspace, write } = await setup(t);
  const outside = path.join(dir, 'outside.txt');
  await fs.writeFile(outside, 'secret');
  const link = path.join(workspace, 'link.txt');
  await fs.symlink(outside, link);

  const result = await write(link, 'x', { baseHash: sha256('secret'), force: true });
  assert.equal(result.reason, 'refused');
  assert.equal(await fs.readFile(outside, 'utf8'), 'secret');
});

test('a text over the write limit is refused before anything is touched', async (t) => {
  const { workspace, write } = await setup(t, { maxWriteFileBytes: 8 });
  const file = path.join(workspace, 'small.txt');
  await fs.writeFile(file, 'abc');

  const result = await write(file, 'more than eight bytes', { baseHash: sha256('abc') });
  assert.equal(result.reason, 'too-large');
  assert.equal(await fs.readFile(file, 'utf8'), 'abc');
});

test('a file that is not valid UTF-8 is never written', async (t) => {
  const { workspace, write } = await setup(t);
  const file = path.join(workspace, 'latin1.txt');
  const bytes = Buffer.from([0x47, 0x72, 0xfc, 0xdf, 0x65]); // "Grüße" in Latin-1
  await fs.writeFile(file, bytes);

  const result = await write(file, bytes.toString('utf8'), { force: true });
  assert.equal(result.reason, 'encoding');
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('a folder is not a file to write', async (t) => {
  const { workspace, write } = await setup(t);
  await fs.mkdir(path.join(workspace, 'sub'));

  const result = await write(path.join(workspace, 'sub'), 'x', { force: true });
  assert.ok(result.error);
  assert.notEqual(result.ok, true);
});

test('the file mode survives the atomic write', skipOnWindows, async (t) => {
  const { workspace, write } = await setup(t);
  const file = path.join(workspace, 'run.sh');
  await fs.writeFile(file, 'echo a\n');
  await fs.chmod(file, 0o755);

  assert.equal((await write(file, 'echo b\n', { baseHash: sha256('echo a\n') })).ok, true);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o755);
});
