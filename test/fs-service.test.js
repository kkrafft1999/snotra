const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');

function makeFsService() {
  return createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
}

function makeToolRegistry(fsService = makeFsService()) {
  return createWorkspaceToolRegistry({ fsService });
}

async function createSymlinkOrSkip(t, target, linkPath, type) {
  try {
    await fs.symlink(target, linkPath, type);
    return true;
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) {
      t.skip(`Symlinks werden auf dieser Plattform nicht unterstützt: ${e.code}`);
      return false;
    }
    throw e;
  }
}

test('resolveWorkspacePath accepts paths inside workspace', () => {
  const svc = makeFsService();
  const root = '/tmp/project';
  assert.deepEqual(svc.resolveWorkspacePath(root, 'src/index.js'), {
    absPath: path.resolve(root, 'src/index.js'),
  });
  assert.deepEqual(svc.resolveWorkspacePath(root, ''), {
    absPath: path.resolve(root),
  });
});

test('resolveWorkspacePath rejects path traversal', () => {
  const svc = makeFsService();
  const root = '/tmp/project';
  assert.match(svc.resolveWorkspacePath(root, '../secret').error, /außerhalb/);
  assert.match(svc.resolveWorkspacePath(root, 'src/../../etc/passwd').error, /außerhalb/);
});

test('resolveWorkspacePath requires an open workspace', () => {
  const svc = makeFsService();
  assert.match(svc.resolveWorkspacePath(null, 'note.txt').error, /Arbeitsordner/);
  assert.match(svc.resolveWorkspacePath('', 'note.txt').error, /Arbeitsordner/);
});

test('assertAbsolutePathInWorkspace requires open workspace', () => {
  const svc = makeFsService();
  assert.match(svc.assertAbsolutePathInWorkspace(null, '/tmp/x').error, /Arbeitsordner/);
});

test('assertAbsolutePathInWorkspace validates absolute paths', () => {
  const svc = makeFsService();
  // path.resolve, damit der Test auch unter Windows (Laufwerksbuchstabe) absolut vergleicht.
  const root = path.resolve('/tmp/project');
  const inside = path.join(root, 'readme.md');
  assert.deepEqual(svc.assertAbsolutePathInWorkspace(root, inside), { absPath: inside });
  assert.match(
    svc.assertAbsolutePathInWorkspace(root, path.resolve('/etc/passwd')).error,
    /außerhalb/
  );
});

test('read_file_text respects workspace bounds through the registry', async () => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  const nested = path.join(tmpRoot, 'nested');
  await fs.mkdir(nested);
  await fs.writeFile(path.join(nested, 'note.txt'), 'hello', 'utf8');

  const ok = JSON.parse(
    await registry.execute('read_file_text', { relative_path: 'nested/note.txt' }, { workspaceRoot: tmpRoot })
  );
  assert.equal(ok.content, 'hello');

  const bad = JSON.parse(
    await registry.execute('read_file_text', { relative_path: '../outside.txt' }, { workspaceRoot: tmpRoot })
  );
  assert.match(bad.error, /außerhalb/);

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('read_file_text rejects a symlink to a file outside the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'secret', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    secret,
    path.join(workspace, 'secret-link.txt'),
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linked) return;

  const result = JSON.parse(
    await registry.execute(
      'read_file_text',
      { relative_path: 'secret-link.txt' },
      { workspaceRoot: workspace }
    )
  );

  assert.match(result.error, /außerhalb/);
  assert.equal(result.content, undefined);
});

test('list_directory rejects a symlink to a directory outside the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    outside,
    path.join(workspace, 'outside-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  if (!linked) return;

  const result = JSON.parse(
    await registry.execute(
      'list_directory',
      { relative_path: 'outside-link' },
      { workspaceRoot: workspace }
    )
  );

  assert.match(result.error, /außerhalb/);
  assert.equal(result.items, undefined);
});

test('list_directory lists directories before files and hides dotfiles', async () => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  await fs.mkdir(path.join(tmpRoot, 'docs'));
  await fs.writeFile(path.join(tmpRoot, 'readme.md'), 'hello', 'utf8');
  await fs.writeFile(path.join(tmpRoot, '.secret'), 'hidden', 'utf8');

  const out = JSON.parse(
    await registry.execute('list_directory', { relative_path: '.' }, { workspaceRoot: tmpRoot })
  );

  assert.deepEqual(out.items, [
    { name: 'docs', kind: 'directory' },
    { name: 'readme.md', kind: 'file' },
  ]);

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('debug_wait waits for the requested duration through the registry', async () => {
  const registry = makeToolRegistry();
  const started = Date.now();
  const out = JSON.parse(
    await registry.execute('debug_wait', { duration_seconds: 0.6 }, { workspaceRoot: '/tmp/project' })
  );
  const elapsed = Date.now() - started;
  assert.equal(out.ok, true);
  assert.equal(out.waited_ms, 600);
  assert.equal(out.waited_seconds, 0.6);
  assert.ok(elapsed >= 550);
});

test('write_file_text is disabled unless allowWrite is set', async () => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));

  const denied = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'note.txt', content: 'hi' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(denied.error, /Schreibzugriff ist deaktiviert/);
  await assert.rejects(fs.access(path.join(tmpRoot, 'note.txt')));

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('write_file_text creates new files and reports created:true', async () => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));

  const out = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'nested/new/note.txt', content: 'hello world' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.equal(out.created, true);
  assert.equal(out.overwritten, false);
  assert.equal(out.bytes_written, Buffer.byteLength('hello world', 'utf8'));
  const written = await fs.readFile(path.join(tmpRoot, 'nested/new/note.txt'), 'utf8');
  assert.equal(written, 'hello world');

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('write_file_text rejects writes through a symlinked parent outside the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const linked = await createSymlinkOrSkip(
    t,
    outside,
    path.join(workspace, 'outside-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  if (!linked) return;

  const result = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'outside-link/created.txt', content: 'must not escape' },
      { workspaceRoot: workspace, allowWrite: true }
    )
  );

  assert.match(result.error, /außerhalb/);
  await assert.rejects(fs.access(path.join(outside, 'created.txt')));
});

test('write_file_text rejects a dangling symlink instead of following it', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const missingTarget = path.join(outside, 'created.txt');
  const linked = await createSymlinkOrSkip(
    t,
    missingTarget,
    path.join(workspace, 'dangling-link.txt'),
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linked) return;

  const result = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'dangling-link.txt', content: 'must not escape' },
      { workspaceRoot: workspace, allowWrite: true }
    )
  );

  assert.ok(result.error);
  await assert.rejects(fs.access(missingTarget));
});

test('write_file_text overwrites existing files and reports overwritten:true', async () => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  await fs.writeFile(path.join(tmpRoot, 'existing.txt'), 'old', 'utf8');

  const out = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'existing.txt', content: 'new content' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.equal(out.created, false);
  assert.equal(out.overwritten, true);
  const written = await fs.readFile(path.join(tmpRoot, 'existing.txt'), 'utf8');
  assert.equal(written, 'new content');

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('write_file_text respects workspace bounds and rejects directory targets', async () => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  await fs.mkdir(path.join(tmpRoot, 'adir'));

  const outside = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: '../outside.txt', content: 'x' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.match(outside.error, /außerhalb/);

  const isDir = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'adir', content: 'x' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.match(isDir.error, /Ordner/);

  const workspaceRoot = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: '.', content: 'x' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.match(workspaceRoot.error, /Projektordner/);

  const missingContent = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'a.txt' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.match(missingContent.error, /content/);

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('write_file_text enforces the max content size', async () => {
  const svc = createFsService({ fs, path, maxReadFileBytes: 1024, maxWriteFileBytes: 10 });
  const registry = makeToolRegistry(svc);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));

  const out = JSON.parse(
    await registry.execute(
      'write_file_text',
      { relative_path: 'big.txt', content: 'this is definitely more than ten bytes' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.match(out.error, /zu groß/);
  await assert.rejects(fs.access(path.join(tmpRoot, 'big.txt')));

  await fs.rm(tmpRoot, { recursive: true, force: true });
});

test('search_in_files finds matches with line numbers and context through the registry', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(tmpRoot, 'a.txt'),
    'zeile eins\nzeile zwei\nTREFFER hier\nzeile vier\nzeile fünf',
    'utf8'
  );
  await fs.mkdir(path.join(tmpRoot, 'sub'));
  await fs.writeFile(path.join(tmpRoot, 'sub', 'b.txt'), 'auch ein treffer', 'utf8');

  const out = JSON.parse(
    await registry.execute('search_in_files', { query: 'treffer' }, { workspaceRoot: tmpRoot })
  );

  assert.equal(out.error, undefined);
  // Groß-/Kleinschreibung wird standardmäßig ignoriert; Dateien vor Unterordnern.
  assert.deepEqual(out.matches, [
    {
      file: 'a.txt',
      line: 3,
      text: 'TREFFER hier',
      before: ['zeile eins', 'zeile zwei'],
      after: ['zeile vier', 'zeile fünf'],
    },
    {
      file: 'sub/b.txt',
      line: 1,
      text: 'auch ein treffer',
      before: [],
      after: [],
    },
  ]);
  assert.equal(out.files_scanned, 2);
  assert.equal(out.truncated, false);
  assert.equal(out.scan_limit_reached, false);
});

test('search_in_files supports regex, case_sensitive and context_lines', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'foo1\nFOO2\nbar', 'utf8');

  const regex = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'foo\\d+', is_regex: true, case_sensitive: true, context_lines: 0 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(regex.matches, [
    { file: 'a.txt', line: 1, text: 'foo1', before: [], after: [] },
  ]);

  const literal = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'foo\\d+' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(literal.matches, []);
});

