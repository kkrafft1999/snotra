// Sandbox service (#329) against a fake sandbox-runtime: detection, the
// self-test, the domain gate and what one run is configured with. The real
// runtime is exercised in sandbox-isolation.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const {
  createSandboxService,
  createDomainGate,
  quoteArgv,
  parsePipVersion,
  needsLegacyCerts,
  unpackedPath,
  missingPackages,
  sensitiveReadPaths,
  annotateBlockedTrustd,
  SANDBOX_REASONS,
} = require('../src/main/services/sandbox-service');
const { normalizeDomains, suggestDomains, resolveNetworkDomains } = require('../src/shared/runtime/sandbox-domains');

const posixOnly = { skip: process.platform === 'win32' ? 'needs /bin/sh' : false };

/**
 * A stand-in for the runtime. `wrap` decides what a command turns into; by
 * default the "sandbox" lets the allowed write through and refuses the one
 * outside, like the real thing.
 */
function fakeRuntime({ errors = [], wrap, initialize, proxyPort } = {}) {
  const calls = { updateConfig: [], wrap: [], cleanup: 0, reset: 0, initialize: 0 };
  const runtime = {
    SandboxManager: {
      checkDependencies: () => ({ errors, warnings: [] }),
      async initialize(config) {
        calls.initialize += 1;
        if (initialize) await initialize(config);
      },
      updateConfig(config) { calls.updateConfig.push(config); },
      async wrapWithSandbox(command, shell, custom, signal, options) {
        calls.wrap.push({ command, shell, options });
        if (wrap) return wrap(command);
        return command.includes('/outside/') ? 'exit 1' : command;
      },
      annotateStderrWithSandboxFailures: (key, stderr) => `${stderr}[annotated:${key}]`,
      getProxyPort: () => proxyPort,
      cleanupAfterCommand() { calls.cleanup += 1; },
      async reset() { calls.reset += 1; },
    },
  };
  return { runtime, calls };
}

function makeService(overrides = {}) {
  const { runtime, calls } = fakeRuntime(overrides.fake);
  let loaded = 0;
  const service = createSandboxService({
    platform: 'linux',
    os,
    path,
    fs,
    spawn: childProcess.spawn,
    loadRuntime: () => { loaded += 1; return runtime; },
    userDataPath: '/home/u/.config/Snotra AI',
    ...overrides.deps,
  });
  return { service, calls, loaded: () => loaded };
}

// ── Domains ─────────────────────────────────────────────────────────────────

test('domains are normalised: host names only, no IP literals, no wildcards for everything', () => {
  assert.deepEqual(
    normalizeDomains(['PyPI.org', 'https://api.github.com/repos', '10.0.0.1', '*', '*.example.dev:8443', 'pypi.org', 42, '']),
    ['pypi.org', 'api.github.com', '*.example.dev:8443'],
  );
  assert.deepEqual(normalizeDomains('pypi.org'), []);
});

test('package installs bring their registries, other commands nothing', () => {
  assert.deepEqual(suggestDomains('python3 -m pip install requests'), ['pypi.org', 'files.pythonhosted.org']);
  assert.deepEqual(suggestDomains('npm ci && npm test'), ['registry.npmjs.org']);
  assert.deepEqual(suggestDomains('uv sync'), ['pypi.org', 'files.pythonhosted.org']);
  assert.deepEqual(suggestDomains('git status'), []);
  assert.deepEqual(suggestDomains('echo "pip is a word"'), []);
});

test('the domains of a call: declared plus suggested for the shell, declared only for Python', () => {
  assert.deepEqual(
    resolveNetworkDomains('shell_execute', { command: 'pip install x', network_domains: ['pypi.org', 'api.github.com'] }),
    ['pypi.org', 'api.github.com', 'files.pythonhosted.org'],
  );
  assert.deepEqual(resolveNetworkDomains('run_python', { code: 'pip install x' }), []);
});

// ── Helpers ─────────────────────────────────────────────────────────────────

