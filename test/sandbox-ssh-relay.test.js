// Git over SSH inside the Linux sandbox (#1155): the runtime patch that starts
// the relay, the launcher that checks git's request, the client that sends
// it — and, on the CI's Linux runner, the whole route through the real
// sandbox: `git ls-remote` signs in through the ssh-agent at a local sshd,
// while the private key file stays unreadable inside the run.
//
// The parts run wherever there is a POSIX shell. The whole route needs
// bubblewrap, and it writes a key and a known_hosts line into ~/.ssh — ssh
// reads ~/.ssh from the account, not from $HOME — so it runs on GitHub's
// Linux runner only and is skipped elsewhere. There SNOTRA_REQUIRE_SANDBOX
// is set, and a sandbox that is not there fails it instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const net = require('net');
const dns = require('dns').promises;
const fs = require('fs').promises;
const { existsSync } = require('fs');
const path = require('path');
const os = require('os');

const {
  patchSshRelay, linuxPath, RELAY_ANCHOR, RELAY_PATCHED, snotraSshRelay,
} = require('../scripts/patch-sandbox-runtime');
const { createSandboxService } = require('../src/main/services/sandbox-service');
const { createShellRunnerService } = require('../src/main/services/shell-runner-service');
const { removeTempDir } = require('./helpers/temp-dir');

const SERVICES = path.join(__dirname, '..', 'src', 'main', 'services');
const LAUNCHER = path.join(SERVICES, 'ssh-relay.sh');
const CLIENT = path.join(SERVICES, 'ssh-relay-client.sh');
const posixOnly = { skip: process.platform === 'win32' ? 'POSIX shell scripts' : false };

// ── The patched runtime ─────────────────────────────────────────────────────

test('the installed runtime starts the SSH relay before the seccomp filter (scripts/patch-sandbox-runtime.js)', async () => {
  const source = await fs.readFile(linuxPath(), 'utf8');
  assert.ok(source.includes(RELAY_PATCHED) && source.includes('function snotraSshRelay(socat)'),
    'The line patched after `npm install` is missing — did an update of @anthropic-ai/sandbox-runtime move it? '
    + 'Without it Git over SSH cannot sign in inside the Linux sandbox (#1155).');
  // The relay goes in front of the filter, like the runtime's own relays.
  const builder = source.slice(source.indexOf('function buildSandboxCommand('));
  assert.ok(builder.indexOf('...snotraSshRelay(socat)') < builder.indexOf('applySeccompPrefix + quote('));
  // The launcher runs the runtime's own GIT_SSH_COMMAND, the route through its proxy.
  const utils = await fs.readFile(path.join(path.dirname(linuxPath()), 'sandbox-utils.js'), 'utf8');
  assert.match(utils, /GIT_SSH_COMMAND=ssh \$\{sshMuxOverride\} -o ProxyCommand='socat - PROXY:localhost:%h:%p,proxyport=/,
    'the runtime no longer sets the Linux GIT_SSH_COMMAND ssh-relay.sh relies on (#1155)');
});

test('the relay patch adds its line once, its helper before the source map, and leaves another runtime alone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-relay-patch-'));
  try {
    const file = path.join(dir, 'linux-sandbox-utils.js');
    const original = `function buildSandboxCommand() {\n    const socatCommands = [\n${RELAY_ANCHOR}\n}\n`
      + '//# sourceMappingURL=linux-sandbox-utils.js.map';
    await fs.writeFile(file, original);
    assert.equal(patchSshRelay(file), 'patched');
    const patched = await fs.readFile(file, 'utf8');
    assert.ok(patched.includes(RELAY_PATCHED));
    assert.ok(patched.includes(snotraSshRelay.toString()));
    assert.ok(patched.endsWith('\n//# sourceMappingURL=linux-sandbox-utils.js.map'));
    assert.equal(patchSshRelay(file), 'already');
    assert.equal(await fs.readFile(file, 'utf8'), patched, 'a second run changes nothing');
    await fs.writeFile(file, 'something else entirely');
    assert.equal(patchSshRelay(file), 'missing');
  } finally {
    await removeTempDir(dir);
  }
});

