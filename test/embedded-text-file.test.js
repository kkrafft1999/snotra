const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('fs');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const { createEmbeddedTextFiles } = require('../src/main/services/embedded-text-file');
const { createProjectInstructionsAdapter } = require('../src/main/adapters/project-instructions-adapter');
const { createMemoryAdapter } = require('../src/main/adapters/memory-adapter');
const { MEMORY_SCOPES, MEMORY_ORIGINS } = require('../src/shared/contracts/memory');
const { PROJECT_INSTRUCTION_SOURCES: SRC } = require('../src/shared/contracts/project-instructions');

// Against the real file system: the point of #534 is what a symlink does,
// and an in-memory stand-in has none.

async function sandbox(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-embedded-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const workspace = path.join(base, 'cloned-repo');
  const outside = path.join(base, 'outside');
  await Promise.all([home, workspace, outside].map((dir) => fs.mkdir(dir, { recursive: true })));
  return { base, home, workspace, outside };
}

/** Creates a symlink, or skips the test where that needs rights (Windows). */
async function symlinkOrSkip(t, target, at, type = 'file') {
  try {
    await fs.symlink(target, at, type);
    return true;
  } catch (error) {
    if (error && (error.code === 'EPERM' || error.code === 'EACCES')) {
      t.skip('creating a symlink needs rights here');
      return false;
    }
    throw error;
  }
}

test('an AGENTS.md that links out of the folder stays out of the prompt (#534)', async (t) => {
  const { home, workspace, outside } = await sandbox(t);
  await fs.writeFile(path.join(outside, '.env'), 'OPENAI_API_KEY=sk-proj-secret');
  if (!(await symlinkOrSkip(t, path.join('..', 'outside', '.env'), path.join(workspace, 'AGENTS.md')))) return;
  const adapter = createProjectInstructionsAdapter({ fs, path, os: { homedir: () => home } });
  assert.deepEqual(await adapter.load({ workspaceRoot: workspace }), []);
});

test('an AGENTS.md that links inside the folder keeps working (#534)', async (t) => {
  const { home, workspace } = await sandbox(t);
  await fs.mkdir(path.join(workspace, 'docs'));
  await fs.writeFile(path.join(workspace, 'docs', 'AGENTS.md'), 'Run npm test.');
  if (!(await symlinkOrSkip(t, path.join('docs', 'AGENTS.md'), path.join(workspace, 'AGENTS.md')))) return;
  const adapter = createProjectInstructionsAdapter({ fs, path, os: { homedir: () => home } });
  const files = await adapter.load({ workspaceRoot: workspace });
  assert.deepEqual(files, [{ source: SRC.WORKSPACE_AGENTS, text: 'Run npm test.', truncated: false }]);
});

test('a global AGENTS.md may link anywhere — a dotfiles manager does that (#534)', async (t) => {
  const { home, outside } = await sandbox(t);
  await fs.writeFile(path.join(outside, 'AGENTS.md'), 'Address me as du.');
  await fs.mkdir(path.join(home, '.snotra'));
  if (!(await symlinkOrSkip(t, path.join(outside, 'AGENTS.md'), path.join(home, '.snotra', 'AGENTS.md')))) return;
  const adapter = createProjectInstructionsAdapter({ fs, path, os: { homedir: () => home } });
  const files = await adapter.load({ workspaceRoot: null });
  assert.deepEqual(files.map((f) => f.source), [SRC.USER_SNOTRA]);
});

test('a device behind AGENTS.md is not opened (#534)', { skip: process.platform === 'win32' }, async (t) => {
  const { home, workspace } = await sandbox(t);
  await fs.mkdir(path.join(home, '.agents'));
  if (!(await symlinkOrSkip(t, '/dev/zero', path.join(home, '.agents', 'AGENTS.md')))) return;
  const adapter = createProjectInstructionsAdapter({ fs, path, os: { homedir: () => home } });
  assert.deepEqual(await adapter.load({ workspaceRoot: workspace }), []);
});

test('a read for the prompt stops at its limit instead of reading the whole file (#534)', async (t) => {
  const { workspace } = await sandbox(t);
  const file = path.join(workspace, 'AGENTS.md');
  await fs.writeFile(file, 'x'.repeat(4 * 1024 * 1024));
  let bytes = 0;
  const countingFs = {
    ...fs,
    async open(...args) {
      const handle = await fs.open(...args);
      return {
        async read(...readArgs) {
          const result = await handle.read(...readArgs);
          bytes += result.bytesRead;
          return result;
        },
        close: () => handle.close(),
      };
    },
  };
  const read = await createEmbeddedTextFiles({ fs: countingFs, path })
    .readForPrompt({ file, root: workspace, maxChars: 1000 });
  assert.equal(read.text.length, 1000);
  assert.equal(read.truncated, true);
  assert.ok(bytes <= 1000 * 4 + 4, `read ${bytes} bytes`);
});

