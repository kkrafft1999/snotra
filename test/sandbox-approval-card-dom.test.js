// The sandbox card (#792, step 2) as a component: what it shows, which path
// and duration the answer carries, Escape, the outcome — and the decision in
// the box under the tool log afterwards. The engine's side is in
// chat-engine-permissions.test.js, main's in sandbox-approval.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer, focusFixup } = require('./helpers/dom.js');

function layoutByClasses(window) {
  const proto = window.Element.prototype;
  const original = proto.getClientRects;
  proto.getClientRects = function getClientRects() {
    if (!this.isConnected) return [];
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || node.classList.contains('hidden')) return [];
    }
    return [{ x: 0, y: 0, width: 10, height: 10 }];
  };
  return () => { proto.getClientRects = original; };
}

const HOME = '/Users/me';
function dto(requestId, patch = {}) {
  return {
    contractVersion: 1,
    requestId,
    chatId: 'chat-a',
    tool: 'shell_execute',
    riskClasses: ['write'],
    targets: [],
    mode: 'auto',
    sessionAllowed: true,
    checkpoint: 'sandbox',
    sandbox: {
      command: 'npx prisma generate',
      run: { exitCode: 1, durationMs: 2400, timedOut: false },
      output: 'Error: EPERM: operation not permitted',
      entries: [{
        kind: 'write',
        target: `${HOME}/Library/Caches/prisma/engines/5.22.0`,
        count: 1,
        folder: false,
        allow: [`${HOME}/Library/Caches/prisma/engines/5.22.0`, `${HOME}/Library/Caches/prisma/engines`],
      }],
      others: [{ kind: 'network', target: 'binaries.prisma.sh:443' }],
      raw: ['node(1) deny(1) file-write-create /Users/me/Library/Caches/prisma/engines/5.22.0'],
    },
    ...patch,
  };
}

async function mount() {
  const { initToolApprovalCards } = await importRenderer('components', 'ToolApprovalCard.js');
  const calls = [];
  const handlers = {};
  const api = {
    onToolApprovalRequest: (fn) => { handlers.request = fn; },
    onToolApprovalResolved: (fn) => { handlers.resolved = fn; },
    respondToolApproval: async (requestId, response, extra) => {
      calls.push({ requestId, response, extra });
      return { ok: true };
    },
  };
  const bubble = document.createElement('li');
  bubble.className = 'chat-msg assistant';
  document.getElementById('chat-messages').appendChild(bubble);
  initToolApprovalCards({ api, appStore: { currentChatId: 'chat-a', chatRuns: new Map() }, getHomeDir: () => HOME });
  return { calls, request: (v) => handlers.request(v), resolve: (v) => handlers.resolved(v) };
}