/** A stand-in for socat that writes its arguments, one per line, to `$ARGS_FILE`. */
async function fakeSocat(dir) {
  const file = path.join(dir, 'socat');
  await fs.writeFile(file, '#!/bin/sh\nfor a in "$@"; do printf \'%s\\n\' "$a"; done > "$ARGS_FILE"\n', { mode: 0o755 });
  return file;
}

test('the relay starts only for a run that names the launcher, and a space in its path survives', posixOnly, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra relay line-'));
  try {
    const socat = await fakeSocat(dir);
    const argsFile = path.join(dir, 'args');
    const [line] = snotraSshRelay(`'${socat}'`);
    assert.doesNotMatch(line, /!/, 'shell-quote would keep a backslash in front of it');
    const runLine = (extra) => childProcess.spawnSync('/bin/sh', ['-c', `${line}\nwait`], {
      env: { PATH: process.env.PATH, ARGS_FILE: argsFile, ...extra }, encoding: 'utf8',
    });

    runLine({});
    assert.equal(existsSync(argsFile), false, 'no relay without SNOTRA_SSH_RELAY');

    const launcher = path.join(dir, 'launcher.sh');
    await fs.writeFile(launcher, 'printf "launched %s\\n" "$#"');
    runLine({ SNOTRA_SSH_RELAY: launcher });
    const args = (await fs.readFile(argsFile, 'utf8')).trim().split('\n');
    assert.deepEqual(args, [
      '-t', '3600', 'TCP-LISTEN:2222,bind=127.0.0.1,fork,reuseaddr', 'SYSTEM:set -f;IFS=;exec /bin/sh $SNOTRA_SSH_RELAY',
    ]);
    // What socat hands to /bin/sh for each connection: the launcher, whole.
    const system = args[3].slice('SYSTEM:'.length);
    const launched = childProcess.spawnSync('/bin/sh', ['-c', system], {
      env: { PATH: process.env.PATH, SNOTRA_SSH_RELAY: launcher }, encoding: 'utf8',
    });
    assert.equal(launched.stdout, 'launched 0\n', launched.stderr);
  } finally {
    await removeTempDir(dir);
  }
});

test('the client connects to the port the relay listens on', async () => {
  const client = await fs.readFile(CLIENT, 'utf8');
  const [line] = snotraSshRelay('socat');
  const port = /TCP-LISTEN:(\d+),bind=127\.0\.0\.1/.exec(line)?.[1];
  assert.ok(port);
  assert.ok(client.includes(`TCP:127.0.0.1:${port},`), 'client and relay agree on the port');
});

// ── The launcher ────────────────────────────────────────────────────────────

/**
 * Runs the launcher on one request, the way socat would hand it over, with a
 * stand-in for ssh in GIT_SSH_COMMAND that records what it got.
 */
