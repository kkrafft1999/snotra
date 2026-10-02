const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createFsService } = require('../src/main/services/fs-service');
const { NOT_A_REGULAR_FILE_ERROR } = require('../src/main/services/read-regular-file');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { createTranslator } = require('../src/shared/i18n');

// FIFOs exist on macOS and Linux only.
const fifoOnly = { skip: process.platform === 'win32' };

function makeService() {
  return createFsService({ fs, path, maxReadFileBytes: 1024 * 1024 });
}

/**
 * A reader blocked in open(2) on a FIFO holds a thread-pool thread until a
 * writer appears. Should a read ever block again, this releases it, so that a
 * failing test fails instead of hanging the test run.
 */
function release(fifo) {
  try {
    const fd = fsSync.openSync(fifo, fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK);
    fsSync.closeSync(fd);
  } catch {
    /* no reader waiting */
  }
}

async function makeRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fifo-'));
  const fifos = [];
  t.after(async () => {
    fifos.forEach(release);
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    root,
    mkfifo(rel) {
      const abs = path.join(root, rel);
      execFileSync('mkfifo', [abs]);
      fifos.push(abs);
      return abs;
    },
  };
}

/** Resolves with the call's result, or fails when it is still pending after a second. */
async function withinASecond(promise) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('still pending after 1000 ms')), 1000);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('the read tools refuse a named pipe at once instead of opening it (#643)', fifoOnly, async (t) => {
  const { root, mkfifo } = await makeRoot(t);
  mkfifo('pipe.txt');
  const svc = makeService();
  const args = { relative_path: 'pipe.txt' };

  for (const run of [svc.runReadFileTextTool, svc.runReadFileLinesTool, svc.runOutlineFileTool]) {
    const result = JSON.parse(await withinASecond(run(args, root)));
    assert.equal(result.error, NOT_A_REGULAR_FILE_ERROR, run.name);
  }

  const searched = JSON.parse(await withinASecond(svc.runSearchInFilesTool({ query: 'x', ...args }, root)));
  assert.equal(searched.error, NOT_A_REGULAR_FILE_ERROR);

  const stat = JSON.parse(await withinASecond(svc.runStatPathTool({ ...args, include_line_count: true }, root)));
  assert.equal(stat.exists, true);
  assert.equal(stat.line_count, undefined);
  assert.match(stat.line_count_skipped, /Not a regular file/);
});

test('load_skill refuses a SKILL.md that is a named pipe (#643)', fifoOnly, async (t) => {
  const { root, mkfifo } = await makeRoot(t);
  await fs.mkdir(path.join(root, 'demo'));
  mkfifo(path.join('demo', 'SKILL.md'));
  const result = JSON.parse(
    await withinASecond(
      makeService().runLoadSkillTool({ name: 'demo' }, root, { skillRoots: [{ name: 'demo', dir: path.join(root, 'demo') }] })
    )
  );
  assert.equal(result.error, NOT_A_REGULAR_FILE_ERROR);
});

test('the file preview answers a named pipe with a translated error (#643)', fifoOnly, async (t) => {
  const { mkfifo } = await makeRoot(t);
  const fifo = mkfifo('pipe.txt');
  for (const locale of ['en', 'de']) {
    const svc = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, getLocale: () => locale });
    const result = await withinASecond(svc.readFilePreview(fifo));
    assert.deepEqual(result, { error: createTranslator(locale)('fs.error.previewNotAFile') });
  }
});

test('a broad search and listing skip a named pipe silently (#643)', fifoOnly, async (t) => {
  const { root, mkfifo } = await makeRoot(t);
  mkfifo('pipe.txt');
  await fs.writeFile(path.join(root, 'real.txt'), 'x marks the spot\n', 'utf8');
  const svc = makeService();

  const searched = JSON.parse(await withinASecond(svc.runSearchInFilesTool({ query: 'x' }, root)));
  assert.equal(searched.error, undefined);
  assert.deepEqual(searched.matches.map((match) => match.file), ['real.txt']);

  const found = JSON.parse(await withinASecond(svc.runFindFilesTool({ pattern: '*' }, root)));
  assert.deepEqual(found.results.map((entry) => entry.path), ['real.txt']);
});

test('a .gitignore that is a named pipe counts as absent (#643)', fifoOnly, async (t) => {
  const { root, mkfifo } = await makeRoot(t);
  mkfifo('.gitignore');
  await fs.writeFile(path.join(root, 'a.txt'), 'x\n', 'utf8');
  const svc = makeService();

  const found = JSON.parse(await withinASecond(svc.runFindFilesTool({ pattern: '*.txt' }, root)));
  assert.deepEqual(found.results.map((entry) => entry.path), ['a.txt']);
  const searched = JSON.parse(await withinASecond(svc.runSearchInFilesTool({ query: 'x' }, root)));
  assert.equal(searched.matches.length, 1);
  const tree = JSON.parse(await withinASecond(svc.runListDirectoryTreeTool({}, root)));
  assert.match(tree.tree, /a\.txt/);
  const listed = await withinASecond(svc.listWorkspacePaths(root));
  assert.deepEqual(listed.entries.map((entry) => entry.path), ['a.txt']);
});

test('the sensitive-content check never opens a named pipe (#643)', fifoOnly, async (t) => {
  const { mkfifo } = await makeRoot(t);
  const fifo = mkfifo('pipe.txt');
  // The pipe appears between the tool's read and the check of the whole file.
  const registry = {
    getDefinition: (name) => ({ name, riskClass: 'read' }),
    getTools: () => [],
    buildSystemPrompt: () => '',
    execute: async () => JSON.stringify({ content: 'harmless' }),
  };
  const adapter = createWorkspaceToolAdapter(registry, { fs });
  const plan = { targets: [{ kind: 'file', exists: true, absPath: fifo }] };
  const result = await withinASecond(adapter.execute('read_file_text', { relative_path: 'pipe.txt' }, { plan }));
  assert.equal(JSON.parse(result.output).content, 'harmless');
  assert.equal(result.sensitive, undefined);
});

test('a .gitignore that leads out of the folder is ignored (#643)', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-gitignore-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  await fs.writeFile(path.join(base, 'outside-ignore'), '*.txt\n', 'utf8');
  await fs.writeFile(path.join(root, 'a.txt'), 'x\n', 'utf8');
  try {
    await fs.symlink(path.join(base, 'outside-ignore'), path.join(root, '.gitignore'));
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) {
      t.skip(`no symlinks on this platform: ${e.code}`);
      return;
    }
    throw e;
  }
  const found = JSON.parse(await makeService().runFindFilesTool({ pattern: '*.txt' }, root));
  assert.deepEqual(found.results.map((entry) => entry.path), ['a.txt']);
});

test('a .gitignore over its size limit is ignored, one below it applies (#643)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-gitignore-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'a.txt'), 'x\n', 'utf8');
  const svc = makeService();
  const paths = async () => (await svc.listWorkspacePaths(root)).entries.map((entry) => entry.path);

  // GITIGNORE_MAX_BYTES in fs-service.js is 256 KB.
  const padding = `# ${'-'.repeat(1000)}\n`.repeat(300);
  await fs.writeFile(path.join(root, '.gitignore'), `*.txt\n${padding}`, 'utf8');
  assert.deepEqual(await paths(), ['a.txt'], 'too large: as if there were none');

  await fs.writeFile(path.join(root, '.gitignore'), '*.txt\n', 'utf8');
  assert.deepEqual(await paths(), []);
});