test('search_in_files rejects missing query and invalid regex', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const missing = JSON.parse(
    await registry.execute('search_in_files', {}, { workspaceRoot: tmpRoot })
  );
  assert.match(missing.error, /query/);

  const invalid = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: '(unclosed', is_regex: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(invalid.error, /regulärer Ausdruck/i);
});

test('search_in_files rejects a known ReDoS pattern before scanning any file', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  // Die Zeile ist absichtlich kurz: der Test darf nie vom Muster abhängen, sondern nur von der Vorprüfung.
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'aaaa', 'utf8');

  const rejected = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: '(a+)+!', is_regex: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(rejected.error, /zu komplex/);
  assert.equal(rejected.matches, undefined);

  const tooLong = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'a'.repeat(257), is_regex: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(tooLong.error, /zu lang/);

  // Wörtliche Suche nach demselben Text bleibt erlaubt — sie wird escaped und ist linear.
  const literal = JSON.parse(
    await registry.execute('search_in_files', { query: '(a+)+!' }, { workspaceRoot: tmpRoot })
  );
  assert.equal(literal.error, undefined);
  assert.deepEqual(literal.matches, []);
});

test('search_in_files aborts a slow regex when the worker time budget is exhausted', async (t) => {
  // Kleines Budget, damit der Test schnell bleibt; das Muster hat Sternhöhe 1 (passiert die
  // Vorprüfung), ist aber polynomiell langsam (O(n^4)) und liefe im Main-Thread minutenlang.
  const svc = createFsService({
    fs,
    path,
    maxReadFileBytes: 1024 * 1024,
    maxWriteFileBytes: 1024 * 1024,
    regexSearchTimeBudgetMs: 300,
  });
  const registry = createWorkspaceToolRegistry({ fsService: svc });
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'harmlos!', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'b.txt'), `${'a'.repeat(400)}\n`, 'utf8');

  const started = Date.now();
  const result = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'a*a*a*a*!', is_regex: true },
      { workspaceRoot: tmpRoot }
    )
  );
  const elapsed = Date.now() - started;
  assert.match(result.error, /zu langsam|Zeitbudget/);
  assert.equal(result.aborted, true);
  assert.deepEqual(result.matches, [{ file: 'a.txt', line: 1, text: 'harmlos!', before: [], after: [] }]);
  assert.ok(elapsed < 5000, `Abbruch dauerte ${elapsed} ms`);
});

test('search_in_files probes only the first 10000 characters of a line', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), `${'x'.repeat(10000)}treffer\ntreffer`, 'utf8');

  for (const args of [{ query: 'treffer' }, { query: 'tref+er', is_regex: true }]) {
    const result = JSON.parse(await registry.execute('search_in_files', args, { workspaceRoot: tmpRoot }));
    assert.deepEqual(
      result.matches.map((m) => m.line),
      [2],
      `Zeile 1 (Treffer jenseits der Prüfgrenze) darf nicht gefunden werden: ${JSON.stringify(args)}`
    );
  }
});

test('search_in_files respects workspace bounds', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const out = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'x', relative_path: '../outside' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(out.error, /außerhalb/);
});

test('search_in_files skips hidden entries by default, include_hidden enables them, .git stays excluded', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmpRoot, '.hidden'));
  await fs.writeFile(path.join(tmpRoot, '.hidden', 'h.txt'), 'geheimer treffer', 'utf8');
  await fs.mkdir(path.join(tmpRoot, '.git'));
  await fs.writeFile(path.join(tmpRoot, '.git', 'config'), 'git treffer', 'utf8');

  const withoutHidden = JSON.parse(
    await registry.execute('search_in_files', { query: 'treffer' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(withoutHidden.matches, []);

  const withHidden = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'treffer', include_hidden: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(
    withHidden.matches.map((m) => m.file),
    ['.hidden/h.txt']
  );
});

test('search_in_files respects the root .gitignore including negation', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(tmpRoot, '.gitignore'),
    '# Kommentar\nignored-dir/\n*.log\n!keep.log\n',
    'utf8'
  );
  await fs.mkdir(path.join(tmpRoot, 'ignored-dir'));
  await fs.writeFile(path.join(tmpRoot, 'ignored-dir', 'x.txt'), 'treffer', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'debug.log'), 'treffer', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'keep.log'), 'treffer', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'normal.txt'), 'treffer', 'utf8');

  const out = JSON.parse(
    await registry.execute('search_in_files', { query: 'treffer' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(
    out.matches.map((m) => m.file),
    ['keep.log', 'normal.txt']
  );
});

test('search_in_files skips binary and oversized files', async (t) => {
  const svc = createFsService({ fs, path, maxReadFileBytes: 64, maxWriteFileBytes: 64 });
  const registry = makeToolRegistry(svc);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'binary.bin'), Buffer.from('tref\0fer treffer'));
  await fs.writeFile(path.join(tmpRoot, 'big.txt'), `treffer ${'x'.repeat(100)}`, 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'small.txt'), 'treffer', 'utf8');

  const out = JSON.parse(
    await registry.execute('search_in_files', { query: 'treffer' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(
    out.matches.map((m) => m.file),
    ['small.txt']
  );
  assert.equal(out.files_scanned, 1);
});

test('search_in_files caps results at max_results and reports truncated', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(tmpRoot, 'a.txt'),
    Array.from({ length: 10 }, (_, i) => `treffer ${i}`).join('\n'),
    'utf8'
  );

  const out = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'treffer', max_results: 3 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(out.matches.length, 3);
  assert.equal(out.truncated, true);
});

test('search_in_files stops after the scan limit and reports it', async (t) => {
  const svc = createFsService({
    fs,
    path,
    maxReadFileBytes: 1024 * 1024,
    maxWriteFileBytes: 1024 * 1024,
    maxSearchScannedFiles: 1,
  });
  const registry = makeToolRegistry(svc);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'treffer', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'treffer', 'utf8');

  const out = JSON.parse(
    await registry.execute('search_in_files', { query: 'treffer' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(
    out.matches.map((m) => m.file),
    ['a.txt']
  );
  assert.equal(out.scan_limit_reached, true);
});

test('search_in_files applies include and exclude globs', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmpRoot, 'src'));
  await fs.mkdir(path.join(tmpRoot, 'dist'));
  await fs.writeFile(path.join(tmpRoot, 'src', 'a.js'), 'treffer', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'src', 'a.md'), 'treffer', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'dist', 'b.js'), 'treffer', 'utf8');

  const included = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'treffer', include: '*.js' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(
    included.matches.map((m) => m.file),
    ['dist/b.js', 'src/a.js']
  );

  const excluded = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'treffer', include: '*.js', exclude: 'dist' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(
    excluded.matches.map((m) => m.file),
    ['src/a.js']
  );
});