async function launch(fields, { stream = 'GIT STREAM\n', dirName = 'snotra-ssh.AbC123', gitSshCommand, envPath } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-launcher-'));
  const dir = path.join(base, dirName);
  await fs.mkdir(dir);
  const fakeSsh = path.join(base, 'fake-ssh.sh');
  await fs.writeFile(fakeSsh, [
    'for a in "$@"; do printf \'%s\\n\' "$a"; done > "$FAKE_DIR/argv"',
    'printf \'%s\\n\' "${GIT_PROTOCOL-unset}" > "$FAKE_DIR/protocol"',
    'printf \'%s\\n\' "$PWD" > "$FAKE_DIR/cwd"',
    'cat',
    'echo "fake ssh says hello" >&2',
    'exit 7',
  ].join('\n'));
  const request = ['SNOTRA-SSH 1', fields.dir ?? dir, ...['family', 'port', 'host', 'protocol', 'command'].map((k) => fields[k] ?? '')]
    .join('\n');
  const result = childProcess.spawnSync('/bin/sh', [LAUNCHER], {
    input: `${request}\n${stream}`,
    cwd: base,
    env: {
      PATH: envPath ?? process.env.PATH,
      FAKE_DIR: base,
      GIT_PROTOCOL: 'from-outside',
      GIT_SSH_COMMAND: gitSshCommand ?? `/bin/sh '${fakeSsh}' -o ProxyCommand='socat - PROXY:localhost:%h:%p'`,
    },
    encoding: 'utf8',
  });
  const read = (name) => fs.readFile(path.join(name.startsWith('/') ? '' : base, name), 'utf8').catch(() => null);
  return {
    base,
    result,
    argv: (await read('argv'))?.trimEnd().split('\n') ?? null,
    protocol: (await read('protocol'))?.trim() ?? null,
    cwd: (await read('cwd'))?.trim() ?? null,
    stderr: await read(path.join(dir, 'stderr')),
    status: (await read(path.join(dir, 'status')))?.trim() ?? null,
    cleanup: () => removeTempDir(base),
  };
}

const GOOD = {
  family: '',
  port: '2201',
  host: 'git@gitlab.example.com',
  protocol: 'version=2',
  command: "git-upload-pack '/team/app.git'",
};

test('the launcher runs the runtime\'s ssh with git\'s request and the stream, from /', posixOnly, async () => {
  const run = await launch(GOOD);
  try {
    assert.deepEqual(run.argv, [
      '-o', 'ProxyCommand=socat - PROXY:localhost:%h:%p',
      '-p', '2201', '-o', 'SendEnv=GIT_PROTOCOL', '--', 'git@gitlab.example.com', "git-upload-pack '/team/app.git'",
    ]);
    assert.equal(run.protocol, 'version=2');
    assert.equal(run.result.stdout, 'GIT STREAM\n', 'the stream after the request reaches ssh untouched');
    assert.equal(run.cwd, '/');
    assert.equal(run.stderr, 'fake ssh says hello\n');
    assert.equal(run.status, '7', 'ssh\'s exit status goes back to the client');
  } finally {
    await run.cleanup();
  }

  const plain = await launch({ ...GOOD, port: '', protocol: '', family: '-6' });
  try {
    assert.deepEqual(plain.argv.slice(2), ['-6', '--', 'git@gitlab.example.com', "git-upload-pack '/team/app.git'"]);
    assert.equal(plain.protocol, 'unset', 'no GIT_PROTOCOL the client did not send');
  } finally {
    await plain.cleanup();
  }
});

test('the launcher refuses anything but a host, a port and one of git\'s commands', posixOnly, async () => {
  const refusals = [
    [{ host: '-oProxyCommand=touch /tmp/pwned' }, /invalid host/],
    [{ host: 'gitlab.example.com -oProxyCommand=x' }, /invalid host/],
    [{ host: 'host;touch' }, /invalid host/],
    [{ host: '' }, /invalid host/],
    [{ port: '22 -oX' }, /invalid port/],
    [{ port: '123456' }, /invalid port/],
    [{ family: '-oX' }, /invalid address family/],
    [{ protocol: 'version=2 x' }, /invalid GIT_PROTOCOL/],
    [{ command: 'touch /tmp/pwned' }, /only git commands are relayed/],
    [{ command: "git-upload-packs '/x'" }, /only git commands are relayed/],
  ];
  for (const [change, message] of refusals) {
    const run = await launch({ ...GOOD, ...change });
    try {
      assert.equal(run.argv, null, `ssh was not started for ${JSON.stringify(change)}`);
      assert.match(run.stderr ?? '', message, JSON.stringify(change));
      assert.equal(run.status, '255');
      assert.equal(run.result.status, 255);
    } finally {
      await run.cleanup();
    }
  }
});

