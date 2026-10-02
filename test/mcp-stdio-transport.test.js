// JSON-RPC ueber stdio (Issue #106) — die Schutzpfade, die der Dienst-Test
// nicht von aussen erreicht: ein Server ohne Zeilenende, eine Anfrage an eine
// tote Verbindung und ein Abbruch, der schon vor dem Senden feststeht.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const path = require('path');

const { createStdioTransport } = require('../src/main/services/mcp-stdio-transport');
const { normalizeMcpServerConfig } = require('../src/shared/contracts/mcp');

const FAKE = path.join(__dirname, 'helpers', 'fake-mcp-server.js');

function transportFor(mode) {
  return createStdioTransport({
    config: normalizeMcpServerConfig({ id: 'fake', label: 'fake', command: process.execPath, args: [FAKE, mode] }),
    spawn: childProcess.spawn,
  });
}

test('eine übergroße Antwort ohne Zeilenende bricht ab statt zu puffern', async (t) => {
  const transport = transportFor('flood');
  t.after(() => transport.close());
  await transport.start();
  await transport.request('initialize', {}, { timeoutMs: 4_000 });

  await assert.rejects(
    () => transport.request('tools/list', {}, { timeoutMs: 10_000 }),
    /oversized answer without a line break/,
  );
});

test('eine Anfrage ohne laufenden Prozess scheitert sofort', async () => {
  const transport = transportFor('ok');
  await assert.rejects(() => transport.request('tools/list', {}), /is not connected/);
});

test('ein bereits abgebrochenes Signal verhindert das Senden', async (t) => {
  const transport = transportFor('ok');
  t.after(() => transport.close());
  await transport.start();

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => transport.request('initialize', {}, { signal: controller.signal }), /Request cancelled/);
});

test('ein nicht startbares Kommando wirft mit Klartext', async () => {
  const transport = createStdioTransport({
    config: normalizeMcpServerConfig({ id: 'weg', label: 'weg', command: 'snotra-gibt-es-nicht-xyz' }),
    spawn: childProcess.spawn,
  });
  await assert.rejects(() => transport.start(), /could not be started/);
  assert.equal(transport.isAlive(), false);
});

test('close auf einer nie gestarteten Verbindung ist kein Fehler', async () => {
  const transport = transportFor('ok');
  await transport.close();
  assert.equal(transport.isAlive(), false);
});

// --- Working directory (CR-B16-06) ---

const fs = require('fs');
const os = require('os');

function tmpHome(t) {
  // realpath: on macOS the temp folder is reached through a symlink, and the
  // child reports the resolved path.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-mcp-home-')));
  // Windows keeps a folder that is still some process's working directory, so
  // every test below closes its server before this runs.
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

async function whoami({ cwd, homeDir, args = [] }) {
  const transport = createStdioTransport({
    config: normalizeMcpServerConfig({
      id: 'who', label: 'who', command: process.execPath, args: [FAKE, 'whoami', ...args], cwd,
    }),
    spawn: childProcess.spawn,
    homeDir,
  });
  try {
    await transport.start();
    await transport.request('initialize', {}, { timeoutMs: 4_000 });
    const result = await transport.request('tools/call', { name: 'echo', arguments: {} }, { timeoutMs: 4_000 });
    return JSON.parse(result.content[0].text);
  } finally {
    await transport.close();
  }
}

test('an empty working directory is the home folder, not the app’s own', async (t) => {
  const home = tmpHome(t);
  assert.equal((await whoami({ cwd: '', homeDir: home })).cwd, home);
});

test('a relative working directory starts from the home folder', async (t) => {
  const home = tmpHome(t);
  fs.mkdirSync(path.join(home, 'servers'));
  assert.equal((await whoami({ cwd: 'servers', homeDir: home })).cwd, path.join(home, 'servers'));
});

test('a missing working directory is named, not reported as a missing command', async (t) => {
  const home = tmpHome(t);
  const missing = path.join(home, 'gone');
  const transport = createStdioTransport({
    config: normalizeMcpServerConfig({ id: 'who', label: 'Who', command: process.execPath, args: [FAKE, 'ok'], cwd: missing }),
    spawn: childProcess.spawn,
    homeDir: home,
  });
  await assert.rejects(() => transport.start(), (error) => {
    assert.match(error.message, /working directory .*gone.* does not exist/);
    assert.deepEqual(error.userMessage, { key: 'mcp.transport.cwdMissing', params: { label: 'Who', cwd: missing } });
    return true;
  });
  assert.equal(transport.isAlive(), false);
});

// --- Windows (CR-B16-01) ---

test('every spawn asks Windows to keep the console window hidden', async (t) => {
  const seen = [];
  const transport = createStdioTransport({
    config: normalizeMcpServerConfig({ id: 'fake', label: 'fake', command: process.execPath, args: [FAKE, 'ok'] }),
    spawn: (command, args, options) => {
      seen.push(options);
      return childProcess.spawn(command, args, options);
    },
  });
  t.after(() => transport.close());
  await transport.start();
  assert.equal(seen[0].windowsHide, true);
});

test('on Windows a server behind a .cmd launcher on PATH starts, and its arguments arrive intact', {
  skip: process.platform !== 'win32' && 'needs cmd.exe',
}, async (t) => {
  const home = tmpHome(t);
  const bin = path.join(home, 'bin with space');
  fs.mkdirSync(bin);
  // Shaped like npx.cmd: the batch file hands %* on to node.
  fs.writeFileSync(
    path.join(bin, 'fake-mcp.cmd'),
    `@ECHO OFF\r\n"${process.execPath}" "${FAKE}" %*\r\n`,
  );
  const args = ['whoami', 'a b', 'x&y|z', 'say "hi"', '%PATH%', 'C:\\dir\\', '(paren)', '^caret!', ''];
  const transport = createStdioTransport({
    config: normalizeMcpServerConfig({ id: 'cmd', label: 'cmd', command: 'fake-mcp', args }),
    spawn: childProcess.spawn,
    // A spread of process.env keeps Windows' `Path`; this `PATH` has to win.
    baseEnv: { ...process.env, PATH: `${bin};${process.env.PATH || ''}` },
    homeDir: home,
  });
  try {
    await transport.start();
    await transport.request('initialize', {}, { timeoutMs: 10_000 });
    const result = await transport.request('tools/call', { name: 'echo', arguments: {} }, { timeoutMs: 10_000 });
    assert.deepEqual(JSON.parse(result.content[0].text).argv, args.slice(1));
  } finally {
    await transport.close();
  }
});
