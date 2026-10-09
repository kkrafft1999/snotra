// The sandbox card after a run (#792, step 2), below the engine: what may be
// offered and opened (service), how a session keeps it (session grants), how
// the card's request and answer cross the boundary (contracts, adapter).
// The engine's side is in chat-engine-permissions.test.js, the real sandbox
// in sandbox-isolation.test.js, the card itself in sandbox-approval-card-dom.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const { createSandboxService } = require('../src/main/services/sandbox-service');
const { widerFolder } = require('../src/main/services/sandbox-violations');
const { createSessionGrants } = require('../src/application/permissions/session-grants');
const {
  createToolApprovalRequestDto,
  normalizeToolApprovalResponse,
} = require('../src/shared/contracts/tool-permissions');
const { normalizeSandboxDecision } = require('../src/shared/contracts/chat');
const { createToolApprovalAdapter } = require('../src/main/adapters/tool-approval-adapter');
const { PUSH_CHANNELS: PUSH } = require('../src/shared/ipc-channels');

const posixOnly = { skip: process.platform === 'win32' ? 'needs POSIX paths' : false };
const HOME = '/home/u';

/** A service with a fake runtime whose store reports what the test adds. */
function makeService({ platform = 'linux', files = new Set(), protectedWritePaths = [] } = {}) {
  let violations = [];
  let total = 0;
  const listeners = new Set();
  const store = {
    add(command, line) {
      violations.push({ line, encodedCommand: Buffer.from(command).toString('base64') });
      total += 1;
      listeners.forEach((l) => l([...violations]));
    },
    getTotalCount: () => total,
    subscribe(listener) {
      listeners.add(listener);
      listener([...violations]);
      return () => listeners.delete(listener);
    },
  };
  const configs = [];
  const runtime = {
    SandboxManager: {
      checkDependencies: () => ({ errors: [], warnings: [] }),
      async initialize() {},
      updateConfig(config) { configs.push(config); },
      async wrapWithSandbox(command) { return command.includes('/outside/') ? 'exit 1' : command; },
      getSandboxViolationStore: () => store,
      cleanupAfterCommand() {},
      async reset() {},
    },
  };
  const made = [];
  const fakeFs = {
    ...fs,
    stat: async (p) => { if (files.has(p)) return {}; throw new Error('ENOENT'); },
    realpath: async (p) => p,
    mkdir: async (p) => { made.push(p); },
  };
  const service = createSandboxService({
    platform,
    os: { ...os, homedir: () => HOME },
    path,
    fs: fakeFs,
    spawn: childProcess.spawn,
    loadRuntime: () => runtime,
    userDataPath: `${HOME}/.config/Snotra AI`,
    protectedWritePaths,
    violationSettleMs: 0,
  });
  return { service, store, configs, made };
}

async function blockedOf(lines, options) {
  const { service, store } = makeService(options);
  await service.detect();
  const prepared = await service.prepare({ command: 'x', workspaceRoot: `${HOME}/project`, runTmp: '/tmp/r', commandId: 'c', skipDetect: true });
  for (const line of lines) store.add('c', line);
  return prepared.blocked();
}

// ── What a card may offer ─────────────────────────────────────────────────

test('widerFolder: one folder up, never a shared one, the home folder or above', () => {
  assert.equal(widerFolder(`${HOME}/Library/Caches/prisma/engines`, HOME), `${HOME}/Library/Caches/prisma`);
  assert.equal(widerFolder(`${HOME}/Library/Caches/prisma`, HOME), null, '~/Library/Caches is shared');
  assert.equal(widerFolder(`${HOME}/.npmrc`, HOME), null, 'the home folder');
  assert.equal(widerFolder('/opt/tool/cache', HOME), '/opt/tool');
  assert.equal(widerFolder('/opt/tool', HOME), null);
});

test('a blocked write is offered as itself and one folder up', posixOnly, async () => {
  const blocked = await blockedOf([`node(1) deny(1) file-write-create ${HOME}/Library/Caches/prisma/engines`], { platform: 'darwin' });
  assert.deepEqual(blocked.entries[0].allow, [`${HOME}/Library/Caches/prisma/engines`, `${HOME}/Library/Caches/prisma`]);
});

test('nothing in or around the protected locations, Snotra\'s storage or the home folder is offered', posixOnly, async () => {
  const blocked = await blockedOf([
    `x(1) deny(1) file-write-create ${HOME}/.ssh/authorized_keys`,
    `x(1) deny(1) file-write-create ${HOME}/.config/Snotra AI/settings.json`,
    `x(1) deny(1) file-write-create ${HOME}/.bashrc`,
    `x(1) deny(1) file-write-create ${HOME}/.snotra/skills/x/SKILL.md`,
  ], { platform: 'darwin', protectedWritePaths: [`${HOME}/.snotra/skills`] });
  for (const entry of blocked.entries) assert.deepEqual(entry.allow, [], entry.target);
});

