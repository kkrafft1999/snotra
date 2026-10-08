// What the sandbox refused, on its way from the run to the chat (#792): the
// contract that cuts it to size, the history that keeps it with the tool row,
// the tool handler that reports it, and the box under the tool log.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const { normalizeSandboxBlocked, SANDBOX_BLOCKED_KINDS, SANDBOX_BLOCKED_LIMITS } = require('../src/shared/contracts/chat');
const { KINDS } = require('../src/main/services/sandbox-violations');
const { toolTraceEntryForStore } = require('../src/main/services/chat-history-normalization');

const BLOCKED = {
  entries: [
    { kind: 'write', target: '/Users/me/Library/Caches/pip/http-v2', count: 37, folder: true, operations: ['file-write-create'] },
    { kind: 'network', target: 'download.pytorch.org:443', count: 2, operations: ['network-outbound'], reason: 'host is not on the allow list' },
  ],
  moreEntries: 0,
  total: 39,
  raw: [
    'pip(1) deny(1) file-write-create /Users/me/Library/Caches/pip/http-v2/a',
    'deny network-outbound download.pytorch.org:443 (host is not on the allow list)',
  ],
};

// ── Contract ────────────────────────────────────────────────────────────────

test('the parser and the contract know the same kinds', () => {
  assert.deepEqual(
    Object.values(KINDS).filter((k) => k !== KINDS.OTHER).sort(),
    [...SANDBOX_BLOCKED_KINDS].sort(),
  );
});

test('normalizeSandboxBlocked keeps a summary as it is', () => {
  assert.deepEqual(normalizeSandboxBlocked(BLOCKED), BLOCKED);
});

test('normalizeSandboxBlocked drops what it does not know and cuts what is too long', () => {
  const out = normalizeSandboxBlocked({
    entries: [
      { kind: 'other', target: 'mach-lookup x' },
      { kind: 'write', target: '' },
      { kind: 'read', target: 'x'.repeat(5000), count: -3, operations: [1, 'file-read-data'], extra: 'no' },
      null,
    ],
    moreEntries: 'many',
    raw: Array.from({ length: 150 }, (_, i) => `line ${i}`),
  });
  assert.equal(out.entries.length, 1);
  assert.deepEqual(Object.keys(out.entries[0]).sort(), ['count', 'kind', 'operations', 'target']);
  assert.equal(out.entries[0].target.length, SANDBOX_BLOCKED_LIMITS.CHARS);
  assert.equal(out.entries[0].count, 1);
  assert.deepEqual(out.entries[0].operations, ['file-read-data']);
  assert.equal(out.moreEntries, 0);
  assert.equal(out.raw.length, SANDBOX_BLOCKED_LIMITS.RAW_LINES);
  assert.equal(out.raw.at(-1), 'line 149', 'the latest lines stay');
});

test('normalizeSandboxBlocked: nothing usable is nothing', () => {
  assert.equal(normalizeSandboxBlocked(null), null);
  assert.equal(normalizeSandboxBlocked({ entries: 'x' }), null);
  assert.equal(normalizeSandboxBlocked({ entries: [{ kind: 'other', target: 'x' }] }), null);
});

// ── History ─────────────────────────────────────────────────────────────────

test('the history keeps what the sandbox refused with the tool row', () => {
  const stored = toolTraceEntryForStore({
    line: 'Shell: pip install -r requirements.txt',
    tool: 'shell_execute',
    args: { command: 'pip install -r requirements.txt' },
    sandboxBlocked: { ...BLOCKED, secret: 'no' },
  });
  assert.deepEqual(Object.keys(stored).sort(), ['line', 'sandboxBlocked', 'tool']);
  assert.deepEqual(stored.sandboxBlocked, BLOCKED);
  assert.equal(
    toolTraceEntryForStore({ line: 'x', sandboxBlocked: { entries: [{ kind: 'bogus', target: 'y' }] } }),
    'x',
    'an empty summary adds nothing',
  );
});

// ── Box under the tool log ──────────────────────────────────────────────────

async function withDom(fn) {
  const dom = setupRendererDom();
  try {
    const view = await importRenderer('chat', 'sandboxBlocked.js');
    const toolLog = await importRenderer('chat', 'toolLogView.js');
    await fn(view, toolLog, dom);
  } finally {
    dom.cleanup();
  }
}

const shellEntry = (command, blocked) => ({ line: `Shell: ${command}`, tool: 'shell_execute', sandboxBlocked: blocked });

test('the box lists kind, target and reason, and folds the raw lines away', async () => {
  await withDom(({ buildSandboxBlockedBox, blockedRunsOf }) => {
    const runs = blockedRunsOf([{ line: 'Read requirements.txt', tool: 'read_file_text' }, shellEntry('pip install -r requirements.txt', BLOCKED)]);
    const box = buildSandboxBlockedBox(runs, { homeDir: '/Users/me' });

    assert.equal(box.getAttribute('role'), 'group');
    const title = box.querySelector('.chat-sandbox-blocked-title');
    assert.equal(box.getAttribute('aria-labelledby'), title.id);
    assert.equal(title.querySelector('.chat-sandbox-blocked-heading').textContent, 'The sandbox blocked 2 resources');
    assert.equal(title.querySelector('.chat-sandbox-blocked-context').textContent, '· Shell: pip install -r requirements.txt');
    assert.equal(box.querySelector('.chat-sandbox-blocked-run'), null, 'one run is named in the title');

    const entries = [...box.querySelectorAll('.chat-sandbox-blocked-entry')];
    assert.deepEqual(entries.map((e) => e.querySelector('.chat-sandbox-blocked-kind').textContent), ['Write', 'Connection']);
    assert.equal(entries[0].querySelector('.chat-sandbox-blocked-target').textContent, '~/Library/Caches/pip/http-v2/ · 37 paths');
    assert.equal(entries[0].querySelector('.chat-sandbox-blocked-target').title, '/Users/me/Library/Caches/pip/http-v2');
    assert.equal(entries[1].querySelector('.chat-sandbox-blocked-target').textContent, 'download.pytorch.org:443 · 2 times');
    assert.match(entries[1].querySelector('.chat-sandbox-blocked-reason').textContent, /not among the network domains/);

    const raw = box.querySelector('details.chat-sandbox-blocked-raw');
    assert.equal(raw.open, false);
    assert.equal(raw.querySelector('summary').textContent, 'Raw sandbox message');
    assert.equal(raw.querySelector('pre').textContent, BLOCKED.raw.join('\n'));
    assert.equal(raw.querySelector('pre').tabIndex, 0);
  });
});