test('quoteArgv survives the trip through sh -c', posixOnly, async () => {
  const argv = ['printf', '%s|', 'plain', "it's", 'with space', '$HOME', '`id`', 'a"b'];
  const out = childProcess.execFileSync('/bin/sh', ['-c', quoteArgv(argv)], { encoding: 'utf8' });
  assert.equal(out, "plain|it's|with space|$HOME|`id`|a\"b|");
});

test('pip needs the certifi fallback from 24.2 on, older pip must not get it', () => {
  assert.deepEqual(parsePipVersion('pip 24.2 from /x (python 3.12)'), [24, 2]);
  assert.equal(parsePipVersion('no pip here'), null);
  assert.equal(needsLegacyCerts([24, 2]), true);
  assert.equal(needsLegacyCerts([26, 0]), true);
  assert.equal(needsLegacyCerts([24, 1]), false);
  assert.equal(needsLegacyCerts([21, 3]), false);
  assert.equal(needsLegacyCerts(null), false);
});

test('vendored helpers are pointed out of app.asar when the unpacked copy exists', () => {
  const inside = '/Applications/Snotra AI.app/Contents/Resources/app.asar/node_modules/x/vendor/a.jar';
  const unpacked = '/Applications/Snotra AI.app/Contents/Resources/app.asar.unpacked/node_modules/x/vendor/a.jar';
  assert.equal(unpackedPath(inside, (p) => p === unpacked), unpacked);
  assert.equal(unpackedPath(inside, () => false), inside);
  assert.equal(unpackedPath('/dev/node_modules/x/a.jar', () => true), '/dev/node_modules/x/a.jar');
});

test('dependency errors are named as the distributions name the packages', () => {
  assert.deepEqual(
    missingPackages(['ripgrep (rg) not found', 'bubblewrap (bwrap) not installed', 'socat not installed']),
    ['bubblewrap', 'socat', 'ripgrep'],
  );
  assert.deepEqual(missingPackages(['something else']), []);
});

test('credential stores and Snotra’s own storage are not readable', () => {
  const mac = sensitiveReadPaths({ platform: 'darwin', userDataPath: '/Users/u/Library/Application Support/Snotra AI' });
  const linux = sensitiveReadPaths({ platform: 'linux' });
  for (const entry of ['~/.ssh', '~/.aws', '~/.gnupg', '~/.config/gcloud', '~/.npmrc']) {
    assert.ok(mac.includes(entry) && linux.includes(entry), entry);
  }
  assert.ok(mac.includes('~/Library/Keychains'));
  assert.ok(mac.includes('/Users/u/Library/Application Support/Snotra AI'));
  assert.ok(linux.includes('~/.mozilla'));
  assert.ok(!linux.includes('~/Library/Keychains'));
});

// ── Domain gate ─────────────────────────────────────────────────────────────

test('runs with the same domain set share the gate, a different set waits', async () => {
  const gate = createDomainGate();
  const a = await gate.acquire('');
  const b = await gate.acquire('');
  let cGranted = false;
  const c = gate.acquire('pypi.org').then((release) => { cGranted = true; return release; });

  await new Promise((r) => setImmediate(r));
  assert.equal(cGranted, false);
  a();
  await new Promise((r) => setImmediate(r));
  assert.equal(cGranted, false, 'one run with the old set is still active');
  b();
  const releaseC = await c;
  assert.equal(cGranted, true);
  releaseC();
  assert.deepEqual(gate.snapshot(), { activeKey: null, active: 0, waiting: 0 });
});

test('the gate is FIFO: a waiting run is not overtaken by later runs of the active set', async () => {
  const gate = createDomainGate();
  const order = [];
  const first = await gate.acquire('');
  const waiting = gate.acquire('x').then((r) => { order.push('x'); return r; });
  const late = gate.acquire('').then((r) => { order.push('late'); return r; });

  first();
  (await waiting)();
  (await late)();
  assert.deepEqual(order, ['x', 'late']);
});