test('a multi-byte character at the limit is not cut in half', async (t) => {
  const { workspace } = await sandbox(t);
  const file = path.join(workspace, 'AGENTS.md');
  await fs.writeFile(file, 'ä'.repeat(50));
  const files = createEmbeddedTextFiles({ fs, path });
  assert.deepEqual(await files.readForPrompt({ file, root: workspace, maxChars: 10 }), {
    text: 'ä'.repeat(10),
    truncated: true,
  });
  assert.deepEqual(await files.readForPrompt({ file, root: workspace, maxChars: 50 }), {
    text: 'ä'.repeat(50),
    truncated: false,
  });
});

test('remember refuses a memory.md that links out of the folder, and leaves it alone (#534)', async (t) => {
  const { home, workspace, outside } = await sandbox(t);
  const gitconfig = path.join(outside, 'gitconfig');
  await fs.writeFile(gitconfig, '[user]\n  name = me\n');
  await fs.mkdir(path.join(workspace, '.agents'));
  const link = path.join(workspace, '.agents', 'memory.md');
  if (!(await symlinkOrSkip(t, path.join('..', '..', 'outside', 'gitconfig'), link))) return;
  const memory = createMemoryAdapter({ fs, path, os: { homedir: () => home } });
  await assert.rejects(
    () => memory.remember({ scope: MEMORY_SCOPES.WORKSPACE, workspaceRoot: workspace, text: 'injected', origin: MEMORY_ORIGINS.REQUESTED }),
    /outside the open folder/
  );
  assert.equal(await fs.readFile(gitconfig, 'utf8'), '[user]\n  name = me\n');
  assert.deepEqual(await memory.load({ workspaceRoot: workspace }), []);
  await assert.rejects(
    () => memory.forget({ scope: MEMORY_SCOPES.WORKSPACE, workspaceRoot: workspace, line: 1, text: 'name = me' }),
    /outside the open folder/
  );
});

test('remember refuses a symlinked .agents folder and creates nothing outside (#534)', async (t) => {
  const { home, workspace, outside } = await sandbox(t);
  if (!(await symlinkOrSkip(t, outside, path.join(workspace, '.agents'), 'dir'))) return;
  const memory = createMemoryAdapter({ fs, path, os: { homedir: () => home } });
  await assert.rejects(
    () => memory.remember({ scope: MEMORY_SCOPES.WORKSPACE, workspaceRoot: workspace, text: 'injected', origin: MEMORY_ORIGINS.REQUESTED }),
    /outside the open folder/
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('a memory.md linked inside the folder is written through, the link stays (#534)', async (t) => {
  const { home, workspace } = await sandbox(t);
  await fs.mkdir(path.join(workspace, 'notes'));
  await fs.mkdir(path.join(workspace, '.agents'));
  const real = path.join(workspace, 'notes', 'memory.md');
  await fs.writeFile(real, '# Memory · project\n');
  const link = path.join(workspace, '.agents', 'memory.md');
  if (!(await symlinkOrSkip(t, path.join('..', 'notes', 'memory.md'), link))) return;
  const memory = createMemoryAdapter({ fs, path, os: { homedir: () => home } });
  await memory.remember({ scope: MEMORY_SCOPES.WORKSPACE, workspaceRoot: workspace, text: 'kept', origin: MEMORY_ORIGINS.REQUESTED });
  assert.ok((await fs.lstat(link)).isSymbolicLink(), 'the link is still a link');
  assert.match(await fs.readFile(real, 'utf8'), /— kept\n$/);
});

test('a write is atomic: no temporary file is left, the mode is kept', async (t) => {
  const { home } = await sandbox(t);
  const dir = path.join(home, '.snotra');
  await fs.mkdir(dir);
  const file = path.join(dir, 'memory.md');
  await fs.writeFile(file, '# Memory · global\n', { mode: 0o600 });
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
  const memory = createMemoryAdapter({ fs, path, os: { homedir: () => home } });
  await memory.remember({ scope: MEMORY_SCOPES.USER, text: 'eins', origin: MEMORY_ORIGINS.REQUESTED });
  assert.deepEqual(await fs.readdir(dir), ['memory.md']);
  if (process.platform !== 'win32') assert.equal(fsSync.statSync(file).mode & 0o777, 0o600);
});
