// Program allowances (#408): the entry format, the reading of a command line
// as one simple command, and main's service that resolves programs, checks
// folders and decides whether a command gets an allowance. The service runs
// against real files in a temp folder — identity is the file, so a fake file
// system would test the fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const {
  normalizeProgramAllowance,
  normalizeProgramAllowances,
  normalizeAllowancePath,
  parseDomainInput,
  isNarrowing,
  grantsSomething,
  programName,
  PROGRAM_ALLOWANCE_LIMITS,
} = require('../src/shared/contracts/program-allowances');
const { parseSimpleCommand } = require('../src/shared/runtime/simple-command');
const { resolveRunDomains } = require('../src/shared/runtime/sandbox-domains');
const { createProgramAllowances } = require('../src/main/services/program-allowances-service');

const posixOnly = { skip: process.platform === 'win32' ? 'no sandbox, no allowances on Windows' : false };

// ── The entry ───────────────────────────────────────────────────────────────

test('an entry keeps only an absolute program path, host names and absolute folders', () => {
  assert.deepEqual(
    normalizeProgramAllowance({
      path: '/Users/u/.ai-workplace/bin//ms-todo-cli/',
      domains: ['Graph.Microsoft.com', 'https://login.microsoftonline.com/common', '10.0.0.1', '*'],
      writePaths: ['/Users/u/Library/Application Support/ms-todo', 'relative/dir', '/', '/a/../b'],
      trustd: 'yes',
    }),
    {
      path: '/Users/u/.ai-workplace/bin/ms-todo-cli',
      domains: ['graph.microsoft.com', 'login.microsoftonline.com'],
      writePaths: ['/Users/u/Library/Application Support/ms-todo'],
      trustd: false,
    },
  );
  assert.equal(normalizeProgramAllowance({ path: 'ms-todo-cli' }), null);
  assert.equal(normalizeProgramAllowance({ path: '/' }), null);
  assert.equal(normalizeProgramAllowance(null), null);
  assert.equal(normalizeAllowancePath('/a/./b'), null);
  assert.equal(programName('/opt/bin/gh'), 'gh');
});

test('the list holds each program once and no more than the limit', () => {
  const many = Array.from({ length: PROGRAM_ALLOWANCE_LIMITS.MAX_ENTRIES + 5 }, (_, i) => ({ path: `/bin/p${i}` }));
  assert.equal(normalizeProgramAllowances(many).length, PROGRAM_ALLOWANCE_LIMITS.MAX_ENTRIES);
  assert.deepEqual(
    normalizeProgramAllowances([{ path: '/bin/gh', trustd: true }, { path: '/bin/gh' }, { path: 'x' }]).map((e) => e.trustd),
    [true],
  );
  assert.equal(grantsSomething(normalizeProgramAllowance({ path: '/bin/gh' })), false);
  assert.equal(grantsSomething(normalizeProgramAllowance({ path: '/bin/gh', trustd: true })), true);
});

test('the domain field splits on lines, spaces and commas and names what it refuses', () => {
  assert.deepEqual(parseDomainInput('login.microsoftonline.com, Graph.Microsoft.com\n\nfoo  bar_baz 127.0.0.1 graph.microsoft.com'), {
    domains: ['login.microsoftonline.com', 'graph.microsoft.com'],
    invalid: ['foo', 'bar_baz', '127.0.0.1'],
    tooMany: false,
  });
  const lots = Array.from({ length: PROGRAM_ALLOWANCE_LIMITS.MAX_DOMAINS + 1 }, (_, i) => `h${i}.example.com`).join(' ');
  assert.equal(parseDomainInput(lots).tooMany, true);
});