test('several blocked runs get one box with a line each', async () => {
  await withDom(({ buildSandboxBlockedBox, blockedRunsOf }) => {
    const second = { entries: [{ kind: 'direct', target: '10.0.0.5:5432', count: 1 }], moreEntries: 3, total: 4, raw: [] };
    const box = buildSandboxBlockedBox(blockedRunsOf([shellEntry('pip install x', BLOCKED), shellEntry('psql -h db', second)]));
    assert.equal(box.querySelector('.chat-sandbox-blocked-heading').textContent, 'The sandbox blocked 6 resources');
    assert.equal(box.querySelector('.chat-sandbox-blocked-context').textContent, '· in 2 runs');
    assert.deepEqual([...box.querySelectorAll('.chat-sandbox-blocked-run')].map((p) => p.textContent), ['Shell: pip install x', 'Shell: psql -h db']);
    assert.equal(box.querySelector('.chat-sandbox-blocked-more').textContent, 'and 3 more');
    assert.match(box.querySelector('[data-kind="direct"] .chat-sandbox-blocked-reason').textContent, /no direct connections/);
    assert.equal(box.querySelectorAll('details.chat-sandbox-blocked-raw').length, 1, 'no raw view without raw lines');
  });
});

test('a home under /var is found again in the /private path Seatbelt reports', async () => {
  await withDom(({ buildSandboxBlockedBox, blockedRunsOf }) => {
    const blocked = { entries: [{ kind: 'write', target: '/private/var/folders/x/home/Library/Caches', count: 1 }], raw: [] };
    const box = buildSandboxBlockedBox(blockedRunsOf([shellEntry('mkdir x', blocked)]), { homeDir: '/var/folders/x/home' });
    assert.equal(box.querySelector('.chat-sandbox-blocked-target').textContent, '~/Library/Caches');
  });
});

test('a host on the deny list is named as such', async () => {
  await withDom(({ buildSandboxBlockedBox, blockedRunsOf }) => {
    const blocked = { entries: [{ kind: 'network', target: 'evil.example:443', count: 1, reason: 'host is on the deny list' }], raw: [] };
    const box = buildSandboxBlockedBox(blockedRunsOf([shellEntry('curl evil.example', blocked)]));
    assert.match(box.querySelector('.chat-sandbox-blocked-reason').textContent, /deny list/);
  });
});

test('the box stands right under the tool log, before the changed files', async () => {
  await withDom(({ syncSandboxBlocked }, { syncChangesStrip }, dom) => {
    const message = dom.document.createElement('li');
    const log = dom.document.createElement('details');
    log.className = 'chat-tool-log';
    message.append(log);
    const files = [{ relativePath: 'a.txt', added: 1, removed: 0, changes: [{ id: '1-1', relativePath: 'a.txt', status: 'text', added: 1, removed: 0 }] }];
    const order = () => [...message.children].map((el) => el.className);

    syncChangesStrip(message, files, { isLive: () => true, onOpen() {} });
    syncSandboxBlocked(message, [shellEntry('pip install x', BLOCKED)]);
    assert.deepEqual(order(), ['chat-tool-log', 'chat-sandbox-blocked', 'chat-changes']);

    // The strip drawn again, or drawn first time after the box: still below it.
    syncChangesStrip(message, [], {});
    syncChangesStrip(message, files, { isLive: () => true, onOpen() {} });
    assert.deepEqual(order(), ['chat-tool-log', 'chat-sandbox-blocked', 'chat-changes']);

    // Redrawn, an opened raw view stays open; nothing blocked, the box goes.
    message.querySelector('details.chat-sandbox-blocked-raw').open = true;
    syncSandboxBlocked(message, [shellEntry('pip install x', BLOCKED)]);
    assert.equal(message.querySelector('details.chat-sandbox-blocked-raw').open, true);
    assert.equal(message.querySelectorAll('.chat-sandbox-blocked').length, 1);
    syncSandboxBlocked(message, [{ line: 'Read a.txt', tool: 'read_file_text' }]);
    assert.deepEqual(order(), ['chat-tool-log', 'chat-changes']);
  });
});

test('the renderer\'s trace entry keeps the summary for the history', async () => {
  await withDom((view, { toolTraceEntryForStore: forStore }) => {
    const entry = forStore({ line: 'Shell: x', tool: 'shell_execute', sandboxBlocked: BLOCKED, args: { command: 'x' } });
    assert.deepEqual(Object.keys(entry).sort(), ['line', 'sandboxBlocked', 'tool']);
    assert.deepEqual(entry.sandboxBlocked, BLOCKED);
  });
});