test('search_in_files searches a single file when relative_path is a file', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'treffer', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'treffer', 'utf8');

  const out = JSON.parse(
    await registry.execute(
      'search_in_files',
      { query: 'treffer', relative_path: 'a.txt' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(
    out.matches.map((m) => m.file),
    ['a.txt']
  );
});

test('search_in_files does not follow symlinks out of the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'geheimer treffer', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    outside,
    path.join(workspace, 'outside-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  if (!linked) return;

  const out = JSON.parse(
    await registry.execute('search_in_files', { query: 'treffer' }, { workspaceRoot: workspace })
  );
  assert.deepEqual(out.matches, []);
});

test('find_files finds paths recursively by glob through the registry', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'x', 'utf8');
  await fs.mkdir(path.join(tmpRoot, 'sub'));
  await fs.writeFile(path.join(tmpRoot, 'sub', 'b.txt'), 'x', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'sub', 'c.md'), 'x', 'utf8');

  const out = JSON.parse(
    await registry.execute('find_files', { pattern: '*.txt' }, { workspaceRoot: tmpRoot })
  );

  assert.equal(out.error, undefined);
  // Muster ohne / matchen auf jeder Ebene; Dateien vor Unterordnern.
  assert.deepEqual(out.results, [
    { path: 'a.txt', kind: 'file' },
    { path: 'sub/b.txt', kind: 'file' },
  ]);
  assert.equal(out.truncated, false);
  assert.equal(out.scan_limit_reached, false);

  const anchored = JSON.parse(
    await registry.execute('find_files', { pattern: 'sub/*.md' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(anchored.results, [{ path: 'sub/c.md', kind: 'file' }]);
});

test('find_files matches directories and honors trailing-slash patterns', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmpRoot, 'sub'));
  await fs.writeFile(path.join(tmpRoot, 'sub.txt'), 'x', 'utf8');

  const dirOnly = JSON.parse(
    await registry.execute('find_files', { pattern: 'sub/' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(dirOnly.results, [{ path: 'sub', kind: 'directory' }]);

  const both = JSON.parse(
    await registry.execute('find_files', { pattern: 'sub*' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(both.results, [
    { path: 'sub.txt', kind: 'file' },
    { path: 'sub', kind: 'directory' },
  ]);
});

test('find_files rejects a missing pattern and a file as start path', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'x', 'utf8');

  const missing = JSON.parse(
    await registry.execute('find_files', {}, { workspaceRoot: tmpRoot })
  );
  assert.match(missing.error, /pattern/);

  const notDir = JSON.parse(
    await registry.execute(
      'find_files',
      { pattern: '*', relative_path: 'a.txt' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(notDir.error, /kein Ordner/);
});

test('find_files respects workspace bounds', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const out = JSON.parse(
    await registry.execute(
      'find_files',
      { pattern: '*', relative_path: '../outside' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(out.error, /außerhalb/);
});

test('find_files skips hidden entries by default, include_hidden enables them, .git stays excluded', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmpRoot, '.hidden'));
  await fs.writeFile(path.join(tmpRoot, '.hidden', 'h.txt'), 'x', 'utf8');
  await fs.mkdir(path.join(tmpRoot, '.git'));
  await fs.writeFile(path.join(tmpRoot, '.git', 'config'), 'x', 'utf8');

  const withoutHidden = JSON.parse(
    await registry.execute('find_files', { pattern: '**' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(withoutHidden.results, []);

  const withHidden = JSON.parse(
    await registry.execute(
      'find_files',
      { pattern: '**', include_hidden: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(
    withHidden.results.map((r) => r.path),
    ['.hidden', '.hidden/h.txt']
  );
});

test('find_files respects the root .gitignore including negation', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(tmpRoot, '.gitignore'),
    '# Kommentar\nignored-dir/\n*.log\n!keep.log\n',
    'utf8'
  );
  await fs.mkdir(path.join(tmpRoot, 'ignored-dir'));
  await fs.writeFile(path.join(tmpRoot, 'ignored-dir', 'x.txt'), 'x', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'debug.log'), 'x', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'keep.log'), 'x', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'normal.txt'), 'x', 'utf8');

  const out = JSON.parse(
    await registry.execute('find_files', { pattern: '**' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(
    out.results.map((r) => r.path),
    ['keep.log', 'normal.txt']
  );
});

test('find_files caps results at max_results and reports truncated', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  for (let i = 0; i < 10; i++) {
    await fs.writeFile(path.join(tmpRoot, `f${i}.txt`), 'x', 'utf8');
  }

  const out = JSON.parse(
    await registry.execute(
      'find_files',
      { pattern: '*.txt', max_results: 3 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(out.results.length, 3);
  assert.equal(out.truncated, true);
});

test('find_files stops after the scan limit and reports it', async (t) => {
  const svc = createFsService({
    fs,
    path,
    maxReadFileBytes: 1024 * 1024,
    maxWriteFileBytes: 1024 * 1024,
    maxSearchScannedFiles: 1,
  });
  const registry = makeToolRegistry(svc);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'x', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'x', 'utf8');

  const out = JSON.parse(
    await registry.execute('find_files', { pattern: '*.txt' }, { workspaceRoot: tmpRoot })
  );
  assert.deepEqual(
    out.results.map((r) => r.path),
    ['a.txt']
  );
  assert.equal(out.scan_limit_reached, true);
});

test('find_files searches only below the given start folder', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmpRoot, 'src'));
  await fs.mkdir(path.join(tmpRoot, 'dist'));
  await fs.writeFile(path.join(tmpRoot, 'src', 'a.js'), 'x', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'dist', 'b.js'), 'x', 'utf8');

  const out = JSON.parse(
    await registry.execute(
      'find_files',
      { pattern: '*.js', relative_path: 'src' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(out.results, [{ path: 'src/a.js', kind: 'file' }]);
});

test('find_files does not follow symlinks out of the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'x', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    outside,
    path.join(workspace, 'outside-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  if (!linked) return;

  const out = JSON.parse(
    await registry.execute('find_files', { pattern: '**' }, { workspaceRoot: workspace })
  );
  assert.deepEqual(out.results, []);
});

test('stat_path returns file metadata without content through the registry', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'eins\nzwei\n', 'utf8');

  const out = JSON.parse(
    await registry.execute('stat_path', { relative_path: 'a.txt' }, { workspaceRoot: tmpRoot })
  );

  assert.equal(out.error, undefined);
  assert.equal(out.exists, true);
  assert.equal(out.kind, 'file');
  assert.equal(out.size_bytes, 10);
  assert.equal(new Date(out.modified).toISOString(), out.modified);
  assert.equal(out.content, undefined);
  // Zeilenzahl nur auf Wunsch — Standard bleibt der reine Metadaten-Blick.
  assert.equal(out.line_count, undefined);
});

test('stat_path reports directories without size and counts lines on request', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.mkdir(path.join(tmpRoot, 'sub'));
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'eins\nzwei\n', 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'leer.txt'), '', 'utf8');

  const dir = JSON.parse(
    await registry.execute(
      'stat_path',
      { relative_path: 'sub', include_line_count: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(dir.exists, true);
  assert.equal(dir.kind, 'directory');
  assert.equal(dir.size_bytes, undefined);
  assert.equal(dir.line_count, undefined);

  const file = JSON.parse(
    await registry.execute(
      'stat_path',
      { relative_path: 'a.txt', include_line_count: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(file.line_count, 2);

  const empty = JSON.parse(
    await registry.execute(
      'stat_path',
      { relative_path: 'leer.txt', include_line_count: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(empty.line_count, 0);

  const root = JSON.parse(
    await registry.execute('stat_path', { relative_path: '.' }, { workspaceRoot: tmpRoot })
  );
  assert.equal(root.kind, 'directory');
});

test('stat_path reports missing paths as exists=false instead of an error', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const out = JSON.parse(
    await registry.execute(
      'stat_path',
      { relative_path: 'fehlt/nicht-da.txt' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.deepEqual(out, { relative_path: 'fehlt/nicht-da.txt', exists: false });
});

test('stat_path requires relative_path and respects workspace bounds', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));

  const missing = JSON.parse(
    await registry.execute('stat_path', {}, { workspaceRoot: tmpRoot })
  );
  assert.match(missing.error, /relative_path/);

  const outside = JSON.parse(
    await registry.execute(
      'stat_path',
      { relative_path: '../outside.txt' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(outside.error, /außerhalb/);
});

test('stat_path rejects a symlink to a file outside the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'secret', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    secret,
    path.join(workspace, 'secret-link.txt'),
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linked) return;

  const out = JSON.parse(
    await registry.execute(
      'stat_path',
      { relative_path: 'secret-link.txt' },
      { workspaceRoot: workspace }
    )
  );
  assert.match(out.error, /außerhalb/);
  assert.equal(out.exists, undefined);
});

test('stat_path skips the line count for binary and oversized files', async (t) => {
  const svc = createFsService({
    fs,
    path,
    maxReadFileBytes: 8,
    maxWriteFileBytes: 1024,
  });
  const registry = makeToolRegistry(svc);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42]));
  await fs.writeFile(path.join(tmpRoot, 'gross.txt'), 'mehr als acht Bytes\n', 'utf8');

  const binary = JSON.parse(
    await registry.execute(
      'stat_path',
      { relative_path: 'binary.bin', include_line_count: true },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(binary.exists, true);
  assert.equal(binary.line_count, undefined);
  assert.match(binary.line_count_skipped, /Binärdatei/);

  const oversized = JSON.parse(
    await registry.execute(
      'stat_path',
      { relative_path: 'gross.txt', include_line_count: true },
      { workspaceRoot: tmpRoot }
    )
  );
  // Metadaten kommen trotzdem — nur die Zählung entfällt, statt wie beim Lesen zu scheitern.
  assert.equal(oversized.exists, true);
  assert.equal(oversized.size_bytes, 20);
  assert.equal(oversized.line_count, undefined);
  assert.match(oversized.line_count_skipped, /zu groß/);
});

async function makeOutlineFixture(t, files) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  for (const [name, lines] of Object.entries(files)) {
    await fs.writeFile(path.join(tmpRoot, name), lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  }
  return tmpRoot;
}

async function outlineOf(registry, tmpRoot, args) {
  return JSON.parse(await registry.execute('outline_file', args, { workspaceRoot: tmpRoot }));
}

test('outline_file returns markdown headings with line numbers through the registry', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeOutlineFixture(t, {
    'doc.md': [
      '---', // 1: Front-Matter
      'title: Test',
      '---',
      '# Titel', // 4
      'Text.',
      '## Abschnitt A ##', // 6: schließende Rauten
      '```bash',
      '# kein Heading', // 8: im Code-Fence
      '```',
      'Setext Eins', // 10
      '===',
      '### Tief', // 12
      'Setext Zwei', // 13
      '---',
      '',
      '---', // 16: Trennlinie nach Leerzeile
      '#hashtag', // 17: kein Leerzeichen → keine Überschrift
      '- Liste',
      '---', // 19: nach Listenzeile
    ],
  });

  const out = await outlineOf(registry, tmpRoot, { relative_path: 'doc.md' });

  assert.equal(out.error, undefined);
  assert.equal(out.format, 'markdown');
  assert.equal(out.line_count, 19);
  assert.equal(out.total_entries, 5);
  assert.equal(out.truncated, false);
  assert.equal(out.content, undefined);
  assert.deepEqual(out.entries, [
    { line: 4, level: 1, kind: 'heading', text: 'Titel' },
    { line: 6, level: 2, kind: 'heading', text: 'Abschnitt A' },
    { line: 10, level: 1, kind: 'heading', text: 'Setext Eins' },
    { line: 12, level: 3, kind: 'heading', text: 'Tief' },
    { line: 13, level: 2, kind: 'heading', text: 'Setext Zwei' },
  ]);
});

test('outline_file extracts JavaScript and Python signatures with nesting levels', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeOutlineFixture(t, {
    'app.js': [
      'import fs from "fs";',
      'export function outer(a, b) {', // 2
      '  if (a) {',
      '    return foo(bar);',
      '  }',
      '}',
      'const arrow = async (x) => {', // 7
      '  return x;',
      '};',
      'export default class Widget extends Base {', // 10
      '  constructor(props) {', // 11
      '    super(props);',
      '  }',
      '  static async load(id) {', // 14
      '    while (id) {',
      '    }',
      '  }',
      '  get value() {', // 18
      '    return 1;',
      '  }',
      '}',
      'export default defineConfig({',
      'describe("x", () => {',
      'module.exports = { outer };',
    ],
    'main.py': [
      'class Greeter(Base):', // 1
      '    def __init__(self):', // 2
      '        self.x = 1',
      '    async def run(self):', // 4
      '        pass',
      'def main():', // 6
      '    print("hi")',
    ],
  });

  const js = await outlineOf(registry, tmpRoot, { relative_path: 'app.js' });
  assert.equal(js.format, 'code');
  assert.deepEqual(
    js.entries.map((e) => [e.line, e.level, e.kind, e.name]),
    [
      [2, 1, 'function', 'outer'],
      [7, 1, 'function', 'arrow'],
      [10, 1, 'class', 'Widget'],
      [11, 2, 'function', 'constructor'],
      [14, 2, 'function', 'load'],
      [18, 2, 'function', 'value'],
    ]
  );
  // Signaturtext ohne öffnende Klammer am Zeilenende.
  assert.equal(js.entries[0].text, 'export function outer(a, b)');
  assert.equal(js.entries[2].text, 'export default class Widget extends Base');

  const py = await outlineOf(registry, tmpRoot, { relative_path: 'main.py' });
  assert.deepEqual(
    py.entries.map((e) => [e.line, e.level, e.kind, e.name]),
    [
      [1, 1, 'class', 'Greeter'],
      [2, 2, 'function', '__init__'],
      [4, 2, 'function', 'run'],
      [6, 1, 'function', 'main'],
    ]
  );
  assert.equal(py.entries[1].text, 'def __init__(self):');
});

test('outline_file recognizes generic signatures across languages', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeOutlineFixture(t, {
    'main.go': [
      'package main',
      'type Server struct {',
      'func (s *Server) Start() error {',
      'func main() {',
      '\tgo func() {',
    ],
    'lib.rs': [
      'pub struct Config {',
      'impl Config {',
      '    pub fn new() -> Self {',
      '        let x = build();',
      'mod tests {',
    ],
    'App.java': [
      'public class App {',
      '    private static final Logger LOG = LoggerFactory.getLogger(App.class);',
      '    public static void main(String[] args) {',
      '        } else if (args.length > 0) {',
      '    public App(int x) {',
      '    public String name() { return name; }',
    ],
    'util.c': [
      '#include <stdio.h>',
      'static int helper(int a) {',
      'int main(void) {',
      '    return helper(1);',
      'char *dup(const char *s) {',
    ],
    'run.sh': ['#!/bin/sh', 'usage() {', 'if [ -z "$1" ]; then', 'main "$@"'],
  });

  const pick = (out) => out.entries.map((e) => [e.line, e.level, e.kind, e.name]);
  assert.deepEqual(pick(await outlineOf(registry, tmpRoot, { relative_path: 'main.go' })), [
    [2, 1, 'type', 'Server'],
    [3, 1, 'function', 'Start'],
    [4, 1, 'function', 'main'],
  ]);
  const rs = await outlineOf(registry, tmpRoot, { relative_path: 'lib.rs' });
  assert.deepEqual(pick(rs), [
    [1, 1, 'struct', 'Config'],
    [2, 1, 'impl', undefined],
    [3, 2, 'function', 'new'],
    [5, 1, 'mod', 'tests'],
  ]);
  assert.equal(rs.entries[1].text, 'impl Config');
  assert.deepEqual(pick(await outlineOf(registry, tmpRoot, { relative_path: 'App.java' })), [
    [1, 1, 'class', 'App'],
    [3, 2, 'function', 'main'],
    [5, 2, 'function', 'App'],
    [6, 2, 'function', 'name'],
  ]);
  assert.deepEqual(pick(await outlineOf(registry, tmpRoot, { relative_path: 'util.c' })), [
    [2, 1, 'function', 'helper'],
    [3, 1, 'function', 'main'],
    [5, 1, 'function', 'dup'],
  ]);
  assert.deepEqual(pick(await outlineOf(registry, tmpRoot, { relative_path: 'run.sh' })), [
    [2, 1, 'function', 'usage'],
  ]);
});

test('outline_file honors max_depth and max_entries and reports truncation', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeOutlineFixture(t, {
    'doc.md': ['# A', '## A1', '### A1a', '# B', '## B1'],
  });

  const shallow = await outlineOf(registry, tmpRoot, { relative_path: 'doc.md', max_depth: 1 });
  assert.deepEqual(
    shallow.entries.map((e) => e.text),
    ['A', 'B']
  );
  assert.equal(shallow.total_entries, 2);
  assert.equal(shallow.truncated, false);

  const capped = await outlineOf(registry, tmpRoot, { relative_path: 'doc.md', max_entries: 2 });
  assert.equal(capped.entries.length, 2);
  assert.equal(capped.total_entries, 5);
  assert.equal(capped.truncated, true);

  const both = await outlineOf(registry, tmpRoot, {
    relative_path: 'doc.md',
    max_depth: 2,
    max_entries: 3,
  });
  assert.deepEqual(
    both.entries.map((e) => e.text),
    ['A', 'A1', 'B']
  );
  assert.equal(both.total_entries, 4);
  assert.equal(both.truncated, true);
});

test('outline_file reports files without structure with an empty list and a hint', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeOutlineFixture(t, {
    'notes.txt': ['Nur Fließtext.', 'Noch eine Zeile (mit Klammern).'],
    'leer.md': [],
  });

  const txt = await outlineOf(registry, tmpRoot, { relative_path: 'notes.txt' });
  assert.equal(txt.error, undefined);
  assert.deepEqual(txt.entries, []);
  assert.equal(txt.total_entries, 0);
  assert.match(txt.hint, /Keine Signaturen/);

  const md = await outlineOf(registry, tmpRoot, { relative_path: 'leer.md' });
  assert.equal(md.line_count, 0);
  assert.deepEqual(md.entries, []);
  assert.match(md.hint, /Keine Überschriften/);
});

test('outline_file validates arguments and respects workspace bounds', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeOutlineFixture(t, { 'a.md': ['# A'] });
  await fs.mkdir(path.join(tmpRoot, 'sub'));

  assert.match((await outlineOf(registry, tmpRoot, {})).error, /relative_path/);
  assert.match((await outlineOf(registry, tmpRoot, { relative_path: 'sub' })).error, /Ordner/);
  assert.match(
    (await outlineOf(registry, tmpRoot, { relative_path: '../outside.md' })).error,
    /außerhalb/
  );
  assert.match(
    (await outlineOf(registry, tmpRoot, { relative_path: 'a.md', max_depth: 0 })).error,
    /max_depth/
  );
  assert.match(
    (await outlineOf(registry, tmpRoot, { relative_path: 'a.md', max_depth: 'x' })).error,
    /Ganzzahl/
  );
  assert.match(
    (await outlineOf(registry, tmpRoot, { relative_path: 'fehlt.md' })).error,
    /ENOENT|no such file/i
  );
});

test('outline_file rejects binary and oversized files', async (t) => {
  const svc = createFsService({
    fs,
    path,
    maxReadFileBytes: 8,
    maxWriteFileBytes: 1024,
  });
  const registry = makeToolRegistry(svc);
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'bin.md'), Buffer.from([0x23, 0x00, 0x42]));
  await fs.writeFile(path.join(tmpRoot, 'gross.md'), '# mehr als acht Bytes\n', 'utf8');

  assert.match((await outlineOf(registry, tmpRoot, { relative_path: 'bin.md' })).error, /Binärdatei/);
  assert.match((await outlineOf(registry, tmpRoot, { relative_path: 'gross.md' })).error, /zu groß/);
});

test('outline_file rejects a symlink to a file outside the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const secret = path.join(outside, 'secret.md');
  await fs.writeFile(secret, '# Geheim\n', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    secret,
    path.join(workspace, 'secret-link.md'),
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linked) return;

  const out = await outlineOf(registry, workspace, { relative_path: 'secret-link.md' });
  assert.match(out.error, /außerhalb/);
  assert.equal(out.entries, undefined);
});

async function makeTreeFixture(t) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const dirs = ['src/main/deep', 'src/shared', 'docs', 'empty', '.hidden', '.git', 'node_modules'];
  for (const dir of dirs) await fs.mkdir(path.join(tmpRoot, dir), { recursive: true });
  const files = {
    'README.md': '# x',
    'package.json': '{}',
    '.gitignore': 'node_modules/\n',
    'src/main/app.js': 'x',
    'src/main/deep/x.js': 'x',
    'src/shared/util.js': 'x',
    'docs/guide.md': 'x',
    '.hidden/h.txt': 'x',
    '.git/config': 'x',
    'node_modules/mod.js': 'x',
  };
  for (const [rel, content] of Object.entries(files)) {
    await fs.writeFile(path.join(tmpRoot, rel), content, 'utf8');
  }
  return tmpRoot;
}

async function treeOf(registry, tmpRoot, args = {}) {
  return JSON.parse(
    await registry.execute('list_directory_tree', args, { workspaceRoot: tmpRoot })
  );
}

test('list_directory_tree renders a compact tree with directories first through the registry', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeTreeFixture(t);

  const out = await treeOf(registry, tmpRoot);

  assert.equal(out.error, undefined);
  assert.equal(out.relative_path, '.');
  assert.equal(out.max_depth, 3);
  assert.equal(out.entries_shown, 11);
  assert.equal(out.entries_hidden, 1);
  assert.equal(out.truncated, false);
  assert.equal(
    out.tree,
    [
      './',
      '  docs/',
      '    guide.md',
      '  empty/',
      '  src/',
      '    main/',
      '      deep/ [+1]',
      '      app.js',
      '    shared/',
      '      util.js',
      '  package.json',
      '  README.md',
    ].join('\n')
  );
});