test('a protected read is offered as exactly that path, Snotra\'s own storage never', posixOnly, async () => {
  const blocked = await blockedOf([
    `git(1) deny(1) file-read-data ${HOME}/.ssh/known_hosts`,
    `x(1) deny(1) file-read-data ${HOME}/.config/Snotra AI/llm-config.json`,
  ], { platform: 'darwin' });
  const allow = Object.fromEntries(blocked.entries.map((e) => [e.target, e.allow]));
  assert.deepEqual(allow[`${HOME}/.ssh/known_hosts`], [`${HOME}/.ssh/known_hosts`]);
  assert.deepEqual(allow[`${HOME}/.config/Snotra AI/llm-config.json`], []);
});

test('Linux: a file that does not exist yet is offered as its folder, a folder being made as itself', posixOnly, async () => {
  const file = await blockedOf(['deny openat /opt/tool/state/config.json'], { platform: 'linux' });
  assert.deepEqual(file.entries[0].allow, ['/opt/tool/state', '/opt/tool']);
  const folder = await blockedOf(['deny mkdirat /opt/tool/cache/v2'], { platform: 'linux' });
  assert.deepEqual(folder.entries[0].allow, ['/opt/tool/cache/v2', '/opt/tool/cache']);
  const existing = await blockedOf(['deny openat /opt/tool/state/config.json'], { platform: 'linux', files: new Set(['/opt/tool/state/config.json']) });
  assert.deepEqual(existing.entries[0].allow, ['/opt/tool/state/config.json', '/opt/tool/state']);
});

test('what the runtime never lets anyone write is not offered either', posixOnly, async () => {
  const blocked = await blockedOf([
    'x(1) deny(1) file-write-create /opt/repo/.git/hooks/pre-commit',
    'x(1) deny(1) file-write-data /opt/elsewhere/.ZSHRC',
  ], { platform: 'darwin' });
  for (const entry of blocked.entries) assert.deepEqual(entry.allow, [], entry.target);
});

// ── What a run gets ───────────────────────────────────────────────────────

test('granted folders become writable and granted paths readable — what may not be granted stays out', posixOnly, async () => {
  const { service, configs } = makeService({ platform: 'darwin' });
  await service.detect();
  await service.prepare({
    command: 'x', workspaceRoot: `${HOME}/project`, runTmp: '/tmp/r', commandId: 'c', skipDetect: true,
    grants: {
      writePaths: [`${HOME}/Library/Caches/prisma`, HOME, '/', `${HOME}/.ssh`],
      readPaths: [`${HOME}/.ssh/known_hosts`, `${HOME}/.config/Snotra AI/llm-config.json`],
    },
  });
  const { filesystem } = configs.at(-1);
  assert.deepEqual(filesystem.allowWrite, [`${HOME}/project`, '/tmp/r', `${HOME}/Library/Caches/prisma`]);
  assert.deepEqual(filesystem.allowRead, [`${HOME}/.ssh/known_hosts`]);
  assert.ok(filesystem.denyRead.includes('~/.ssh'), 'the protected list itself stays as it is');
});

test('without grants the run config has no allowRead', posixOnly, async () => {
  const { service, configs } = makeService({ platform: 'darwin' });
  await service.detect();
  await service.prepare({ command: 'x', workspaceRoot: `${HOME}/project`, runTmp: '/tmp/r', commandId: 'c', skipDetect: true });
  assert.equal('allowRead' in configs.at(-1).filesystem, false);
});

test('Linux: a granted folder that does not exist is made before the run, a refused one is not', posixOnly, async () => {
  const { service, made } = makeService({ platform: 'linux' });
  await service.detect();
  await service.prepare({
    command: 'x', workspaceRoot: `${HOME}/project`, runTmp: '/tmp/r', commandId: 'c', skipDetect: true,
    grants: { writePaths: ['/opt/tool/cache/v2', `${HOME}/.ssh/new`] },
  });
  assert.deepEqual(made.filter((p) => !p.includes('snotra-sandbox-selftest')), ['/opt/tool/cache/v2']);
});

// ── The session ───────────────────────────────────────────────────────────

test('session grants keep a sandbox path per scope, and it allows no tool call', () => {
  const grants = createSessionGrants();
  grants.grant({ scopeKey: 's1', tool: 'shell_execute', targets: [{ path: '/opt/c' }], riskClasses: ['write'], sandbox: { kind: 'write', path: '/opt/c' } });
  grants.grant({ scopeKey: 's1', tool: 'run_python', targets: [{ path: '/k' }], riskClasses: ['read-sensitive'], sandbox: { kind: 'read', path: '/k' } });
  grants.grant({ scopeKey: 's2', tool: 'shell_execute', targets: [{ path: '/opt/d' }], riskClasses: ['write'], sandbox: { kind: 'write', path: '/opt/d' } });
  assert.deepEqual(grants.sandboxPaths('s1'), { writePaths: ['/opt/c'], readPaths: ['/k'], hosts: [], outside: [] });
  assert.deepEqual(grants.sandboxPaths('other'), { writePaths: [], readPaths: [], hosts: [], outside: [] });
  assert.equal(grants.find({ scopeKey: 's1', tool: 'shell_execute', targets: [{ path: '/opt/c' }], riskClasses: ['write'] }), null);
  assert.equal(grants.list().length, 3, 'listed and revocable like any other');
});

