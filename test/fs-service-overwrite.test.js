'use strict';

// Overwriting a workspace file (#642): the recovery copy never follows a link
// planted at its name, a write through an in-workspace symlink changes the real
// file and keeps the link, and the final rename survives Windows' transient locks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');

const TMP_MARKER = '.snotra-tmp-';
const LIMITS = { maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 };

async function makeFixture(t, files = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-overwrite-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(workspace, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return { workspace, outside };
}

async function symlinkOrSkip(t, target, linkPath) {
  try {
    await fs.symlink(target, linkPath, 'file');
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) {
      t.skip(`symlinks are not available here: ${e.code}`);
      return false;
    }
    throw e;
  }
}

function makeRegistry(fsService) {
  const registry = createWorkspaceToolRegistry({ fsService });
  return {
    execute: async (name, args, workspaceRoot) =>
      JSON.parse(await registry.execute(name, args, { approved: true, workspaceRoot, allowWrite: true })),
  };
}

async function listTmpFiles(dir) {
  return (await fs.readdir(dir)).filter((name) => name.includes(TMP_MARKER));
}

const STAMP = new Date('2026-10-02T08:15:30.123Z');
const copyName = (base, id) => `${base}.snotra-backup-2026-10-02T08-15-30-123Z-${id}`;

test(
  'the recovery copy never writes through a symlink or a dangling symlink planted at its name (#642)',
  { skip: process.platform === 'win32' && 'planting symlinks needs a privilege on Windows' },
  async (t) => {
    const { workspace, outside } = await makeFixture(t, { 'notes.md': 'payload the model wrote\n' });
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'outside content\n');
    const notYetThere = path.join(outside, 'created-through-link.txt');
    // Exactly the names the next two attempts will use: a live link out of the
    // workspace and a dangling one whose target would be created.
    await fs.symlink(victim, path.join(workspace, copyName('notes.md', 'aaaa')));
    await fs.symlink(notYetThere, path.join(workspace, copyName('notes.md', 'bbbb')));

    const ids = ['aaaa', 'bbbb', 'cccc'];
    const svc = createFsService({ fs, path, ...LIMITS, now: () => STAMP, randomSuffix: () => ids.shift() });
    const trashed = [];
    const out = JSON.parse(
      await svc.runWriteFileTextTool({ relative_path: 'notes.md', content: 'new text\n' }, workspace, {
        recovery: {
          trashItem: async (p) => {
            trashed.push(path.basename(p));
            await fs.unlink(p);
          },
        },
      })
    );

    assert.equal(out.overwritten, true);
    assert.equal(out.recovery_copy_in_trash, copyName('notes.md', 'cccc'), 'the third, free name is used');
    assert.deepEqual(trashed, [copyName('notes.md', 'cccc')]);
    assert.equal(await fs.readFile(victim, 'utf8'), 'outside content\n', 'nothing written outside');
    assert.deepEqual((await fs.readdir(outside)).sort(), ['victim.txt'], 'nothing created outside');
    for (const id of ['aaaa', 'bbbb']) {
      const st = await fs.lstat(path.join(workspace, copyName('notes.md', id)));
      assert.equal(st.isSymbolicLink(), true, `the link ${id} is left as it was`);
    }
    assert.equal(await fs.readFile(path.join(workspace, 'notes.md'), 'utf8'), 'new text\n');
  }
);

test(
  'when every fresh name is taken, the overwrite is refused as recovery_failed and nothing is written (#642)',
  { skip: process.platform === 'win32' && 'planting symlinks needs a privilege on Windows' },
  async (t) => {
    const { workspace, outside } = await makeFixture(t, { 'notes.md': 'old\n' });
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'outside content\n');
    await fs.symlink(victim, path.join(workspace, copyName('notes.md', 'same')));

    const svc = createFsService({ fs, path, ...LIMITS, now: () => STAMP, randomSuffix: () => 'same' });
    const out = JSON.parse(
      await svc.runWriteFileTextTool({ relative_path: 'notes.md', content: 'new\n' }, workspace, {
        recovery: { trashItem: async () => assert.fail('nothing to trash') },
      })
    );

    assert.equal(out.code, 'recovery_failed');
    assert.match(out.error, /EEXIST/);
    assert.equal(await fs.readFile(path.join(workspace, 'notes.md'), 'utf8'), 'old\n');
    assert.equal(await fs.readFile(victim, 'utf8'), 'outside content\n');
  }
);