test('list_directory_tree collapses deeper folders with [+N] according to max_depth', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeTreeFixture(t);

  const shallow = await treeOf(registry, tmpRoot, { max_depth: 1 });
  assert.equal(shallow.entries_shown, 5);
  assert.equal(shallow.entries_hidden, 3);
  assert.equal(shallow.truncated, false);
  assert.equal(
    shallow.tree,
    ['./', '  docs/ [+1]', '  empty/', '  src/ [+2]', '  package.json', '  README.md'].join('\n')
  );

  const sub = await treeOf(registry, tmpRoot, { relative_path: 'src', max_depth: 1 });
  assert.equal(sub.relative_path, 'src');
  assert.equal(sub.tree, ['src/', '  main/ [+2]', '  shared/ [+1]'].join('\n'));

  // Obergrenze für max_depth wird stillschweigend angewendet.
  const deep = await treeOf(registry, tmpRoot, { max_depth: 99 });
  assert.equal(deep.max_depth, 10);
  assert.equal(deep.entries_hidden, 0);
  assert.match(deep.tree, /\n {8}x\.js$/m);
});

test('list_directory_tree spends max_entries breadth-first and reports truncation', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeTreeFixture(t);

  const out = await treeOf(registry, tmpRoot, { max_entries: 3 });

  assert.equal(out.entries_shown, 3);
  assert.equal(out.entries_hidden, 3);
  assert.equal(out.truncated, true);
  // Oberste Ebene zuerst (Dateien vor Ordnern), tiefere Ebenen nur noch als Zähler.
  assert.equal(out.tree, ['./ [+2]', '  docs/ [+1]', '  package.json', '  README.md'].join('\n'));
});