// ── Request and answer ────────────────────────────────────────────────────

const SANDBOX = {
  command: 'npx prisma generate',
  run: { exitCode: 1, durationMs: 2400.4, timedOut: false },
  output: 'EPERM',
  entries: [
    { kind: 'write', target: '/opt/c/v1', count: 1, folder: false, allow: ['/opt/c/v1', '/opt/c'] },
    { kind: 'write', target: '/x', count: 1, allow: [] },
    { kind: 'network', target: 'example.com:443', allow: ['example.com:443'] },
    { kind: 'direct', target: '10.0.0.1:5432', allow: ['10.0.0.1:5432'] },
  ],
  others: [{ kind: 'network', target: 'example.com:443' }, { kind: 'other', target: 'sysctl' }],
  raw: ['line'],
};

test('the card\'s DTO names the checkpoint and carries only what may be opened', () => {
  const dto = createToolApprovalRequestDto({ requestId: 'r', tool: 'shell_execute', riskClasses: ['write'], targets: [], checkpoint: 'sandbox', sandbox: SANDBOX });
  assert.equal(dto.checkpoint, 'sandbox');
  assert.deepEqual(dto.sandbox, {
    command: 'npx prisma generate',
    run: { exitCode: 1, durationMs: 2400, timedOut: false },
    output: 'EPERM',
    entries: [
      { kind: 'write', target: '/opt/c/v1', count: 1, folder: false, allow: ['/opt/c/v1', '/opt/c'] },
      // A host since #792; a direct connection never.
      { kind: 'network', target: 'example.com:443', count: 1, folder: false, allow: ['example.com:443'] },
    ],
    others: [{ kind: 'network', target: 'example.com:443' }],
    raw: ['line'],
  });
  const access = createToolApprovalRequestDto({ requestId: 'r', tool: 'x', riskClasses: ['write'], targets: [], checkpoint: 'access', sandbox: SANDBOX });
  assert.equal(access.sandbox, undefined, 'only a sandbox card carries it');
});

test('the answer carries the chosen paths, cut to size', () => {
  assert.deepEqual(normalizeToolApprovalResponse({ requestId: 'r', response: 'allow-once', sandboxPaths: ['/opt/c', 7] }), {
    requestId: 'r', response: 'allow-once', sandboxPaths: ['/opt/c', ''],
  });
  assert.deepEqual(normalizeToolApprovalResponse({ requestId: 'r', response: 'deny' }), { requestId: 'r', response: 'deny' });
});

test('main opens only what the card offered, one path per resource', async () => {
  let n = 0;
  const adapter = createToolApprovalAdapter({ randomUUID: () => `req-${(n += 1)}`, PUSH, log: { warn() {} } });
  adapter.subscribe(1, { send() {}, isDestroyed: () => false, once() {} });
  const request = {
    tool: 'shell_execute', riskClasses: ['write'], targets: [], mode: 'auto', sessionAllowed: true, checkpoint: 'sandbox',
    sandbox: { entries: [{ kind: 'write', target: '/a/b', allow: ['/a/b', '/a'] }, { kind: 'read', target: '/k', allow: ['/k'] }] },
  };
  const pending = adapter.requestApproval({ sessionId: 1, request });
  assert.deepEqual(adapter.respond(1, { requestId: 'req-1', response: 'allow-session', sandboxPaths: ['/a', '/etc/passwd'] }), { ok: true, response: 'allow-session' });
  assert.deepEqual(await pending, { response: 'allow-session', sandboxPaths: ['/a', '/k'], requestId: 'req-1' });

  const denied = adapter.requestApproval({ sessionId: 1, request });
  adapter.respond(1, { requestId: 'req-2', response: 'deny', sandboxPaths: ['/a'] });
  assert.deepEqual(await denied, { response: 'deny', requestId: 'req-2' });
});

test('the decision kept with the tool row', () => {
  assert.deepEqual(normalizeSandboxDecision({ outcome: 'denied', paths: [{ kind: 'write', path: '/a' }] }), { outcome: 'denied' });
  assert.deepEqual(normalizeSandboxDecision({
    outcome: 'allowed', duration: 'forever', paths: [{ kind: 'write', path: '/a' }, { kind: 'net', path: 'x' }],
    retry: { exitCode: 0, blocked: { entries: [{ kind: 'read', target: '/k' }] } },
  }), {
    outcome: 'allowed', duration: 'run', paths: [{ kind: 'write', path: '/a' }],
    retry: { exitCode: 0, blocked: { entries: [{ kind: 'read', target: '/k', count: 1 }], moreEntries: 0, total: 1, raw: [] } },
  });
  assert.equal(normalizeSandboxDecision({ outcome: 'maybe' }), null);
});