const card = (id) => document.querySelector(`.chat-approval-card[data-request-id="${id}"]`);
const settle = async () => {
  focusFixup(document, { isLaidOut: (node) => node.getClientRects().length > 0 });
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function withDom(fn) {
  return async () => {
    const dom = setupRendererDom();
    const restore = layoutByClasses(dom.window);
    try {
      await fn(dom);
    } finally {
      restore();
      dom.cleanup();
    }
  };
}

test('the card says what was blocked, how the run went and what it reported', withDom(async () => {
  const page = await mount();
  page.request(dto('s1'));
  const el = card('s1');
  assert.ok(el.classList.contains('chat-approval-card--sandbox'));
  assert.equal(el.querySelector('.chat-approval-card__title').textContent, 'Sandbox · approval needed');
  assert.equal(el.querySelector('.chat-approval-card__badge').textContent, 'Also in Auto');
  assert.equal(el.querySelector('.chat-approval-card__headline').textContent, 'npx prisma generate wanted to write outside the project folder.');
  assert.equal(el.querySelector('.chat-approval-card__headline code').textContent, 'npx prisma generate');
  const facts = [...el.querySelectorAll('.chat-approval-card__fact')].map((f) => f.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(facts, [
    'BlockedWrite~/Library/Caches/prisma/engines/5.22.0',
    'Also blockedConnectionbinaries.prisma.sh:443cannot be allowed here',
    'Commandnpx prisma generate',
    'RunRan and stopped with an error (exit code 1, 2.4 sec)',
    'ReasonWriting is allowed only in the project folder and in the run\'s temporary folder.',
  ]);
  const [report, raw] = el.querySelectorAll('.chat-approval-card__report');
  assert.equal(report.open, true, 'what the command reported is open');
  assert.equal(report.querySelector('pre').textContent, 'Error: EPERM: operation not permitted');
  assert.equal(raw.open, false, 'the raw lines are folded');
  assert.equal(el.querySelector('.chat-approval-card__warning').textContent,
    'Allowing runs the command again from the start. Whatever it already did the first time happens again.');
}));

test('allowing sends the chosen path and the duration; the first option is the default', withDom(async () => {
  const page = await mount();
  page.request(dto('s1'));
  const el = card('s1');
  const [scope, duration] = el.querySelectorAll('.chat-approval-card__choice');
  assert.equal(scope.querySelector('legend').textContent, 'Allow writing in', 'one resource: no path in the legend');
  assert.deepEqual([...scope.querySelectorAll('.chat-approval-card__option')].map((o) => o.textContent),
    ['~/Library/Caches/prisma/engines/5.22.0exactly what was blocked', '~/Library/Caches/prisma/enginesone folder up']);
  assert.equal(scope.querySelector('input:checked').value, `${HOME}/Library/Caches/prisma/engines/5.22.0`);
  assert.equal(duration.querySelector('input:checked').value, 'run');

  const allow = el.querySelector('.chat-approval-card__actions button[data-response="allow-once"]');
  assert.equal(allow.textContent, 'Allow and run again');
  assert.ok(allow.classList.contains('btn-primary'), 'the primary action, as on every card');
  allow.click();
  assert.deepEqual(page.calls.at(-1), {
    requestId: 's1', response: 'allow-once', extra: { sandboxPaths: [`${HOME}/Library/Caches/prisma/engines/5.22.0`] },
  });

  page.request(dto('s2'));
  const second = card('s2');
  second.querySelectorAll('.chat-approval-card__choice')[0].querySelectorAll('input')[1].click();
  second.querySelector('input[value="session"]').click();
  second.querySelector('.chat-approval-card__actions button[data-response="allow-once"]').click();
  assert.deepEqual(page.calls.at(-1), {
    requestId: 's2', response: 'allow-session', extra: { sandboxPaths: [`${HOME}/Library/Caches/prisma/engines`] },
  });
}));

test('where the mode keeps no approvals, there is no "for this session"', withDom(async () => {
  const page = await mount();
  page.request(dto('s1', { sessionAllowed: false, mode: 'ask-all' }));
  const groups = card('s1').querySelectorAll('.chat-approval-card__choice');
  assert.equal(groups.length, 1, 'only the scope');
  assert.equal(card('s1').querySelector('input[value="session"]'), null);
}));

test('Escape denies, and a decided card keeps its choice but takes no more', withDom(async () => {
  const page = await mount();
  page.request(dto('s1'));
  await settle();
  card('s1').focus();
  card('s1').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(page.calls.at(-1), { requestId: 's1', response: 'deny', extra: undefined });
  page.resolve({ requestId: 's1', response: 'deny' });
  const el = card('s1');
  assert.equal(el.dataset.state, 'denied');
  assert.match(el.querySelector('.chat-approval-card__result').textContent, /^Denied The command is not run again/);
  assert.ok([...el.querySelectorAll('.chat-approval-card__choice')].every((f) => f.disabled));
}));

test('allowed for the session, the card says so', withDom(async () => {
  const page = await mount();
  page.request(dto('s1'));
  page.resolve({ requestId: 's1', response: 'allow-session' });
  assert.match(card('s1').querySelector('.chat-approval-card__result').textContent, /^Allowed for this session The command runs again/);
}));

test('the box under the tool log says what was decided, and what the retry ran into', withDom(async () => {
  const { buildSandboxBlockedBox, blockedRunsOf } = await importRenderer('chat', 'sandboxBlocked.js');
  const blocked = { entries: [{ kind: 'write', target: `${HOME}/x`, count: 1 }], raw: [] };
  const box = (decision) => buildSandboxBlockedBox(
    blockedRunsOf([{ line: 'Shell: x', tool: 'shell_execute', sandboxBlocked: blocked, sandboxDecision: decision }]),
    { homeDir: HOME },
  );
  const text = (el) => el.querySelector('.chat-sandbox-blocked-decision').textContent;
  assert.equal(text(box({ outcome: 'allowed', duration: 'run', paths: [], retry: { exitCode: 0 } })), 'Allowed for this run · ran again, exit code 0');
  assert.equal(text(box({ outcome: 'allowed', duration: 'session', paths: [], retry: { exitCode: null } })), 'Allowed for this session · ran again');
  assert.equal(text(box({ outcome: 'denied' })), 'Denied · not run again');
  assert.equal(text(box({ outcome: 'unanswered' })), 'Not answered · not run again');
  assert.equal(box(null).querySelector('.chat-sandbox-blocked-decision'), null, 'no card, no decision');

  const again = box({ outcome: 'allowed', duration: 'run', paths: [], retry: { exitCode: 1, blocked: { entries: [{ kind: 'read', target: `${HOME}/.ssh/id_ed25519`, count: 1 }], raw: [] } } });
  const runs = [...again.querySelectorAll('.chat-sandbox-blocked-run')].map((p) => p.textContent);
  assert.deepEqual(runs, ['Blocked again on the second run']);
  assert.equal(again.querySelectorAll('.chat-sandbox-blocked-entry').length, 2);
  assert.equal(again.querySelectorAll('.chat-sandbox-blocked-entry')[1].querySelector('.chat-sandbox-blocked-target').textContent, '~/.ssh/id_ed25519');
}));

// ── A connection that waits while the command runs (#792, step 3) ───────────

const HOST = 'download.pytorch.org:443';
function liveDto(requestId, patch = {}) {
  return dto(requestId, {
    riskClasses: ['external'],
    sandbox: {
      live: true,
      waitedMs: 7000,
      domains: ['pypi.org', 'files.pythonhosted.org'],
      command: 'pip install -r requirements.txt',
      run: { exitCode: null, durationMs: null, timedOut: false },
      output: '',
      entries: [{ kind: 'network', target: HOST, count: 1, folder: false, allow: [HOST, '*.pytorch.org'] }],
      others: [],
      raw: [`No matching config rule, asking user: ${HOST}`],
    },
    ...patch,
  });
}

test('the card about a waiting connection says how long it waits and what is open already', withDom(async () => {
  const page = await mount();
  page.request(liveDto('n1'));
  const el = card('n1');
  assert.equal(el.querySelector('.chat-approval-card__title').textContent, 'Sandbox · connection waiting');
  assert.equal(el.querySelector('.chat-approval-card__headline').textContent,
    'pip install -r requirements.txt wants to connect to download.pytorch.org.');
  assert.deepEqual([...el.querySelectorAll('.chat-approval-card__headline code')].map((c) => c.textContent),
    ['pip install -r requirements.txt', 'download.pytorch.org']);
  const facts = [...el.querySelectorAll('.chat-approval-card__fact')].map((f) => f.textContent.replace(/\s+/g, ' ').trim());
  assert.deepEqual(facts, [
    `BlockedConnection · HTTPS${HOST}`,
    'Commandpip install -r requirements.txt',
    'RunRunning; the connection has been waiting for 0:07',
    'Already openpypi.orgfiles.pythonhosted.org',
    'ReasonThis host is not among the network domains of the run.',
  ]);
  const [report] = el.querySelectorAll('.chat-approval-card__report');
  assert.equal(report.querySelector('summary').textContent, 'What the command reported so far');
  assert.equal(report.querySelector('.chat-approval-card__report-empty').textContent,
    'Nothing yet; the command is waiting for the connection.');
  assert.match(el.querySelector('.chat-approval-card__warning').textContent, /^Allowing lets the command simply carry on; nothing runs twice\./);

  const [scope] = el.querySelectorAll('.chat-approval-card__choice');
  assert.equal(scope.querySelector('legend').textContent, 'Allow connections to');
  assert.deepEqual([...scope.querySelectorAll('.chat-approval-card__option')].map((o) => o.textContent),
    [`${HOST}exactly this host`, '*.pytorch.orgevery host of this domain']);
  const allow = el.querySelector('.chat-approval-card__actions button[data-response="allow-once"]');
  assert.equal(allow.textContent, 'Allow connection');
  scope.querySelectorAll('input')[1].click();
  allow.click();
  assert.deepEqual(page.calls.at(-1), { requestId: 'n1', response: 'allow-once', extra: { sandboxPaths: ['*.pytorch.org'] } });
}));

test('the waiting time runs on while the card is open, and stops once it is decided', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  await withDom(async () => {
    const page = await mount();
    page.request(liveDto('n1', { sandbox: { ...liveDto('n1').sandbox, waitedMs: 58_000 } }));
    const run = () => card('n1').querySelector('.chat-approval-card__run').textContent;
    assert.equal(run(), 'Running; the connection has been waiting for 0:58');
    t.mock.timers.tick(3000);
    assert.equal(run(), 'Running; the connection has been waiting for 1:01');
    page.resolve({ requestId: 'n1', response: 'allow-once' });
    assert.equal(run(), 'The connection waited 1:01', 'decided, the card says how long it waited');
    t.mock.timers.tick(5000);
    assert.equal(run(), 'The connection waited 1:01', 'and the clock has stopped');
  })();
});

test('a decided connection card says the command carries on — or that it stopped waiting', withDom(async () => {
  const page = await mount();
  const result = (id) => card(id).querySelector('.chat-approval-card__result').textContent;
  page.request(liveDto('n1'));
  page.resolve({ requestId: 'n1', response: 'allow-once' });
  assert.equal(result('n1'), 'Allowed for this run The connection goes through, and the command carries on.');
  page.request(liveDto('n2'));
  page.resolve({ requestId: 'n2', response: 'deny' });
  assert.equal(result('n2'), 'Denied The connection stays closed, and the model is told not to work around it.');
  page.request(liveDto('n3'));
  page.resolve({ requestId: 'n3', invalidated: true, reason: 'sandbox_run_ended' });
  assert.equal(card('n3').dataset.state, 'invalidated');
  assert.equal(result('n3'), 'Stopped waiting The command gave up on the connection before you decided, so it stayed closed.');
  assert.equal(card('n3').querySelector('.chat-approval-card__report-empty').textContent, 'Nothing.',
    'it no longer says the command is waiting');
}));

test('after the run, a connection is offered with a retry', withDom(async () => {
  const page = await mount();
  const sandbox = { ...liveDto('x').sandbox, live: undefined, waitedMs: undefined, domains: undefined, run: { exitCode: 1, durationMs: 15200, timedOut: false } };
  page.request(dto('n1', { riskClasses: ['external'], sandbox }));
  const el = card('n1');
  assert.equal(el.querySelector('.chat-approval-card__title').textContent, 'Sandbox · approval needed');
  assert.equal(el.querySelector('.chat-approval-card__headline').textContent,
    'pip install -r requirements.txt wanted to connect to a host outside its network domains.');
  assert.equal(el.querySelector('.chat-approval-card__blocked-kind').textContent, 'Connection · HTTPS');
  assert.equal(el.querySelector('.chat-approval-card__actions button[data-response="allow-once"]').textContent, 'Allow and run again');
  assert.equal(el.querySelector('.chat-approval-card__domains'), null, 'nothing "already open" after the run');
}));

test('the box under the tool log keeps a connection let through while the command waited', withDom(async () => {
  const { buildSandboxBlockedBox, blockedRunsOf } = await importRenderer('chat', 'sandboxBlocked.js');
  const allowedOnly = buildSandboxBlockedBox(blockedRunsOf([{
    line: 'Shell: pip install torch',
    tool: 'shell_execute',
    sandboxLive: [{ target: HOST, outcome: 'allowed', duration: 'run', pattern: '*.pytorch.org' }],
  }]));
  assert.equal(allowedOnly.querySelector('.chat-sandbox-blocked-heading').textContent, 'The sandbox asked about 1 connection');
  const entry = allowedOnly.querySelector('.chat-sandbox-blocked-entry');
  assert.equal(entry.dataset.outcome, 'allowed');
  assert.deepEqual([...entry.children].map((c) => c.textContent),
    ['Connection', `${HOST} · *.pytorch.org`, 'Allowed while the command waited · this run']);

  const denied = buildSandboxBlockedBox(blockedRunsOf([{
    line: 'Shell: pip install torch',
    tool: 'shell_execute',
    sandboxBlocked: { entries: [{ kind: 'network', target: HOST, count: 1, reason: 'user denied' }], raw: [] },
    sandboxLive: [{ target: HOST, outcome: 'denied' }],
  }]));
  assert.equal(denied.querySelector('.chat-sandbox-blocked-heading').textContent, 'The sandbox blocked 1 resource');
  assert.equal(denied.querySelectorAll('.chat-sandbox-blocked-entry').length, 1, 'a denial is among the refusals once');
  assert.equal(denied.querySelector('.chat-sandbox-blocked-reason').textContent, 'You denied this connection while the command ran.');
}));