test('list_directory_tree skips hidden entries, .gitignore matches and .git; include_hidden shows dotfiles', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeTreeFixture(t);

  const plain = await treeOf(registry, tmpRoot);
  const plainLines = plain.tree.split('\n');
  assert.ok(!plainLines.includes('  .hidden/'));
  assert.ok(!plainLines.includes('  .gitignore'));
  assert.ok(!plain.tree.includes('node_modules'));

  const hidden = await treeOf(registry, tmpRoot, { include_hidden: true });
  const lines = hidden.tree.split('\n');
  assert.ok(lines.includes('  .hidden/'));
  assert.ok(lines.includes('    h.txt'));
  assert.ok(lines.includes('  .gitignore'));
  assert.ok(!lines.includes('  .git/'));
  assert.ok(!hidden.tree.includes('node_modules'));
});

test('list_directory_tree validates arguments and respects workspace bounds', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeTreeFixture(t);

  assert.match((await treeOf(registry, tmpRoot, { relative_path: 'README.md' })).error, /kein Ordner/);
  assert.match((await treeOf(registry, tmpRoot, { relative_path: '../x' })).error, /außerhalb/);
  assert.match((await treeOf(registry, tmpRoot, { max_depth: 0 })).error, /max_depth/);
  assert.match((await treeOf(registry, tmpRoot, { max_depth: 'x' })).error, /Ganzzahl/);
  assert.match((await treeOf(registry, tmpRoot, { relative_path: 'fehlt' })).error, /ENOENT|no such file/i);
});

test('list_directory_tree does not follow symlinks out of the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'x', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    outside,
    path.join(workspace, 'outside-link'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  if (!linked) return;

  const out = await treeOf(registry, workspace);
  assert.equal(out.tree, './');
  assert.equal(out.entries_shown, 0);
});

async function makeLinesFixture(t, lineCount = 10) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const lines = Array.from({ length: lineCount }, (_, i) => `zeile ${i + 1}`);
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), `${lines.join('\n')}\n`, 'utf8');
  return tmpRoot;
}

test('read_file_lines returns a numbered line range through the registry', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeLinesFixture(t);

  const out = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'a.txt', start_line: 3, end_line: 5 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(out.content, '3\tzeile 3\n4\tzeile 4\n5\tzeile 5');
  assert.equal(out.start_line, 3);
  assert.equal(out.end_line, 5);
  assert.equal(out.total_lines, 10);
  assert.equal(out.truncated, false);
});

test('read_file_lines defaults to the file start and clamps end_line at EOF', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeLinesFixture(t);
  await fs.writeFile(path.join(tmpRoot, 'leer.txt'), '', 'utf8');

  const all = JSON.parse(
    await registry.execute('read_file_lines', { relative_path: 'a.txt' }, { workspaceRoot: tmpRoot })
  );
  assert.equal(all.start_line, 1);
  assert.equal(all.end_line, 10);
  assert.equal(all.truncated, false);
  assert.match(all.content, /^1\tzeile 1\n/);

  const clamped = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'a.txt', start_line: 8, end_line: 99 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(clamped.end_line, 10);
  assert.equal(clamped.truncated, false);

  const empty = JSON.parse(
    await registry.execute('read_file_lines', { relative_path: 'leer.txt' }, { workspaceRoot: tmpRoot })
  );
  assert.equal(empty.total_lines, 0);
  assert.equal(empty.content, '');
});

test('read_file_lines validates range parameters', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeLinesFixture(t);
  const run = async (args) =>
    JSON.parse(await registry.execute('read_file_lines', { relative_path: 'a.txt', ...args }, { workspaceRoot: tmpRoot }));

  assert.match((await run({ start_line: 0 })).error, /start_line/);
  assert.match((await run({ start_line: 5, end_line: 3 })).error, /end_line/);
  assert.match((await run({ start_line: '3' })).error, /Ganzzahl/);
  assert.match((await run({ start_line: 42 })).error, /hinter dem Dateiende.*10 Zeilen/);
  assert.match((await run({ start_line: 1, start_byte: 0 })).error, /nicht beides/);
  const noPath = JSON.parse(await registry.execute('read_file_lines', {}, { workspaceRoot: tmpRoot }));
  assert.match(noPath.error, /relative_path/);
});