test('"Stop" while waiting leaves the queue and rejects with an AbortError', async () => {
  const gate = createDomainGate();
  const release = await gate.acquire('');
  const controller = new AbortController();
  const pending = gate.acquire('other', controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  release();
  assert.deepEqual(gate.snapshot(), { activeKey: null, active: 0, waiting: 0 });
  // Releasing twice must not drive the count negative.
  release();
  assert.equal(gate.snapshot().active, 0);
});

// ── Detection ───────────────────────────────────────────────────────────────

test('Windows is not isolated, and the runtime is not even loaded', async () => {
  const { service, loaded } = makeService({ deps: { platform: 'win32' } });
  const described = await service.detect();

  assert.equal(described.isolated, false);
  assert.equal(described.reason, SANDBOX_REASONS.PLATFORM);
  assert.equal(loaded(), 0);
  assert.equal(await service.prepare({ command: 'dir', runTmp: 'C:\\tmp' }), null);
});

test('missing Linux packages are reported by name', async () => {
  const { service, calls } = makeService({
    fake: { errors: ['bubblewrap (bwrap) not installed', 'socat not installed'] },
  });
  const described = await service.detect();

  assert.equal(described.isolated, false);
  assert.equal(described.reason, SANDBOX_REASONS.DEPENDENCIES);
  assert.deepEqual(described.missing, ['bubblewrap', 'socat']);
  assert.equal(calls.initialize, 0);
});

test('a runtime that cannot be loaded or started falls back visibly', async () => {
  const broken = createSandboxService({
    platform: 'linux', os, path, fs, spawn: childProcess.spawn,
    loadRuntime: () => { throw new Error('Cannot find module'); },
  });
  assert.equal((await broken.detect()).reason, SANDBOX_REASONS.START);

  const { service } = makeService({ fake: { initialize: async () => { throw new Error('proxy failed'); } } });
  const described = await service.detect();
  assert.equal(described.reason, SANDBOX_REASONS.START);
  assert.match(described.detail, /proxy failed/);
});

test('the self-test decides: a working sandbox is isolated', posixOnly, async () => {
  const { service, calls } = makeService();
  const described = await service.detect();

  assert.equal(described.isolated, true);
  assert.equal(described.status, 'isolated');
  assert.equal(calls.initialize, 1);
  // Both halves ran through the sandbox, and each released its gate.
  assert.equal(calls.wrap.length, 2);
  assert.equal(calls.cleanup, 2);
});

test('a sandbox in which nothing runs is not isolated — Ubuntu 24.04 as shipped', posixOnly, async () => {
  const { service, calls } = makeService({ fake: { wrap: () => 'echo "bwrap: loopback: Failed RTM_NEWADDR" >&2; exit 1' } });
  const described = await service.detect();

  assert.equal(described.isolated, false);
  assert.equal(described.reason, SANDBOX_REASONS.SELF_TEST);
  assert.match(described.detail, /RTM_NEWADDR/);
  assert.equal(calls.reset, 1);
});

test('a sandbox that lets the forbidden write through is not isolated either', posixOnly, async () => {
  const { service } = makeService({ fake: { wrap: (command) => command } });
  const described = await service.detect();

  assert.equal(described.isolated, false);
  assert.equal(described.reason, SANDBOX_REASONS.SELF_TEST);
  assert.match(described.detail, /not refused/);
});

test('detection runs once per app start', posixOnly, async () => {
  const { service, calls } = makeService();
  await Promise.all([service.detect(), service.detect()]);
  await service.detect();
  assert.equal(calls.initialize, 1);
});

// ── One run ─────────────────────────────────────────────────────────────────

test('a run may write to the workspace and its temp dir and reach only its domains', posixOnly, async () => {
  const { service, calls } = makeService();
  await service.detect();
  calls.updateConfig.length = 0;

  const prepared = await service.prepare({
    command: 'git status',
    workspaceRoot: '/home/u/project',
    runTmp: '/tmp/snotra-sh-1',
    allowedDomains: ['PyPI.org', '127.0.0.1'],
    commandId: 'shell-1',
    commandText: 'git status',
  });

  const config = calls.updateConfig[0];
  assert.deepEqual(config.network, { allowedDomains: ['pypi.org'], deniedDomains: [] });
  assert.deepEqual(config.filesystem.allowWrite, ['/home/u/project', '/tmp/snotra-sh-1']);
  assert.ok(config.filesystem.denyRead.includes('~/.ssh'));
  assert.ok(config.filesystem.denyRead.includes('/home/u/.config/Snotra AI'));
  assert.ok(config.filesystem.denyWrite.includes('/tmp/claude'));

  assert.equal(prepared.command, '/bin/sh');
  // TMPDIR is set inside: the runtime would point it at its shared /tmp/claude.
  assert.deepEqual(prepared.args, ['-c', 'export TMPDIR=/tmp/snotra-sh-1; git status']);
  assert.deepEqual(prepared.domains, ['pypi.org']);
  assert.equal('TMPDIR' in prepared.env, false);
  assert.equal(prepared.env.PIP_CACHE_DIR, path.join('/tmp/snotra-sh-1', 'cache', 'pip'));
  assert.equal(prepared.env.npm_config_cache, path.join('/tmp/snotra-sh-1', 'cache', 'npm'));
  assert.equal('PIP_USE_DEPRECATED' in prepared.env, false, 'Linux never needs the certifi fallback');
  assert.deepEqual(calls.wrap.at(-1).options, { commandId: 'shell-1', commandText: 'git status' });
  assert.equal(prepared.annotate('denied'), 'denied[annotated:shell-1]');

  const before = calls.cleanup;
  prepared.release();
  prepared.release();
  assert.equal(calls.cleanup, before + 1, 'release is idempotent');
});

test('a proxy the command could not reach is named as a sandbox problem (#368)', posixOnly, async () => {
  const { service } = makeService({ fake: { proxyPort: 49737 } });
  await service.detect();
  const prepared = await service.prepare({ command: 'curl https://example.com', runTmp: '/tmp/r', commandId: 'shell-2' });
  const note = /<sandbox_network>\nThe sandbox's network proxy on localhost:49737 did not accept the connection/;

  const curl = prepared.annotate("curl: (7) Failed to connect to localhost port 49737 after 0 ms: Couldn't connect to server\n");
  assert.match(curl, /^curl: \(7\).*\n\[annotated:shell-2\]\n\n<sandbox_network>/s, 'after the runtime’s own annotation');
  assert.match(curl, note);
  assert.match(prepared.annotate("ProxyError('Unable to connect to proxy', NewConnectionError('[Errno 61] Connection refused'))"), note);
  assert.equal(prepared.annotate(curl), `${curl}[annotated:shell-2]`, 'never twice');

  for (const other of [
    'curl: (7) Failed to connect to localhost port 8080 after 0 ms: Couldn\'t connect to server',
    'curl: (56) CONNECT tunnel failed, response 403',
    'listening on 49737',
    '',
  ]) {
    assert.doesNotMatch(prepared.annotate(other), /sandbox_network/, other);
  }
  prepared.release();
});

test('without a proxy port nothing is added', posixOnly, async () => {
  const { service } = makeService();
  await service.detect();
  const prepared = await service.prepare({ command: 'true', runTmp: '/tmp/r', commandId: 'shell-3' });
  assert.equal(prepared.annotate('Unable to connect to proxy'), 'Unable to connect to proxy[annotated:shell-3]');
  prepared.release();
});

test('without a workspace only the run’s temp dir is writable', posixOnly, async () => {
  const { service, calls } = makeService();
  await service.detect();
  const prepared = await service.prepare({ command: 'true', runTmp: '/tmp/snotra-py-1' });
  assert.deepEqual(calls.updateConfig.at(-1).filesystem.allowWrite, ['/tmp/snotra-py-1']);
  prepared.release();
});

test('on macOS a pip from 24.2 on gets the certifi fallback, an older one does not', posixOnly, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fake-python-'));
  const fakePython = async (version) => {
    const file = path.join(dir, `python-${version}`);
    await fs.writeFile(file, `#!/bin/sh\necho "pip ${version} from /x (python 3.12)"\n`, { mode: 0o755 });
    return file;
  };
  try {
    const modern = makeService({ deps: { platform: 'darwin', readPythonCommand: async () => fakePython('25.1') } });
    const old = makeService({ deps: { platform: 'darwin', readPythonCommand: async () => fakePython('23.0') } });
    assert.equal((await modern.service.detect()).pipLegacyCerts, true);
    assert.equal((await old.service.detect()).pipLegacyCerts, false);

    const prepared = await modern.service.prepare({ command: 'pip install x', runTmp: '/tmp/r' });
    assert.equal(prepared.env.PIP_USE_DEPRECATED, 'legacy-certs');
    prepared.release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ── Program allowances (#408) ───────────────────────────────────────────────

test('a program allowance adds its folders to the writable ones, trustd stays closed off macOS', posixOnly, async () => {
  const { service, calls } = makeService();
  await service.detect();
  const prepared = await service.prepare({
    command: '/opt/bin/tool lists',
    workspaceRoot: '/home/u/project',
    runTmp: '/tmp/snotra-sh-2',
    allowedDomains: ['graph.microsoft.com'],
    extraWritePaths: ['/home/u/.cache/tool', '/home/u/project'],
    weakerNetworkIsolation: true,
  });
  const config = calls.updateConfig.at(-1);
  assert.deepEqual(config.filesystem.allowWrite, ['/home/u/project', '/tmp/snotra-sh-2', '/home/u/.cache/tool']);
  assert.equal('enableWeakerNetworkIsolation' in config, false, 'Linux has no trust service to open');
  assert.deepEqual(prepared.writePaths, ['/home/u/.cache/tool']);
  assert.equal(prepared.trustd, false);
  prepared.release();
});

test('on macOS trustd opens only for a run whose allowance asks for it, and a blocked check is explained', posixOnly, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-fake-python-'));
  const python = path.join(dir, 'python');
  await fs.writeFile(python, '#!/bin/sh\necho "pip 23.0 from /x (python 3.12)"\n', { mode: 0o755 });
  try {
    const { service, calls } = makeService({ deps: { platform: 'darwin', readPythonCommand: async () => python } });
    await service.detect();
    const tls = 'Get "https://login.microsoftonline.com/x": tls: failed to verify certificate: x509: OSStatus -26276';

    const open = await service.prepare({ command: 'tool', runTmp: '/tmp/r1', weakerNetworkIsolation: true });
    assert.equal(calls.updateConfig.at(-1).enableWeakerNetworkIsolation, true);
    assert.equal(open.trustd, true);
    assert.doesNotMatch(open.annotate(tls), /sandbox_certificates/);
    open.release();

    const closed = await service.prepare({ command: 'tool', runTmp: '/tmp/r2' });
    assert.equal('enableWeakerNetworkIsolation' in calls.updateConfig.at(-1), false);
    assert.equal(closed.trustd, false);
    const annotated = closed.annotate(tls);
    assert.match(annotated, /<sandbox_certificates>/);
    assert.match(annotated, /Program allowances/);
    closed.release();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('the trustd note only answers Go\'s blocked certificate check, and only once', () => {
  assert.equal(annotateBlockedTrustd('curl: (60) SSL certificate problem'), 'curl: (60) SSL certificate problem');
  const once = annotateBlockedTrustd('x509: OSStatus -26276');
  assert.match(once, /^x509: OSStatus -26276\n\n<sandbox_certificates>\n/);
  assert.equal(annotateBlockedTrustd(once), once);
});

test('an unavailable sandbox prepares nothing — the runner falls back', async () => {
  const { service } = makeService({ fake: { errors: ['socat not installed'] } });
  assert.equal(await service.prepare({ command: 'ls', runTmp: '/tmp/x' }), null);
  assert.equal(service.isAvailable(), false);
});
