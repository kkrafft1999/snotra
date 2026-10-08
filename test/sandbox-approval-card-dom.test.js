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