test('read_file_lines reads a byte range and reports the first line', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'b.txt'), 'abc\ndef\nghi\n', 'utf8');

  const out = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'b.txt', start_byte: 4, length: 3 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(out.content, 'def');
  assert.equal(out.first_line, 2);
  assert.equal(out.length, 3);
  assert.equal(out.size_bytes, 12);
  assert.equal(out.truncated, false);

  const tail = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'b.txt', start_byte: 8 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(tail.content, 'ghi\n');
  assert.equal(tail.first_line, 3);

  const beyond = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'b.txt', start_byte: 100 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(beyond.error, /hinter dem Dateiende.*12 Bytes/);
});

test('read_file_lines respects workspace bounds and rejects directories', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeLinesFixture(t);

  const outside = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: '../outside.txt', start_line: 1 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(outside.error, /außerhalb/);

  const dir = JSON.parse(
    await registry.execute('read_file_lines', { relative_path: '.' }, { workspaceRoot: tmpRoot })
  );
  assert.match(dir.error, /Ordner/);
});

test('read_file_lines rejects a symlink to a file outside the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'geheim\n', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    secret,
    path.join(workspace, 'secret-link.txt'),
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linked) return;

  const result = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'secret-link.txt', start_line: 1 },
      { workspaceRoot: workspace }
    )
  );
  assert.match(result.error, /außerhalb/);
  assert.equal(result.content, undefined);
});

test('read_file_lines rejects oversized files and enforces the slice budget', async (t) => {
  const smallRead = createFsService({ fs, path, maxReadFileBytes: 16 });
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'gross.txt'), 'x'.repeat(32), 'utf8');
  const tooBig = JSON.parse(
    await createWorkspaceToolRegistry({ fsService: smallRead }).execute(
      'read_file_lines',
      { relative_path: 'gross.txt' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(tooBig.error, /zu groß/);

  const smallSlice = createFsService({
    fs,
    path,
    maxReadFileBytes: 1024 * 1024,
    maxReadSliceChars: 20,
  });
  const registry = createWorkspaceToolRegistry({ fsService: smallSlice });
  await fs.writeFile(path.join(tmpRoot, 'a.txt'), 'zeile 1\nzeile 2\nzeile 3\n', 'utf8');
  const budgeted = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'a.txt', start_line: 1, end_line: 3 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(budgeted.content, '1\tzeile 1\n2\tzeile 2');
  assert.equal(budgeted.end_line, 2);
  assert.equal(budgeted.truncated, true);

  const byteBudget = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'a.txt', start_byte: 0, length: 999 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(byteBudget.length, 20);
  assert.equal(byteBudget.truncated, true);
});

test('read_file_lines caps the line span per call', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeLinesFixture(t, 1200);

  const out = JSON.parse(
    await registry.execute(
      'read_file_lines',
      { relative_path: 'a.txt', start_line: 1, end_line: 1200 },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.equal(out.end_line, 1000);
  assert.equal(out.total_lines, 1200);
  assert.equal(out.truncated, true);
});

async function makeEditFixture(t, content = 'const a = 1;\nconst b = 2;\nconst c = 3;\n') {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'a.js'), content, 'utf8');
  return tmpRoot;
}

test('edit_file replaces a unique string through the registry', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeEditFixture(t);

  const out = JSON.parse(
    await registry.execute(
      'edit_file',
      { relative_path: 'a.js', old_string: 'const b = 2;', new_string: 'const b = 42;' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.equal(out.replacements, 1);
  assert.equal(out.first_changed_line, 2);
  assert.equal(out.error, undefined);
  const content = await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8');
  assert.equal(content, 'const a = 1;\nconst b = 42;\nconst c = 3;\n');
});

test('edit_file is disabled unless allowWrite is set', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeEditFixture(t);

  const out = JSON.parse(
    await registry.execute(
      'edit_file',
      { relative_path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 9;' },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(out.error, /Schreibzugriff/);
  const content = await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8');
  assert.match(content, /const a = 1;/);
});

test('edit_file rejects missing and ambiguous matches without changing the file', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeEditFixture(t, 'foo\nbar\nfoo\n');
  const run = async (args) =>
    JSON.parse(
      await registry.execute('edit_file', { relative_path: 'a.js', ...args }, { workspaceRoot: tmpRoot, allowWrite: true })
    );

  assert.match((await run({ old_string: 'gibtEsNicht', new_string: 'x' })).error, /nicht gefunden/);
  assert.match((await run({ old_string: 'foo', new_string: 'baz' })).error, /nicht eindeutig \(2 Treffer\)/);
  const content = await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8');
  assert.equal(content, 'foo\nbar\nfoo\n');
});

test('edit_file replaces all occurrences with replace_all', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeEditFixture(t, 'foo\nbar\nfoo\n');

  const out = JSON.parse(
    await registry.execute(
      'edit_file',
      { relative_path: 'a.js', old_string: 'foo', new_string: 'foofoo', replace_all: true },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.equal(out.replacements, 2);
  assert.equal(out.first_changed_line, 1);
  const content = await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8');
  assert.equal(content, 'foofoo\nbar\nfoofoo\n');
});

test('edit_file validates parameters and supports deletion via empty new_string', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeEditFixture(t, 'eins zwei drei\n');
  const run = async (args) =>
    JSON.parse(
      await registry.execute('edit_file', { relative_path: 'a.js', ...args }, { workspaceRoot: tmpRoot, allowWrite: true })
    );

  assert.match((await run({ new_string: 'x' })).error, /old_string/);
  assert.match((await run({ old_string: '', new_string: 'x' })).error, /old_string/);
  assert.match((await run({ old_string: 'eins' })).error, /new_string/);
  assert.match((await run({ old_string: 'eins', new_string: 'eins' })).error, /unterscheiden/);

  const deleted = await run({ old_string: ' zwei', new_string: '' });
  assert.equal(deleted.replacements, 1);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'eins drei\n');
});

test('edit_file respects workspace bounds and rejects directories', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makeEditFixture(t);
  const run = async (args) =>
    JSON.parse(
      await registry.execute('edit_file', { old_string: 'a', new_string: 'b', ...args }, { workspaceRoot: tmpRoot, allowWrite: true })
    );

  assert.match((await run({ relative_path: '../outside.js' })).error, /außerhalb/);
  assert.match((await run({ relative_path: '.' })).error, /Ordner/);
});

test('edit_file rejects a symlink to a file outside the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'geheim\n', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    secret,
    path.join(workspace, 'secret-link.txt'),
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linked) return;

  const result = JSON.parse(
    await registry.execute(
      'edit_file',
      { relative_path: 'secret-link.txt', old_string: 'geheim', new_string: 'offen' },
      { workspaceRoot: workspace, allowWrite: true }
    )
  );
  assert.match(result.error, /außerhalb/);
  assert.equal(await fs.readFile(secret, 'utf8'), 'geheim\n');
});

test('edit_file enforces read and write size limits', async (t) => {
  const svc = createFsService({ fs, path, maxReadFileBytes: 1024, maxWriteFileBytes: 16 });
  const registry = createWorkspaceToolRegistry({ fsService: svc });
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'gross.txt'), 'x'.repeat(2048), 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'klein.txt'), 'kurz\n', 'utf8');

  const tooBigToRead = JSON.parse(
    await registry.execute(
      'edit_file',
      { relative_path: 'gross.txt', old_string: 'x', new_string: 'y' },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.match(tooBigToRead.error, /Datei zu groß/);

  const tooBigToWrite = JSON.parse(
    await registry.execute(
      'edit_file',
      { relative_path: 'klein.txt', old_string: 'kurz', new_string: 'k'.repeat(64) },
      { workspaceRoot: tmpRoot, allowWrite: true }
    )
  );
  assert.match(tooBigToWrite.error, /Inhalt zu groß/);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'klein.txt'), 'utf8'), 'kurz\n');
});

async function makePatchFixture(t, files) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(tmpRoot, name), content, 'utf8');
  }
  return tmpRoot;
}

function makePatchRunner(tmpRoot, registry = makeToolRegistry()) {
  return async (args) =>
    JSON.parse(
      await registry.execute('apply_patch', args, { workspaceRoot: tmpRoot, allowWrite: true })
    );
}

/** Baut einen unified diff aus Zeilen — mit abschließendem Umbruch wie echte Werkzeuge. */
function diff(...lines) {
  return `${lines.join('\n')}\n`;
}

test('apply_patch applies a list of edits in order through the registry', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'eins\nzwei\ndrei\nvier\n' });
  const run = makePatchRunner(tmpRoot);

  const out = await run({
    relative_path: 'a.js',
    edits: [
      { old_string: 'zwei', new_string: 'ZWEI' },
      { old_string: 'vier', new_string: 'VIER' },
      { old_string: 'e', new_string: 'E', replace_all: true },
    ],
  });
  assert.equal(out.error, undefined);
  assert.equal(out.mode, 'edits');
  assert.equal(out.relative_path, 'a.js');
  assert.equal(out.edits_applied, 3);
  assert.equal(out.replacements, 4);
  assert.equal(out.first_changed_line, 1);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'Eins\nZWEI\ndrEi\nVIER\n');
});