test('only an edit that takes rights away counts as narrowing', () => {
  const base = normalizeProgramAllowance({ path: '/bin/gh', domains: ['a.example.com', 'b.example.com'], writePaths: ['/x'], trustd: true });
  const fewer = normalizeProgramAllowance({ path: '/bin/gh', domains: ['a.example.com'], writePaths: [], trustd: false });
  assert.equal(isNarrowing(base, fewer), true);
  assert.equal(isNarrowing(base, base), true);
  assert.equal(isNarrowing(fewer, base), false);
  assert.equal(isNarrowing(base, { ...fewer, domains: ['c.example.com'] }), false);
  assert.equal(isNarrowing(base, { ...fewer, path: '/bin/other' }), false);
  assert.equal(isNarrowing(null, fewer), false);
});

test('a run\'s domains put the allowance first, so the cap never drops them', () => {
  const declared = Array.from({ length: 20 }, (_, i) => `d${i}.example.com`);
  const domains = resolveRunDomains('shell_execute', { command: 'x', network_domains: declared }, { domains: ['graph.microsoft.com'] });
  assert.equal(domains.length, 20);
  assert.equal(domains[0], 'graph.microsoft.com');
  assert.deepEqual(resolveRunDomains('shell_execute', { command: 'x' }, null), []);
});

// ── One simple command ──────────────────────────────────────────────────────

test('a program with arguments, quoted or escaped, is one simple command', () => {
  assert.deepEqual(parseSimpleCommand('ms-todo-cli add \'Einkaufen gehen\' --due "morgen 9 Uhr" a\\ b'), {
    ok: true,
    words: [
      { value: 'ms-todo-cli', start: 0, end: 11 },
      { value: 'add', start: 12, end: 15 },
      { value: 'Einkaufen gehen', start: 16, end: 33 },
      { value: '--due', start: 34, end: 39 },
      { value: 'morgen 9 Uhr', start: 40, end: 54 },
      { value: 'a b', start: 55, end: 59 },
    ],
  });
});

test('chains, pipes, redirections, subshells, assignments and comments are more than the program', () => {
  for (const line of [
    'ms-todo-cli lists | head',
    'ms-todo-cli && curl x',
    'ms-todo-cli; rm x',
    'ms-todo-cli > out.txt',
    'ms-todo-cli 2>&1',
    'ms-todo-cli &',
    '(ms-todo-cli)',
    'ms-todo-cli\nrm x',
    'DYLD_INSERT_LIBRARIES=/tmp/x.dylib ms-todo-cli',
    'ms-todo-cli # hidden',
    'ms-todo-cli \'unterminated',
    'ms-todo-cli \\',
  ]) {
    assert.deepEqual(parseSimpleCommand(line), { ok: false, reason: 'compound' }, line);
  }
});

test('whatever the shell expands first is refused, even inside double quotes', () => {
  for (const line of ['ms-todo-cli $HOME', 'ms-todo-cli "$(id)"', 'ms-todo-cli `id`', 'ms-todo-cli "a${b}"']) {
    assert.deepEqual(parseSimpleCommand(line), { ok: false, reason: 'expansion' }, line);
  }
  // Single quotes keep everything literal.
  assert.equal(parseSimpleCommand("ms-todo-cli '$HOME | x'").ok, true);
  assert.deepEqual(parseSimpleCommand('   '), { ok: false, reason: 'empty' });
});

// ── The service ─────────────────────────────────────────────────────────────

async function makeFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-allowance-')));
  const home = path.join(root, 'home');
  const bin = path.join(home, '.ai-workplace', 'bin');
  const cache = path.join(home, 'Library', 'Application Support', 'ms-todo');
  const project = path.join(root, 'project');
  const userData = path.join(home, 'Library', 'Application Support', 'Snotra AI');
  for (const dir of [bin, cache, project, userData, path.join(home, '.ssh')]) await fs.mkdir(dir, { recursive: true });
  const tool = path.join(bin, 'ms-todo-cli');
  await fs.writeFile(tool, '#!/bin/sh\necho real\n', { mode: 0o755 });
  // A file of the same name in the project — the impostor.
  await fs.writeFile(path.join(project, 'ms-todo-cli'), '#!/bin/sh\necho fake\n', { mode: 0o755 });
  // A symlink to the real tool, as installers like to leave them.
  const links = path.join(root, 'links');
  await fs.mkdir(links);
  await fs.symlink(tool, path.join(links, 'ms-todo-cli'));
  await fs.writeFile(path.join(bin, 'not-executable'), 'x', { mode: 0o644 });
  return { root, home, bin, cache, project, userData, tool, links };
}

