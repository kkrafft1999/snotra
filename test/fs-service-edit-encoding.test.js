'use strict';

// edit_file and apply_patch only change UTF-8 text (#645): a file in another
// encoding, or with NUL bytes, is refused and stays byte for byte as it was, a
// pipe is refused instead of blocking (#643), and the rollback of a multi-file
// patch restores the original bytes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');

const LIMITS = { maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 };
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

async function makeWorkspace(t, files = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-edit-encoding-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    await fs.writeFile(path.join(workspace, rel), content);
  }
  return workspace;
}

function makeRegistry(fsService = createFsService({ fs, path, ...LIMITS })) {
  const registry = createWorkspaceToolRegistry({ fsService });
  return async (name, args, workspaceRoot) =>
    JSON.parse(await registry.execute(name, args, { approved: true, workspaceRoot, allowWrite: true }));
}

/** The three ways to change `version=1` to `version=2` in `rel`. */
function editCalls(rel) {
  return [
    ['edit_file', { relative_path: rel, old_string: 'version=1', new_string: 'version=2' }],
    ['apply_patch (edits)', { relative_path: rel, edits: [{ old_string: 'version=1', new_string: 'version=2' }] }],
    ['apply_patch (patch)', { patch: [`--- ${rel}`, `+++ ${rel}`, '@@ -2,1 +2,1 @@', '-version=1', '+version=2', ''].join('\n') }],
  ];
}

const REFUSED = [
  ['a Latin-1 file', Buffer.from('# Kunde: Müller, Straße\nversion=1\n', 'latin1'), /not valid UTF-8/],
  ['a file with a NUL byte', Buffer.from('head\u0000er\nversion=1\n', 'utf8'), /NUL bytes/],
  ['a UTF-16 file', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# x\nversion=1\n', 'utf16le')]), /NUL bytes/],
];

for (const [label, bytes, message] of REFUSED) {
  test(`edit_file, the edits form and apply_patch refuse ${label} and leave its bytes alone (#645)`, async (t) => {
    const workspace = await makeWorkspace(t, { 'app.properties': bytes });
    const run = makeRegistry();
    for (const [tool, args] of editCalls('app.properties')) {
      const out = await run(tool.startsWith('apply_patch') ? 'apply_patch' : tool, args, workspace);
      assert.match(out.error, message, tool);
      assert.match(out.error, /left unchanged/, tool);
      assert.equal((await fs.readFile(path.join(workspace, 'app.properties'))).equals(bytes), true, tool);
    }
  });
}

test('a UTF-8 byte-order mark survives edit_file, the edits form and apply_patch (#645)', async (t) => {
  const original = Buffer.concat([BOM, Buffer.from('# Straße\nversion=1\n', 'utf8')]);
  const run = makeRegistry();
  for (const [tool, args] of editCalls('app.properties')) {
    const workspace = await makeWorkspace(t, { 'app.properties': original });
    const out = await run(tool.startsWith('apply_patch') ? 'apply_patch' : tool, args, workspace);
    assert.equal(out.error, undefined, tool);
    const expected = Buffer.concat([BOM, Buffer.from('# Straße\nversion=2\n', 'utf8')]);
    assert.equal((await fs.readFile(path.join(workspace, 'app.properties'))).equals(expected), true, tool);
  }
});

test(
  'edit_file and apply_patch refuse a named pipe promptly instead of blocking on it (#643)',
  { skip: process.platform === 'win32' && 'no FIFOs on Windows', timeout: 5000 },
  async (t) => {
    const workspace = await makeWorkspace(t);
    try {
      execFileSync('mkfifo', [path.join(workspace, 'app.properties')]);
    } catch (e) {
      t.skip(`mkfifo is not available: ${e.message}`);
      return;
    }
    const run = makeRegistry();
    for (const [tool, args] of editCalls('app.properties')) {
      const started = Date.now();
      const out = await run(tool.startsWith('apply_patch') ? 'apply_patch' : tool, args, workspace);
      assert.match(out.error, /Not a regular file/, tool);
      assert.ok(Date.now() - started < 1000, `${tool} answered within a second`);
    }
  }
);

test('the rollback of a multi-file patch restores the original bytes (#645)', async (t) => {
  const firstBytes = Buffer.concat([BOM, Buffer.from('eins\r\nzwei — ä\r\n', 'utf8')]);
  const workspace = await makeWorkspace(t, { 'a.txt': firstBytes, 'b.txt': 'alpha\n' });
  const failingFs = {
    ...fs,
    rename: async (from, to) => {
      if (path.basename(to) === 'b.txt') {
        throw Object.assign(new Error('EIO: i/o error, rename'), { code: 'EIO' });
      }
      return fs.rename(from, to);
    },
  };
  const run = makeRegistry(createFsService({ fs: failingFs, path, ...LIMITS }));

  const out = await run(
    'apply_patch',
    {
      patch: [
        '--- a.txt', '+++ a.txt', '@@ -1,1 +1,1 @@', '-eins', '+EINS',
        '--- b.txt', '+++ b.txt', '@@ -1,1 +1,1 @@', '-alpha', '+ALPHA', '',
      ].join('\n'),
    },
    workspace
  );

  assert.match(out.error, /"b\.txt": EIO/);
  assert.match(out.error, /restored/);
  assert.equal((await fs.readFile(path.join(workspace, 'a.txt'))).equals(firstBytes), true);
  assert.equal((await fs.readFile(path.join(workspace, 'b.txt'))).equals(Buffer.from('alpha\n')), true);
});