test('write_file_text, edit_file and apply_patch write through an in-workspace symlink and keep it a link (#642)', async (t) => {
  const { workspace } = await makeFixture(t, { 'AGENTS.md': 'v0\n', 'docs/guide.md': 'g0\n' });
  if (!(await symlinkOrSkip(t, 'AGENTS.md', path.join(workspace, 'CLAUDE.md')))) return;
  if (!(await symlinkOrSkip(t, path.join('docs', 'guide.md'), path.join(workspace, 'guide.md')))) return;
  const registry = makeRegistry(createFsService({ fs, path, ...LIMITS }));
  const agents = path.join(workspace, 'AGENTS.md');

  const written = await registry.execute('write_file_text', { relative_path: 'CLAUDE.md', content: 'v1\n' }, workspace);
  assert.equal(written.overwritten, true);
  assert.equal(await fs.readFile(agents, 'utf8'), 'v1\n');

  const edited = await registry.execute(
    'edit_file',
    { relative_path: 'CLAUDE.md', old_string: 'v1', new_string: 'v2' },
    workspace
  );
  assert.equal(edited.replacements, 1);
  assert.equal(await fs.readFile(agents, 'utf8'), 'v2\n');

  const patched = await registry.execute(
    'apply_patch',
    { patch: ['--- CLAUDE.md', '+++ CLAUDE.md', '@@ -1,1 +1,1 @@', '-v2', '+v3', ''].join('\n') },
    workspace
  );
  assert.equal(patched.files_changed, 1);
  assert.equal(await fs.readFile(agents, 'utf8'), 'v3\n');

  const viaEdits = await registry.execute(
    'apply_patch',
    { relative_path: 'guide.md', edits: [{ old_string: 'g0', new_string: 'g1' }] },
    workspace
  );
  assert.equal(viaEdits.edits_applied, 1);
  assert.equal(await fs.readFile(path.join(workspace, 'docs', 'guide.md'), 'utf8'), 'g1\n');

  for (const link of ['CLAUDE.md', 'guide.md']) {
    assert.equal((await fs.lstat(path.join(workspace, link))).isSymbolicLink(), true, `${link} is still a link`);
  }
  assert.equal(await fs.readlink(path.join(workspace, 'CLAUDE.md')), 'AGENTS.md');
  assert.deepEqual(await listTmpFiles(workspace), []);
  assert.deepEqual(await listTmpFiles(path.join(workspace, 'docs')), []);
});

test('the temporary file is created exclusively (#642)', async (t) => {
  const { workspace } = await makeFixture(t, { 'a.txt': 'old' });
  const flags = [];
  const spyFs = {
    ...fs,
    writeFile: async (target, data, options) => {
      if (String(target).includes(TMP_MARKER)) flags.push(options && options.flag);
      return fs.writeFile(target, data, options);
    },
  };
  const registry = makeRegistry(createFsService({ fs: spyFs, path, ...LIMITS }));

  await registry.execute('write_file_text', { relative_path: 'a.txt', content: 'new' }, workspace);
  await registry.execute('edit_file', { relative_path: 'a.txt', old_string: 'new', new_string: 'newer' }, workspace);

  assert.deepEqual(flags, ['wx', 'wx']);
  assert.equal(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'newer');
});

function makeLockedRenameFs() {
  const calls = { rename: 0 };
  const lockedFs = {
    ...fs,
    rename: async (from, to) => {
      calls.rename += 1;
      if (calls.rename === 1) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' });
      }
      return fs.rename(from, to);
    },
  };
  return { lockedFs, calls };
}

test('on Windows the rename retries a transient EPERM and the write lands (#642)', async (t) => {
  const { workspace } = await makeFixture(t, { 'a.txt': 'old' });
  const { lockedFs, calls } = makeLockedRenameFs();
  const registry = makeRegistry(createFsService({ fs: lockedFs, path, ...LIMITS, platform: 'win32' }));

  const out = await registry.execute('write_file_text', { relative_path: 'a.txt', content: 'new' }, workspace);

  assert.equal(out.error, undefined);
  assert.equal(out.overwritten, true);
  assert.equal(calls.rename, 2);
  assert.equal(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'new');
  assert.deepEqual(await listTmpFiles(workspace), []);
});

test('elsewhere the first EPERM of the rename is the answer and the file keeps its content (#642)', async (t) => {
  const { workspace } = await makeFixture(t, { 'a.txt': 'old' });
  const { lockedFs, calls } = makeLockedRenameFs();
  const registry = makeRegistry(createFsService({ fs: lockedFs, path, ...LIMITS, platform: 'linux' }));

  const out = await registry.execute('write_file_text', { relative_path: 'a.txt', content: 'new' }, workspace);

  assert.match(out.error, /EPERM/);
  assert.equal(calls.rename, 1);
  assert.equal(await fs.readFile(path.join(workspace, 'a.txt'), 'utf8'), 'old');
  assert.deepEqual(await listTmpFiles(workspace), []);
});

test('a new file is not written through a folder swapped for a link out of the workspace', { skip: process.platform === 'win32' }, async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-new-file-swap-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const ws = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  await fs.mkdir(path.join(ws, 'docs'), { recursive: true });
  await fs.mkdir(outside);
  const svc = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  // The plan saw a real folder; then a run swaps it for a link out.
  const resolved = await svc.resolveWorkspacePathForAccess(ws, 'docs/new.md');
  assert.equal(resolved.error, undefined);
  await fs.rm(path.join(ws, 'docs'), { recursive: true });
  await fs.symlink(outside, path.join(ws, 'docs'));
  const out = JSON.parse(await svc.runWriteFileTextTool({ relative_path: 'docs/new.md', content: 'x\n' }, ws));
  assert.ok(out.error, 'the write is refused');
  assert.deepEqual(await fs.readdir(outside), []);
});
