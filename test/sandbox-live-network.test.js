// A connection that waits for the user while its command runs (#792, step 3):
// which run it belongs to, one question at a time, what a card may offer,
// and what happens when the command stops waiting. Against a stand-in for
// the runtime; the real proxy is exercised in sandbox-isolation.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const {
  createSandboxService,
  createLiveRun,
  networkGrantOptions,
  grantedHosts,
  matchesHostPattern,
} = require('../src/main/services/sandbox-service');
const { parseViolationLine, widerHost, describeForModel, NETWORK_REASONS } = require('../src/main/services/sandbox-violations');
const { createToolApprovalRequestDto } = require('../src/shared/contracts/tool-permissions');
const { normalizeSandboxLive } = require('../src/shared/contracts/chat');
const { toolTraceEntryForStore } = require('../src/main/services/chat-history-normalization');
const { patchSandboxRuntime, managerPath, PATCHED } = require('../scripts/patch-sandbox-runtime');

const posixOnly = { skip: process.platform === 'win32' ? 'needs /bin/sh' : false };

/** The command key as the runtime puts it into the proxy credentials. */
const encode = (key) => Buffer.from(String(key).slice(0, 100)).toString('base64');

/**
 * A stand-in for the runtime that keeps the ask callback, and a violation
 * store the service listens to, like the real one.
 */
function fakeRuntime() {
  const calls = { ask: null, configs: [] };
  const listeners = new Set();
  const list = [];
  let total = 0;
  const store = {
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getTotalCount: () => total,
    add(line, key) {
      total += 1;
      list.push({ line, encodedCommand: key === undefined ? undefined : encode(key) });
      for (const fn of [...listeners]) fn(list.slice(-100));
    },
  };
  const runtime = {
    SandboxManager: {
      checkDependencies: () => ({ errors: [], warnings: [] }),
      async initialize(config, ask) { calls.ask = ask; },
      getSandboxViolationStore: () => store,
      updateConfig(config) { calls.configs.push(config); },
      async wrapWithSandbox(command) { return command.includes('/outside/') ? 'exit 1' : command; },
      annotateStderrWithSandboxFailures: (key, stderr) => stderr,
      getProxyPort: () => undefined,
      cleanupAfterCommand() {},
      async reset() {},
    },
  };
  return { runtime, calls, store };
}

async function makeService() {
  const fake = fakeRuntime();
  const service = createSandboxService({
    platform: 'linux',
    os,
    path,
    fs,
    spawn: childProcess.spawn,
    loadRuntime: () => fake.runtime,
    userDataPath: '/home/u/.config/Snotra AI',
  });
  await service.detect();
  return { service, ...fake };
}

/**
 * What the runtime's proxy does with a connection that matches no rule: ask,
 * and record a refusal under the command's key — "user denied" for a no,
 * "permission prompt failed" when the callback throws.
 */
async function connect({ calls, store }, { host, port = 443, key }) {
  try {
    const allowed = await calls.ask({ host, port, encodedCommand: key === undefined ? undefined : encode(key) });
    if (!allowed) store.add(`deny network-outbound ${host}:${port} (user denied)`, key);
    return allowed;
  } catch {
    store.add(`deny network-outbound ${host}:${port} (permission prompt failed)`, key);
    return false;
  }
}