test('the launcher writes nowhere but a folder of the client\'s own shape', posixOnly, async () => {
  for (const options of [{ dirName: 'elsewhere' }, { dirName: 'snotra-ssh.short' }]) {
    const run = await launch(GOOD, options);
    try {
      assert.equal(run.result.status, 2);
      assert.equal(run.argv, null);
      assert.equal(run.status, null, 'nothing written');
    } finally {
      await run.cleanup();
    }
  }
  const relative = await launch({ ...GOOD, dir: 'tmp/snotra-ssh.AbC123' });
  try {
    assert.equal(relative.result.status, 2);
  } finally {
    await relative.cleanup();
  }
  const wrong = childProcess.spawnSync('/bin/sh', [LAUNCHER], { input: 'GET / HTTP/1.1\n\n', encoding: 'utf8' });
  assert.equal(wrong.status, 2, 'not a request at all');
});

test('the launcher finds programs on the absolute entries of PATH only', posixOnly, async () => {
  const run = await launch(GOOD, {
    envPath: `.:bin:${process.env.PATH}:relative/bin`,
    gitSshCommand: 'printf "%s\\n" "$PATH" >&2; false',
  });
  try {
    const seen = run.stderr.trim().split(':');
    assert.ok(seen.length > 0 && seen.every((entry) => entry.startsWith('/')), run.stderr);
  } finally {
    await run.cleanup();
  }
});

// ── The client ──────────────────────────────────────────────────────────────