test('apply_patch edits see the result of earlier steps', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'alpha\n' });
  const run = makePatchRunner(tmpRoot);

  const out = await run({
    relative_path: 'a.js',
    edits: [
      { old_string: 'alpha', new_string: 'beta' },
      { old_string: 'beta', new_string: 'gamma' },
    ],
  });
  assert.equal(out.replacements, 2);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'gamma\n');
});

test('apply_patch leaves the file untouched when one edit fails', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'foo\nbar\nfoo\n' });
  const run = makePatchRunner(tmpRoot);

  const missing = await run({
    relative_path: 'a.js',
    edits: [
      { old_string: 'bar', new_string: 'baz' },
      { old_string: 'gibtEsNicht', new_string: 'x' },
    ],
  });
  assert.match(missing.error, /^edits\[1\]: old_string wurde nicht gefunden/);

  const ambiguous = await run({
    relative_path: 'a.js',
    edits: [{ old_string: 'foo', new_string: 'x' }],
  });
  assert.match(ambiguous.error, /^edits\[0\]: old_string ist nicht eindeutig \(2 Treffer\)/);

  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'foo\nbar\nfoo\n');
});

test('apply_patch validates the edits list', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'eins zwei\n' });
  const run = makePatchRunner(tmpRoot);

  assert.match((await run({ edits: [{ old_string: 'eins', new_string: 'x' }] })).error, /relative_path/);
  assert.match((await run({ relative_path: 'a.js', edits: [] })).error, /nicht leere Liste/);
  assert.match((await run({ relative_path: 'a.js', edits: ['nope'] })).error, /edits\[0\] muss ein Objekt/);
  assert.match((await run({ relative_path: 'a.js', edits: [{ new_string: 'x' }] })).error, /edits\[0\]\.old_string/);
  assert.match((await run({ relative_path: 'a.js', edits: [{ old_string: '', new_string: 'x' }] })).error, /edits\[0\]\.old_string/);
  assert.match((await run({ relative_path: 'a.js', edits: [{ old_string: 'eins' }] })).error, /edits\[0\]\.new_string/);
  assert.match(
    (await run({ relative_path: 'a.js', edits: [{ old_string: 'eins', new_string: 'eins' }] })).error,
    /edits\[0\]: old_string und new_string müssen sich unterscheiden/
  );

  const tooMany = await run({
    relative_path: 'a.js',
    edits: Array.from({ length: 51 }, (_, i) => ({ old_string: `x${i}`, new_string: `y${i}` })),
  });
  assert.match(tooMany.error, /Zu viele Schritte in edits \(51 > 50\)/);

  const deleted = await run({ relative_path: 'a.js', edits: [{ old_string: ' zwei', new_string: '' }] });
  assert.equal(deleted.replacements, 1);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'eins\n');
});

test('apply_patch requires either edits or patch', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'eins\n' });
  const run = makePatchRunner(tmpRoot);

  assert.match((await run({ relative_path: 'a.js' })).error, /edits .* oder patch/);
  assert.match(
    (await run({ relative_path: 'a.js', edits: [{ old_string: 'eins', new_string: 'x' }], patch: 'egal' })).error,
    /nicht beides/
  );
  assert.match((await run({ patch: '   ' })).error, /patch \(unified diff als Text\) ist erforderlich/);
});

test('apply_patch is disabled unless allowWrite is set', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'eins\n' });

  const out = JSON.parse(
    await registry.execute(
      'apply_patch',
      { relative_path: 'a.js', edits: [{ old_string: 'eins', new_string: 'zwei' }] },
      { workspaceRoot: tmpRoot }
    )
  );
  assert.match(out.error, /Schreibzugriff/);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'eins\n');
});

test('apply_patch applies a unified diff with several hunks across files', async (t) => {
  const tmpRoot = await makePatchFixture(t, {
    'a.js': 'eins\nzwei\ndrei\nvier\nfuenf\n',
    'b.js': 'alpha\nbeta\n',
  });
  const run = makePatchRunner(tmpRoot);

  const out = await run({
    patch: diff(
      'diff --git a/a.js b/a.js',
      'index 1234567..89abcde 100644',
      '--- a/a.js\t2026-09-02 10:00:00',
      '+++ b/a.js\t2026-09-02 10:01:00',
      '@@ -1,3 +1,4 @@',
      ' eins',
      '-zwei',
      '+zwei-neu',
      '+zwei-extra',
      ' drei',
      '@@ -4,2 +5,2 @@',
      '-vier',
      '+vier-neu',
      ' fuenf',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -1,2 +1,2 @@',
      '-alpha',
      '+ALPHA',
      ' beta'
    ),
  });
  assert.equal(out.error, undefined);
  assert.equal(out.mode, 'unified_diff');
  assert.equal(out.files_changed, 2);
  assert.equal(out.hunks_applied, 3);
  assert.deepEqual(
    out.files.map((file) => [file.relative_path, file.hunks_applied]),
    [['a.js', 2], ['b.js', 1]]
  );
  // Ohne Versatz bleibt line_offsets weg — das Ergebnis soll knapp bleiben.
  assert.equal(out.files[0].line_offsets, undefined);
  assert.equal(
    await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'),
    'eins\nzwei-neu\nzwei-extra\ndrei\nvier-neu\nfuenf\n'
  );
  assert.equal(await fs.readFile(path.join(tmpRoot, 'b.js'), 'utf8'), 'ALPHA\nbeta\n');
});

test('apply_patch tolerates shifted line numbers and reports the offset', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'neu1\nneu2\nalpha\nbeta\ngamma\n' });
  const run = makePatchRunner(tmpRoot);

  const out = await run({
    patch: diff('--- a.js', '+++ a.js', '@@ -1,3 +1,3 @@', ' alpha', '-beta', '+BETA', ' gamma'),
  });
  assert.equal(out.error, undefined);
  assert.deepEqual(out.files[0].line_offsets, [2]);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'neu1\nneu2\nalpha\nBETA\ngamma\n');
});

test('apply_patch inserts a pure addition hunk and appends at the end', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'eins\nzwei\n' });
  const run = makePatchRunner(tmpRoot);

  const prepended = await run({
    patch: diff('--- a.js', '+++ a.js', '@@ -0,0 +1,1 @@', '+kopf'),
  });
  assert.equal(prepended.error, undefined);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'kopf\neins\nzwei\n');

  const appended = await run({
    patch: diff('--- a.js', '+++ a.js', '@@ -3,1 +3,2 @@', ' zwei', '+fuss'),
  });
  assert.equal(appended.error, undefined);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'kopf\neins\nzwei\nfuss\n');
});

test('apply_patch preserves CRLF line endings and a missing final newline', async (t) => {
  const tmpRoot = await makePatchFixture(t, {
    'crlf.txt': 'x1\r\nx2\r\nx3\r\n',
    'ohne.txt': 'a\nb\nc',
    'mit.txt': 'a\nb\nc\n',
  });
  const run = makePatchRunner(tmpRoot);

  assert.equal(
    (await run({ patch: diff('--- crlf.txt', '+++ crlf.txt', '@@ -1,3 +1,3 @@', ' x1', '-x2', '+X2', ' x3') })).error,
    undefined
  );
  assert.equal(await fs.readFile(path.join(tmpRoot, 'crlf.txt'), 'utf8'), 'x1\r\nX2\r\nx3\r\n');

  assert.equal(
    (await run({
      patch: diff(
        '--- ohne.txt',
        '+++ ohne.txt',
        '@@ -1,3 +1,3 @@',
        ' a',
        '-b',
        '+B',
        ' c',
        '\\ No newline at end of file'
      ),
    })).error,
    undefined
  );
  assert.equal(await fs.readFile(path.join(tmpRoot, 'ohne.txt'), 'utf8'), 'a\nB\nc');

  // Marker nur auf der neuen Seite: der abschließende Umbruch fällt weg.
  assert.equal(
    (await run({
      patch: diff('--- mit.txt', '+++ mit.txt', '@@ -3,1 +3,1 @@', '-c', '+c-neu', '\\ No newline at end of file'),
    })).error,
    undefined
  );
  assert.equal(await fs.readFile(path.join(tmpRoot, 'mit.txt'), 'utf8'), 'a\nb\nc-neu');
});

test('apply_patch handles removed lines that look like a file header', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.txt': 'kopf\n-- signatur\nfuss\n' });
  const run = makePatchRunner(tmpRoot);

  const out = await run({
    patch: diff('--- a.txt', '+++ a.txt', '@@ -1,3 +1,3 @@', ' kopf', '--- signatur', '+++ signatur', ' fuss'),
  });
  assert.equal(out.error, undefined);
  assert.equal(out.files_changed, 1);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.txt'), 'utf8'), 'kopf\n++ signatur\nfuss\n');
});