async function prepareRun(service, base, extra = {}) {
  const runTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-live-'));
  const prepared = await service.prepare({ command: 'pip install torch', workspaceRoot: base, runTmp, ...extra });
  return { prepared, cleanup: () => fs.rm(runTmp, { recursive: true, force: true }) };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ── What a card may offer ───────────────────────────────────────────────────

test('a connection is offered as its host and port, and its whole domain where that is one program\'s', () => {
  assert.deepEqual(networkGrantOptions('download.pytorch.org', 443), ['download.pytorch.org:443', '*.pytorch.org']);
  assert.deepEqual(networkGrantOptions('PyPI.org', 443), ['pypi.org:443'], '*.org is nobody\'s domain');
  assert.deepEqual(networkGrantOptions('bucket.s3.amazonaws.com', 443), ['bucket.s3.amazonaws.com:443']);
  assert.deepEqual(networkGrantOptions('www.bbc.co.uk', 443), ['www.bbc.co.uk:443', '*.bbc.co.uk']);
  assert.deepEqual(networkGrantOptions('news.co.uk', 443), ['news.co.uk:443'], 'co.uk is a country\'s second level');
  assert.deepEqual(networkGrantOptions('10.0.0.5', 8080), ['10.0.0.5:8080'], 'an address the card shows as it is');
  assert.deepEqual(networkGrantOptions('::1', 80), [], 'not a host Snotra can name');
  assert.deepEqual(networkGrantOptions('example.com', 0), []);
});

test('widerHost: one level up, never a top-level domain or a shared platform', () => {
  assert.equal(widerHost('a.b.example.com'), '*.b.example.com');
  assert.equal(widerHost('example.com'), null);
  assert.equal(widerHost('user.github.io'), null);
  assert.equal(widerHost('objects.githubusercontent.com'), null);
  assert.equal(widerHost('1.2.3.4'), null);
});

test('only hosts a card can offer reach a run — whatever else the list holds', () => {
  assert.deepEqual(
    grantedHosts(['download.pytorch.org:443', '*.pytorch.org', 'PyPI.org:443', '1.2.3.4:80',
      '*.org', '*.amazonaws.com', '*.co.uk', '*', 'evil', 'a b.com', 42, 'pypi.org:443']),
    ['download.pytorch.org:443', '*.pytorch.org', 'pypi.org:443', '1.2.3.4:80'],
  );
});

test('a host pattern matches the host, its port, and a wildcard the hosts below it', () => {
  assert.equal(matchesHostPattern('pypi.org:443', 'pypi.org', 443), true);
  assert.equal(matchesHostPattern('pypi.org:443', 'pypi.org', 80), false);
  assert.equal(matchesHostPattern('*.pytorch.org', 'download.pytorch.org', 8443), true);
  assert.equal(matchesHostPattern('*.pytorch.org', 'pytorch.org', 443), false);
  assert.equal(matchesHostPattern('*.pytorch.org', 'evilpytorch.org', 443), false);
});

test('a connection nobody could be asked about reads as a host outside the run\'s domains', () => {
  assert.deepEqual(parseViolationLine('deny network-outbound pypi.org:443 (permission prompt failed)'), {
    kind: 'network', target: 'pypi.org:443', operation: 'network-outbound', reason: NETWORK_REASONS.NOT_ALLOWED,
  });
  assert.equal(parseViolationLine('deny network-outbound pypi.org:443 (user denied)').reason, NETWORK_REASONS.USER_DENIED);
});

test('the model is not pointed to network_domains for a host the user turned down', () => {
  const note = (reason) => describeForModel({
    entries: [{ kind: 'network', target: 'evil.example.com:443', count: 1, operations: [], reason }],
    moreEntries: 0,
    total: 1,
    raw: [],
  });
  assert.match(note(NETWORK_REASONS.NOT_ALLOWED), /network_domains of a new call/);
  assert.doesNotMatch(note(NETWORK_REASONS.USER_DENIED), /network_domains of a new call/);
});

// ── One run, one question at a time ─────────────────────────────────────────

test('one question per host at a time; an answer that covers the next host saves its question', async () => {
  const asked = [];
  let answer;
  const run = createLiveRun({
    key: 'k',
    domains: ['pypi.org'],
    onNetworkAsk: (request) => {
      asked.push(request);
      return new Promise((resolve) => { answer = resolve; });
    },
  });
  const first = run.ask('download.pytorch.org', 443);
  const again = run.ask('download.pytorch.org', 443);
  const other = run.ask('cdn.pytorch.org', 443);
  await tick();
  assert.equal(asked.length, 1, 'the same host is one question, the next one waits');
  assert.deepEqual(
    { target: asked[0].target, allow: asked[0].allow, domains: asked[0].domains },
    { target: 'download.pytorch.org:443', allow: ['download.pytorch.org:443', '*.pytorch.org'], domains: ['pypi.org'] },
  );
  answer({ outcome: 'allowed', pattern: '*.pytorch.org' });
  assert.deepEqual(await Promise.all([first, again, other]), [true, true, true]);
  assert.equal(asked.length, 1, 'the wildcard covered the second host');
  assert.equal(await run.ask('files.pytorch.org', 8443), true, 'and every later one of the domain');
});

test('after a denial nothing more is asked: the user said no to this command', async () => {
  const asked = [];
  const run = createLiveRun({
    key: 'k',
    onNetworkAsk: async (request) => { asked.push(request.target); return { outcome: 'denied' }; },
  });
  assert.equal(await run.ask('a.example.com', 443), false);
  assert.equal(await run.ask('b.example.com', 443), false);
  assert.deepEqual(asked, ['a.example.com:443']);
});

test('an answer outside what was offered opens the first offer', async () => {
  const asked = [];
  const run = createLiveRun({
    key: 'k',
    onNetworkAsk: async (r) => { asked.push(r.target); return { outcome: 'allowed', pattern: '*' }; },
  });
  assert.equal(await run.ask('download.pytorch.org', 443), true);
  assert.equal(await run.ask('other.pytorch.org', 443), true);
  assert.deepEqual(asked, ['download.pytorch.org:443', 'other.pytorch.org:443'],
    'only the exact host was opened, so the next host is a question of its own');
});

test('the question carries what the command printed so far and how long the connection has waited', async () => {
  let request;
  const run = createLiveRun({
    key: 'k',
    readOutput: () => ({ stdout: 'Collecting torch', stderr: '' }),
    onNetworkAsk: async (r) => { request = r; return { outcome: 'denied' }; },
  });
  await run.ask('download.pytorch.org', 443);
  assert.equal(request.stdout, 'Collecting torch');
  assert.ok(Number.isFinite(request.waitedMs) && request.waitedMs >= 0);
});

test('when the command stops waiting, the open question ends — even with a handler that does not listen', async () => {
  let signal;
  const run = createLiveRun({
    key: 'k',
    onNetworkAsk: (request, options) => { signal = options.signal; return new Promise(() => {}); },
  });
  const waiting = run.ask('download.pytorch.org', 443);
  await tick();
  await run.close();
  assert.equal(signal.aborted, true);
  await assert.rejects(waiting);
  await assert.rejects(run.ask('other.example.com', 443), 'a closed run asks nothing more');
});

test('a run nobody can be asked for refuses at once', async () => {
  const run = createLiveRun({ key: 'k' });
  await assert.rejects(run.ask('pypi.org', 443));
});

// ── The service: who a connection belongs to ────────────────────────────────

test('the runtime gets the ask callback, and a connection goes to the run that opened it', posixOnly, async () => {
  const fake = await makeService();
  assert.equal(typeof fake.calls.ask, 'function');
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-live-ws-'));
  const askedA = [];
  const askedB = [];
  const a = await prepareRun(fake.service, base, {
    commandId: 'shell-a',
    onNetworkAsk: async (r) => { askedA.push(r.target); return { outcome: 'allowed', pattern: r.allow[0] }; },
  });
  const b = await prepareRun(fake.service, base, {
    commandId: 'shell-b',
    onNetworkAsk: async (r) => { askedB.push(r.target); return { outcome: 'denied' }; },
  });
  try {
    assert.equal(await connect(fake, { host: 'download.pytorch.org', key: 'shell-b' }), false);
    assert.equal(await connect(fake, { host: 'Download.PyTorch.org', key: 'shell-a' }), true);
    assert.deepEqual(askedA, ['download.pytorch.org:443']);
    assert.deepEqual(askedB, ['download.pytorch.org:443']);
  } finally {
    a.prepared.release();
    b.prepared.release();
    await a.cleanup();
    await b.cleanup();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('without a command key, or for a command that has ended, nobody is asked', posixOnly, async () => {
  const fake = await makeService();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-live-ws-'));
  const asked = [];
  const run = await prepareRun(fake.service, base, {
    commandId: 'shell-c',
    onNetworkAsk: async (r) => { asked.push(r.target); return { outcome: 'allowed' }; },
  });
  try {
    assert.equal(await connect(fake, { host: 'pypi.org' }), false, 'no key — an unpatched runtime');
    assert.equal(await connect(fake, { host: 'pypi.org', key: 'shell-unknown' }), false);
    run.prepared.release();
    assert.equal(await connect(fake, { host: 'pypi.org', key: 'shell-c' }), false, 'released');
    assert.deepEqual(asked, []);
  } finally {
    run.prepared.release();
    await run.cleanup();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('a connection still waiting when the command ends is refused, and offered on the card after the run', posixOnly, async () => {
  const fake = await makeService();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-live-ws-'));
  let signal;
  const run = await prepareRun(fake.service, base, {
    commandId: 'shell-d',
    onNetworkAsk: (r, options) => new Promise((resolve) => {
      signal = options.signal;
      signal.addEventListener('abort', () => resolve({ outcome: 'unanswered' }));
    }),
  });
  try {
    const waiting = connect(fake, { host: 'download.pytorch.org', key: 'shell-d' });
    await tick();
    const summary = await run.prepared.blocked({ failed: true, output: 'ReadTimeoutError' });
    assert.equal(signal.aborted, true);
    assert.equal(await waiting, false);
    assert.deepEqual(summary.entries.map((e) => [e.kind, e.target, e.reason, e.allow]), [
      ['network', 'download.pytorch.org:443', NETWORK_REASONS.NOT_ALLOWED, ['download.pytorch.org:443', '*.pytorch.org']],
    ]);
  } finally {
    run.prepared.release();
    await run.cleanup();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('a connection the user turned down is shown, but not offered again', posixOnly, async () => {
  const fake = await makeService();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-live-ws-'));
  const run = await prepareRun(fake.service, base, {
    commandId: 'shell-e',
    onNetworkAsk: async () => ({ outcome: 'denied' }),
  });
  try {
    assert.equal(await connect(fake, { host: 'download.pytorch.org', key: 'shell-e' }), false);
    const summary = await run.prepared.blocked({ failed: true });
    assert.deepEqual(summary.entries.map((e) => [e.kind, e.reason, e.allow]), [['network', NETWORK_REASONS.USER_DENIED, []]]);
  } finally {
    run.prepared.release();
    await run.cleanup();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test('hosts a card opened join the run\'s domains — what a card could not offer does not', posixOnly, async () => {
  const fake = await makeService();
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-live-ws-'));
  const run = await prepareRun(fake.service, base, {
    allowedDomains: ['pypi.org'],
    grants: { hosts: ['download.pytorch.org:443', '*.pytorch.org', '*.org', '*.amazonaws.com', 'evil'] },
  });
  try {
    const expected = ['pypi.org', 'download.pytorch.org:443', '*.pytorch.org'];
    assert.deepEqual(run.prepared.domains, expected);
    assert.deepEqual(fake.calls.configs.at(-1).network.allowedDomains, expected);
  } finally {
    run.prepared.release();
    await run.cleanup();
    await fs.rm(base, { recursive: true, force: true });
  }
});

// ── What travels to the card and into the history ───────────────────────────

test('the live card\'s DTO carries how long the connection waited and what is open, cut to size', () => {
  const sandbox = {
    live: true,
    waitedMs: 7012.6,
    domains: ['pypi.org', 42, 'x'.repeat(300)],
    command: 'pip install torch',
    run: { exitCode: null, durationMs: null, timedOut: false },
    output: '',
    entries: [{ kind: 'network', target: 'download.pytorch.org:443', allow: ['download.pytorch.org:443', '*.pytorch.org'] }],
    others: [],
    raw: [],
  };
  const dto = createToolApprovalRequestDto({ requestId: 'r', tool: 'shell_execute', riskClasses: ['external'], targets: [], checkpoint: 'sandbox', sandbox });
  assert.equal(dto.sandbox.live, true);
  assert.equal(dto.sandbox.waitedMs, 7013);
  assert.deepEqual(dto.sandbox.domains, ['pypi.org', 'x'.repeat(253)]);
  assert.deepEqual(dto.sandbox.entries[0].allow, ['download.pytorch.org:443', '*.pytorch.org']);
  const after = createToolApprovalRequestDto({ requestId: 'r', tool: 'x', riskClasses: [], targets: [], checkpoint: 'sandbox', sandbox: { ...sandbox, live: 'yes' } });
  assert.equal(after.sandbox.live, undefined, 'only a real `true` makes a live card');
  assert.equal(after.sandbox.domains, undefined);
});

test('the decisions kept with the tool row, and in the stored history', () => {
  const live = [
    { target: 'a.example.com:443', outcome: 'allowed', duration: 'session', pattern: '*.example.com' },
    { target: 'b.example.com:443', outcome: 'allowed' },
    { target: 'c.example.com:443', outcome: 'denied', pattern: 'ignored' },
    { target: '', outcome: 'allowed' },
    { target: 'd.example.com:443', outcome: 'maybe' },
  ];
  const expected = [
    { target: 'a.example.com:443', outcome: 'allowed', duration: 'session', pattern: '*.example.com' },
    { target: 'b.example.com:443', outcome: 'allowed', duration: 'run', pattern: 'b.example.com:443' },
    { target: 'c.example.com:443', outcome: 'denied' },
  ];
  assert.deepEqual(normalizeSandboxLive(live), expected);
  assert.equal(normalizeSandboxLive([]), null);
  assert.equal(normalizeSandboxLive('x'), null);
  const stored = toolTraceEntryForStore({ line: 'Shell: pip install torch', tool: 'shell_execute', sandboxLive: live });
  assert.deepEqual(stored.sandboxLive, expected, 'kept without anything refused');
});

// ── The patched runtime ─────────────────────────────────────────────────────

test('the installed runtime passes the command key to the ask callback (scripts/patch-sandbox-runtime.js)', async () => {
  const source = await fs.readFile(managerPath(), 'utf8');
  assert.ok(source.includes(PATCHED),
    'The line patched after `npm install` is missing — did an update of @anthropic-ai/sandbox-runtime move it? '
    + 'Without it Snotra asks about no connection while it waits (#792).');
});

test('the patch changes exactly the one line, once, and leaves a runtime without it alone', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-patch-'));
  try {
    const file = path.join(dir, 'sandbox-manager.js');
    const original = 'a();\n        const userAllowed = await sandboxAskCallback({ host, port });\nb();\n';
    await fs.writeFile(file, original);
    assert.equal(patchSandboxRuntime(file), 'patched');
    assert.equal(await fs.readFile(file, 'utf8'), original.replace('{ host, port }', '{ host, port, encodedCommand }'));
    assert.equal(patchSandboxRuntime(file), 'already');
    await fs.writeFile(file, 'something else entirely');
    assert.equal(patchSandboxRuntime(file), 'missing');
    assert.equal(await fs.readFile(file, 'utf8'), 'something else entirely');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