test('the client passes on only what git itself sends', posixOnly, () => {
  const client = (args) => childProcess.spawnSync('/bin/sh', [CLIENT, ...args], { encoding: 'utf8' });
  const refusals = [
    [['-o', 'ProxyCommand=touch /tmp/x', 'host', "git-upload-pack '/x'"], /only Git's own options/],
    [['-i', '/tmp/key', 'host', "git-upload-pack '/x'"], /only Git's own options/],
    [['host'], /expected a host and a command/],
    [['host', 'git-upload-pack', 'extra'], /expected a host and a command/],
    [['ho\nst', "git-upload-pack '/x'"], /a line break/],
  ];
  for (const [args, message] of refusals) {
    const result = client(args);
    assert.equal(result.status, 255, JSON.stringify(args));
    assert.match(result.stderr, message, JSON.stringify(args));
  }
});

// ── The whole route, in the real Linux sandbox ─────────────────────────────

const REQUIRED = process.env.SNOTRA_REQUIRE_SANDBOX === '1';
const ON_CI_LINUX = process.platform === 'linux' && process.env.GITHUB_ACTIONS === 'true';

function sh(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr || result.error?.message}`);
  }
  return result.stdout;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function until(check, what, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function reachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** A run's stderr for an assertion message. */
function said(result) {
  return `exit ${result.exitCode}; stdout: ${String(result.stdout ?? '').trim() || '(empty)'}; `
    + `stderr: ${String(result.stderr ?? '').trim().slice(-3_000) || '(empty)'}`;
}

test('git signs in through the agent inside the Linux sandbox, and the key file stays unreadable (#1155)', async (t) => {
  if (process.platform !== 'linux') {
    t.skip('the relay is Linux only; macOS hands the run the agent socket (#932)');
    return;
  }
  if (!ON_CI_LINUX) {
    t.skip('writes a key and a known_hosts line into ~/.ssh: runs on the CI\'s Linux runner only');
    return;
  }

  const user = os.userInfo().username;
  const sshDir = path.join(os.userInfo().homedir, '.ssh');
  const key = path.join(sshDir, 'id_ed25519');
  const knownHosts = path.join(sshDir, 'known_hosts');
  assert.equal(existsSync(key), false, `${key} exists already; this test needs it for its own key`);

  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-ssh-route-'));
  const workspace = path.join(base, 'workspace');
  await fs.mkdir(workspace);
  const children = [];
  const savedKnownHosts = await fs.readFile(knownHosts, 'utf8').catch(() => null);
  const env = { ...process.env, SHELL: '/bin/sh' };
  let sandbox = null;
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    await sandbox?.shutdown();
    await fs.rm(key, { force: true });
    await fs.rm(`${key}.pub`, { force: true });
    if (savedKnownHosts === null) await fs.rm(knownHosts, { force: true });
    else await fs.writeFile(knownHosts, savedKnownHosts);
    await removeTempDir(base);
  });

  // The real sandbox, as shell_execute runs it.
  let shellRunner = null;
  sandbox = createSandboxService({
    os, path, fs, existsSync, env,
    spawn: childProcess.spawn,
    userDataPath: path.join(base, 'user-data'),
    readShellPath: async () => (await shellRunner.detect()).path || '',
  });
  shellRunner = createShellRunnerService({ spawn: childProcess.spawn, os, fs, path, sandbox, env });
  await shellRunner.detect();
  const described = await sandbox.detect();
  if (!described.isolated) {
    const why = `sandbox not available: ${described.reason} ${described.detail}`.trim();
    if (REQUIRED) assert.fail(why);
    t.skip(why);
    return;
  }

  // Snotra takes no bare `localhost` as a network domain, but a name under
  // `.localhost` (RFC 6761), which the runtime's proxy dials on loopback only.
  const host = 'snotra-git.localhost';
  const resolves = await dns.lookup(host).then(() => true, () => false);
  if (!resolves) sh('sudo', ['sh', '-c', `printf '127.0.0.1 ${host}\\n::1 ${host}\\n' >> /etc/hosts`]);

  // A local sshd, as this user, on a free port; the runner image may lack it.
  if (!existsSync('/usr/sbin/sshd')) sh('sudo', ['apt-get', 'install', '-y', 'openssh-server']);
  sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(base, 'host_key')]);
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 });
  sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key]);
  await fs.copyFile(`${key}.pub`, path.join(base, 'authorized_keys'));
  const port = await freePort();
  await fs.writeFile(path.join(base, 'sshd_config'), [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    'ListenAddress ::1',
    `HostKey ${path.join(base, 'host_key')}`,
    `AuthorizedKeysFile ${path.join(base, 'authorized_keys')}`,
    `PidFile ${path.join(base, 'sshd.pid')}`,
    'UsePAM no',
    'StrictModes no',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PubkeyAuthentication yes',
    'AcceptEnv GIT_PROTOCOL',
  ].join('\n'));
  const sshd = childProcess.spawn('/usr/sbin/sshd', ['-D', '-e', '-f', path.join(base, 'sshd_config')], { stdio: 'ignore' });
  children.push(sshd);
  await until(() => reachable(port), 'sshd');
  const hostKey = (await fs.readFile(path.join(base, 'host_key.pub'), 'utf8')).split(' ').slice(0, 2).join(' ');
  await fs.appendFile(knownHosts, `${savedKnownHosts && !savedKnownHosts.endsWith('\n') ? '\n' : ''}[${host}]:${port} ${hostKey}\n`);

  // An ssh-agent holding the key.
  const agentSocket = path.join(base, 'agent.sock');
  const agent = childProcess.spawn('ssh-agent', ['-D', '-a', agentSocket], { stdio: 'ignore' });
  children.push(agent);
  await until(() => existsSync(agentSocket), 'the ssh-agent');
  sh('ssh-add', ['-q', key], { env: { ...process.env, SSH_AUTH_SOCK: agentSocket } });

  // A repository with one branch, reached by SSH.
  const repo = path.join(base, 'repo.git');
  sh('git', ['init', '-q', '--bare', repo]);
  const work = path.join(base, 'work');
  sh('git', ['init', '-q', work]);
  sh('git', ['-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init']);
  sh('git', ['-C', work, 'push', '-q', repo, 'HEAD:refs/heads/main']);
  const head = sh('git', ['-C', work, 'rev-parse', 'HEAD']).trim();

  const run = (command, extra = {}) => shellRunner.run({
    command, cwd: workspace, workspaceRoot: workspace, networkDomains: [host], timeoutMs: 60_000, ...extra,
  });
  const lsRemote = `git ls-remote ssh://${user}@${host}:${port}${repo}`;
  env.SSH_AUTH_SOCK = agentSocket;

  const signedIn = await run(lsRemote);
  assert.equal(signedIn.exitCode, 0, said(signedIn));
  assert.match(signedIn.stdout, new RegExp(`^${head}\\trefs/heads/main$`, 'm'), said(signedIn));
  assert.equal(signedIn.sandboxBlocked, undefined, said(signedIn));

  // The key file stays closed to the run; the public half is open, as on macOS.
  const privateKey = await run(`cat '${key}'`);
  assert.notEqual(privateKey.exitCode, 0, said(privateKey));
  assert.doesNotMatch(privateKey.stdout, /PRIVATE KEY/);
  const publicKey = await run(`cat '${key}.pub'`);
  assert.equal(publicKey.exitCode, 0, said(publicKey));
  // The run itself still cannot reach the agent: the seccomp filter stays on.
  const agentFromRun = await run('ssh-add -l');
  assert.notEqual(agentFromRun.exitCode, 0, said(agentFromRun));
  // Nor any other local socket, such as Docker's: still refused at socket().
  let dockerReached = false;
  const dockerSocket = path.join(base, 'docker.sock');
  const docker = net.createServer((socket) => { dockerReached = true; socket.end('pong\n'); });
  await new Promise((resolve) => docker.listen(dockerSocket, resolve));
  t.after(() => new Promise((resolve) => docker.close(resolve)));
  const dockerFromRun = await run(`socat - UNIX-CONNECT:'${dockerSocket}' </dev/null`);
  assert.notEqual(dockerFromRun.exitCode, 0, said(dockerFromRun));
  assert.doesNotMatch(dockerFromRun.stdout, /pong/);
  assert.match(dockerFromRun.stderr, /Operation not permitted|Permission denied/, said(dockerFromRun));
  const pythonFromRun = await run(`python3 -c "import socket; s = socket.socket(socket.AF_UNIX); s.connect('${dockerSocket}'); print(s.recv(9))"`);
  assert.notEqual(pythonFromRun.exitCode, 0, said(pythonFromRun));
  assert.equal(dockerReached, false, 'nothing in the run reached the socket');
  // And the relay runs git's commands only.
  const other = await run(`/bin/sh "$SNOTRA_SSH_CLIENT" -p ${port} ${user}@${host} 'touch /tmp/snotra-relay-pwned'`);
  assert.equal(other.exitCode, 255, said(other));
  assert.match(other.stderr, /only git commands are relayed/, said(other));
  assert.equal(existsSync('/tmp/snotra-relay-pwned'), false);

  // Without the agent the same key file would sign in — if ssh could read it.
  delete env.SSH_AUTH_SOCK;
  const noAgent = await run(lsRemote);
  assert.notEqual(noAgent.exitCode, 0, said(noAgent));
  assert.match(noAgent.stderr, /Permission denied \(publickey/, said(noAgent));
  assert.match(noAgent.stderr, /<sandbox_ssh>[^]*SSH_AUTH_SOCK is not set/, said(noAgent));

  // A host that is not in known_hosts gets its note.
  env.SSH_AUTH_SOCK = agentSocket;
  if (savedKnownHosts === null) await fs.rm(knownHosts, { force: true });
  else await fs.writeFile(knownHosts, savedKnownHosts);
  // Through the relay, and it fails at once: the run ends with ssh, no timeout.
  const unknownHost = await run(lsRemote);
  assert.notEqual(unknownHost.exitCode, null, `the run hung; ${said(unknownHost)}`);
  assert.notEqual(unknownHost.exitCode, 0, said(unknownHost));
  assert.match(unknownHost.stderr, /Host key verification failed[^]*<sandbox_ssh>[^]*known_hosts/, said(unknownHost));
});