test('apply_patch writes nothing when a hunk does not apply', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.js': 'eins\nzwei\n', 'b.js': 'alpha\nbeta\n' });
  const run = makePatchRunner(tmpRoot);

  const out = await run({
    patch: diff(
      '--- a.js',
      '+++ a.js',
      '@@ -1,1 +1,1 @@',
      '-eins',
      '+EINS',
      '--- b.js',
      '+++ b.js',
      '@@ -1,1 +1,1 @@',
      '-gibtEsNicht',
      '+x'
    ),
  });
  assert.match(out.error, /Hunk 1 von 1 lässt sich nicht auf "b\.js" anwenden: der Kontext passt nicht/);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.js'), 'utf8'), 'eins\nzwei\n');
  assert.equal(await fs.readFile(path.join(tmpRoot, 'b.js'), 'utf8'), 'alpha\nbeta\n');
});

test('apply_patch rejects malformed patches with an explanatory error', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.txt': 'eins\nzwei\ndrei\n' });
  const run = makePatchRunner(tmpRoot);
  const errorFor = async (patch) => (await run({ patch })).error;

  assert.match(await errorFor('einfach nur Text\n'), /Unerwartete Zeile 1 im Patch/);
  assert.match(
    await errorFor(diff('diff --git a/a.txt b/a.txt', 'index 1234567..89abcde 100644')),
    /enthält keinen Dateikopf/
  );
  assert.match(await errorFor(diff('--- a.txt', '@@ -1,1 +1,1 @@', '-eins', '+x')), /fehlt die zugehörige "\+\+\+ "-Zeile/);
  assert.match(await errorFor(diff('--- a.txt', '+++ a.txt')), /enthält der Patch keinen Hunk/);
  assert.match(await errorFor(diff('--- a.txt', '+++ a.txt', '@@ kaputt @@', ' eins')), /Hunk-Kopf in Zeile 3 ist ungültig/);
  assert.match(
    await errorFor(diff('--- a.txt', '+++ a.txt', '@@ -1,5 +1,5 @@', ' eins', '-zwei', '+ZWEI')),
    /ist unvollständig: erwartet 5 alte und 5 neue Zeilen, gefunden 2 und 2/
  );
  assert.match(
    await errorFor(diff('--- a.txt', '+++ a.txt', '@@ -1,2 +1,2 @@', ' eins', '?zwei')),
    /Unerwartete Zeile 5 im Hunk/
  );
  assert.match(
    await errorFor(diff('--- /dev/null', '+++ b/neu.txt', '@@ -0,0 +1,1 @@', '+hallo')),
    /legt "neu\.txt" neu an .* write_file_text/
  );
  assert.match(
    await errorFor(diff('--- a/a.txt', '+++ /dev/null', '@@ -1,1 +0,0 @@', '-eins')),
    /löscht "a\.txt" — Dateien löschen kann apply_patch nicht/
  );
  assert.match(
    await errorFor(diff('--- a/a.txt', '+++ b/neu.txt', '@@ -1,1 +1,1 @@', '-eins', '+x')),
    /benennt "a\.txt" in "neu\.txt" um/
  );
  assert.match(await errorFor(diff('Binary files a/bild.png and b/bild.png differ')), /Binär-Patches/);
  assert.match(
    await errorFor(
      diff(
        '--- a.txt',
        '+++ a.txt',
        '@@ -1,1 +1,1 @@',
        '-eins',
        '+EINS',
        '--- a.txt',
        '+++ a.txt',
        '@@ -3,1 +3,1 @@',
        '-drei',
        '+DREI'
      )
    ),
    /"a\.txt" kommt mehrfach im Patch vor/
  );

  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.txt'), 'utf8'), 'eins\nzwei\ndrei\n');
});

test('apply_patch reports a relative_path that the patch does not touch', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.txt': 'eins\n' });
  const run = makePatchRunner(tmpRoot);

  const out = await run({
    relative_path: 'andere.txt',
    patch: diff('--- a.txt', '+++ a.txt', '@@ -1,1 +1,1 @@', '-eins', '+EINS'),
  });
  assert.match(out.error, /relative_path \("andere\.txt"\) kommt im Patch nicht vor.*a\.txt/);
  assert.equal(await fs.readFile(path.join(tmpRoot, 'a.txt'), 'utf8'), 'eins\n');
});

test('apply_patch respects workspace bounds, folders and missing files', async (t) => {
  const tmpRoot = await makePatchFixture(t, { 'a.txt': 'eins\n' });
  await fs.mkdir(path.join(tmpRoot, 'ordner'));
  const run = makePatchRunner(tmpRoot);

  assert.match(
    (await run({ relative_path: '../outside.txt', edits: [{ old_string: 'a', new_string: 'b' }] })).error,
    /außerhalb/
  );
  assert.match(
    (await run({ relative_path: '.', edits: [{ old_string: 'a', new_string: 'b' }] })).error,
    /Ordner/
  );
  assert.match(
    (await run({ patch: diff('--- ../outside.txt', '+++ ../outside.txt', '@@ -1,1 +1,1 @@', '-a', '+b') })).error,
    /außerhalb/
  );
  assert.match(
    (await run({ patch: diff('--- ordner', '+++ ordner', '@@ -1,1 +1,1 @@', '-a', '+b') })).error,
    /Pfad ist ein Ordner, keine Datei/
  );
  assert.match(
    (await run({ patch: diff('--- fehlt.txt', '+++ fehlt.txt', '@@ -1,1 +1,1 @@', '-a', '+b') })).error,
    /"fehlt\.txt" existiert nicht/
  );
});

test('apply_patch rejects a symlink to a file outside the workspace', async (t) => {
  const registry = makeToolRegistry();
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  const workspace = path.join(tmpRoot, 'workspace');
  const outside = path.join(tmpRoot, 'outside');
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  const secret = path.join(outside, 'secret.txt');
  await fs.writeFile(secret, 'geheim\n', 'utf8');
  const linked = await createSymlinkOrSkip(
    t,
    secret,
    path.join(workspace, 'secret-link.txt'),
    process.platform === 'win32' ? 'file' : undefined
  );
  if (!linked) return;
  const run = makePatchRunner(workspace, registry);

  assert.match(
    (await run({ relative_path: 'secret-link.txt', edits: [{ old_string: 'geheim', new_string: 'offen' }] })).error,
    /außerhalb/
  );
  assert.match(
    (await run({
      patch: diff('--- secret-link.txt', '+++ secret-link.txt', '@@ -1,1 +1,1 @@', '-geheim', '+offen'),
    })).error,
    /außerhalb/
  );
  assert.equal(await fs.readFile(secret, 'utf8'), 'geheim\n');
});

test('apply_patch enforces read, write and patch size limits', async (t) => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fs-'));
  t.after(() => fs.rm(tmpRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(tmpRoot, 'gross.txt'), 'x'.repeat(2048), 'utf8');
  await fs.writeFile(path.join(tmpRoot, 'klein.txt'), 'kurz\n', 'utf8');

  const strictWrite = makePatchRunner(
    tmpRoot,
    createWorkspaceToolRegistry({
      fsService: createFsService({ fs, path, maxReadFileBytes: 1024, maxWriteFileBytes: 16 }),
    })
  );
  assert.match(
    (await strictWrite({ relative_path: 'gross.txt', edits: [{ old_string: 'x', new_string: 'y' }] })).error,
    /Datei zu groß/
  );
  assert.match(
    (await strictWrite({ relative_path: 'klein.txt', edits: [{ old_string: 'kurz', new_string: 'k'.repeat(64) }] })).error,
    /Inhalt zu groß/
  );
  assert.match(
    (await strictWrite({
      patch: diff('--- klein.txt', '+++ klein.txt', '@@ -1,1 +1,1 @@', '-kurz', '+lang'),
    })).error,
    /Patch zu groß/
  );

  const strictRead = makePatchRunner(
    tmpRoot,
    createWorkspaceToolRegistry({
      fsService: createFsService({ fs, path, maxReadFileBytes: 1024, maxWriteFileBytes: 1024 * 1024 }),
    })
  );
  assert.match(
    (await strictRead({ patch: diff('--- gross.txt', '+++ gross.txt', '@@ -1,1 +1,1 @@', '-x', '+y') })).error,
    /"gross\.txt": Datei zu groß/
  );
  assert.equal(await fs.readFile(path.join(tmpRoot, 'klein.txt'), 'utf8'), 'kurz\n');
  assert.equal((await fs.readFile(path.join(tmpRoot, 'gross.txt'), 'utf8')).length, 2048);
});

test('containsPath accepts the root itself and children, rejects siblings and traversal', () => {
  const path = require('path');
  const fs = require('fs/promises');
  const svc = createFsService({ fs, path, maxReadFileBytes: 1024 });
  assert.equal(svc.containsPath('/ws', '/ws'), true);
  assert.equal(svc.containsPath('/ws', '/ws/sub/file.txt'), true);
  assert.equal(svc.containsPath('/ws', '/ws/sub/../file.txt'), true);
  assert.equal(svc.containsPath('/ws', '/ws/../outside'), false);
  assert.equal(svc.containsPath('/ws', '/ws-evil/file.txt'), false);
  assert.equal(svc.containsPath('/ws', '/other'), false);
});