function makeService(fx, { allowances = [], userPath, platform = 'darwin' } = {}) {
  return createProgramAllowances({
    fs,
    path,
    os: { homedir: () => fx.home },
    platform,
    readUserPath: async () => userPath ?? `/usr/bin:/bin:${fx.bin}`,
    readAllowances: async () => allowances,
    protectedRoots: [fx.userData],
    sensitivePaths: ['~/.ssh', '~/Library/Keychains', '~/Library/Application Support/Google/Chrome'],
  });
}

test('a program is found by name through the PATH, or by ~ or absolute path', posixOnly, async () => {
  const fx = await makeFixture();
  try {
    const service = makeService(fx);
    assert.deepEqual(await service.resolveProgram('ms-todo-cli'), { ok: true, path: fx.tool, name: 'ms-todo-cli' });
    assert.deepEqual(await service.resolveProgram('~/.ai-workplace/bin/ms-todo-cli'), { ok: true, path: fx.tool, name: 'ms-todo-cli' });
    assert.deepEqual(await service.resolveProgram(fx.tool), { ok: true, path: fx.tool, name: 'ms-todo-cli' });
    assert.equal((await service.resolveProgram('')).error.key, 'permissions.allowance.error.noProgram');
    assert.equal((await service.resolveProgram('./ms-todo-cli')).error.key, 'permissions.allowance.error.relativeProgram');
    assert.equal((await service.resolveProgram('no-such-tool')).error.key, 'permissions.allowance.error.programNotFound');
    assert.equal((await service.resolveProgram(path.join(fx.bin, 'not-executable'))).ok, false);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('folders: existing and specific ones pass; home, root, Snotra and closed places do not', posixOnly, async () => {
  const fx = await makeFixture();
  try {
    const service = makeService(fx);
    assert.deepEqual(await service.validateWritePath('~/Library/Application Support/ms-todo'), { ok: true, path: fx.cache });
    const refused = async (folder) => (await service.validateWritePath(folder)).error?.key;
    assert.equal(await refused('~'), 'permissions.allowance.error.folderTooBroad');
    assert.equal(await refused('/'), 'permissions.allowance.error.folderTooBroad');
    assert.equal(await refused(fx.root), 'permissions.allowance.error.folderTooBroad');
    assert.equal(await refused('~/.ssh'), 'permissions.allowance.error.folderProtected');
    assert.equal(await refused(fx.userData), 'permissions.allowance.error.folderProtected');
    // Around a closed place counts as well: Application Support holds Snotra's own storage.
    assert.equal(await refused('~/Library/Application Support'), 'permissions.allowance.error.folderProtected');
    assert.equal(await refused('~/nope'), 'permissions.allowance.error.folderMissing');
    assert.equal(await refused('relative/dir'), 'permissions.allowance.error.folderInvalid');
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('an entry from the dialog is checked in full; trustd only exists on macOS', posixOnly, async () => {
  const fx = await makeFixture();
  try {
    const raw = { program: 'ms-todo-cli', domains: ['graph.microsoft.com', 'login.microsoftonline.com'], writePaths: [fx.cache], trustd: true };
    assert.deepEqual((await makeService(fx).prepareEntry(raw)).entry, {
      path: fx.tool,
      domains: ['graph.microsoft.com', 'login.microsoftonline.com'],
      writePaths: [fx.cache],
      trustd: true,
    });
    assert.equal((await makeService(fx, { platform: 'linux' }).prepareEntry(raw)).entry.trustd, false);
    const error = async (patch) => (await makeService(fx).prepareEntry({ ...raw, ...patch })).error?.key;
    assert.equal(await error({ domains: ['bad_host'] }), 'permissions.allowance.error.invalidDomains');
    assert.equal(await error({ writePaths: ['~'] }), 'permissions.allowance.error.folderTooBroad');
    assert.equal(await error({ domains: [], writePaths: [], trustd: false }), 'permissions.allowance.error.empty');
    assert.equal(await error({ program: 'nope' }), 'permissions.allowance.error.programNotFound');
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('a command that runs the allowed file on its own gets the allowance and its absolute path', posixOnly, async () => {
  const fx = await makeFixture();
  try {
    const entry = { path: fx.tool, domains: ['graph.microsoft.com'], writePaths: [fx.cache], trustd: true };
    const service = makeService(fx, { allowances: [entry] });

    const byName = await service.match({ command: 'ms-todo-cli tasks "Arbeit"', cwd: fx.project });
    assert.deepEqual(byName.allowance, {
      path: fx.tool, program: 'ms-todo-cli', domains: ['graph.microsoft.com'], writePaths: [fx.cache], trustd: true,
    });
    // What runs is the allowed file — not whatever the shell would find first.
    assert.equal(byName.command, `${fx.tool} tasks "Arbeit"`);
    assert.deepEqual(byName.entry, entry);

    // Through a symlink it is still the same file.
    const viaLink = await service.match({ command: `${path.join(fx.links, 'ms-todo-cli')} lists`, cwd: fx.project });
    assert.equal(viaLink.allowance.path, fx.tool);

    // trustd is a macOS thing; elsewhere the card must not claim it.
    const linux = makeService(fx, { allowances: [entry], platform: 'linux' });
    assert.equal((await linux.match({ command: 'ms-todo-cli', cwd: fx.project })).allowance.trustd, false);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});

test('a file of the same name, a chain or an expansion keeps the allowance off and says why', posixOnly, async () => {
  const fx = await makeFixture();
  try {
    const entry = { path: fx.tool, domains: ['graph.microsoft.com'], writePaths: [], trustd: false };
    const service = makeService(fx, { allowances: [entry] });
    const skipped = async (command, userPath) => {
      const s = userPath ? makeService(fx, { allowances: [entry], userPath }) : service;
      return (await s.match({ command, cwd: fx.project }))?.skipped;
    };
    assert.deepEqual(await skipped('./ms-todo-cli lists'), { program: 'ms-todo-cli', reason: 'otherFile' });
    // A `.` early in the PATH finds the project's file first — and is caught.
    assert.deepEqual(await skipped('ms-todo-cli lists', `.:${fx.bin}`), { program: 'ms-todo-cli', reason: 'otherFile' });
    assert.deepEqual(await skipped('ms-todo-cli lists | head'), { program: 'ms-todo-cli', reason: 'compound' });
    assert.deepEqual(await skipped('HTTPS_PROXY=http://x ms-todo-cli'), { program: 'ms-todo-cli', reason: 'compound' });
    assert.deepEqual(await skipped('ms-todo-cli "$(id)"'), { program: 'ms-todo-cli', reason: 'expansion' });
    // Nothing to report when the command does not mention the program.
    assert.equal(await service.match({ command: 'git status | head', cwd: fx.project }), null);
    assert.equal(await service.match({ command: 'git status', cwd: fx.project }), null);
    assert.equal(await makeService(fx).match({ command: 'ms-todo-cli', cwd: fx.project }), null);
    assert.equal(await makeService(fx, { allowances: [entry], platform: 'win32' }).match({ command: 'ms-todo-cli' }), null);
  } finally {
    await fs.rm(fx.root, { recursive: true, force: true });
  }
});
