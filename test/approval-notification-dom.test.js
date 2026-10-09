// A system notification when an approval card waits out of sight (#792,
// step 5): the renderer's side — when it asks main for one, with which
// words, and that a decided card closes it. Main's side is in
// approval-notifier.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer } = require('./helpers/dom.js');

function accessDto(requestId, chatId = 'chat-a') {
  return {
    contractVersion: 1,
    requestId,
    chatId,
    tool: 'edit_file',
    riskClasses: ['write'],
    targets: [{ path: 'notes/todo.md', kind: 'file', exists: true, sensitive: false }],
    mode: 'smart',
    sessionAllowed: true,
    checkpoint: 'access',
  };
}

async function mount({ focused = true, titles = { 'chat-a': 'Moving', 'chat-b': 'Taxes' } } = {}) {
  const { initToolApprovalCards } = await importRenderer('components', 'ToolApprovalCard.js');
  const shown = [];
  const closed = [];
  const handlers = {};
  const api = {
    onToolApprovalRequest: (fn) => { handlers.request = fn; },
    onToolApprovalResolved: (fn) => { handlers.resolved = fn; },
    respondToolApproval: async () => ({ ok: true }),
    showApprovalNotification: async (payload) => { shown.push(payload); return { ok: true, shown: true }; },
    closeApprovalNotification: async (requestId) => { closed.push(requestId); return { ok: true }; },
  };
  document.hasFocus = () => focused;
  const bubble = document.createElement('li');
  bubble.className = 'chat-msg assistant';
  document.getElementById('chat-messages').appendChild(bubble);
  initToolApprovalCards({
    api,
    appStore: { currentChatId: 'chat-a', chatRuns: new Map() },
    getChatTitle: (chatId) => titles[chatId] || '',
  });
  return { shown, closed, request: (dto) => handlers.request(dto), resolve: (p) => handlers.resolved(p) };
}

function withDom(fn) {
  return async () => {
    const dom = setupRendererDom();
    try {
      await fn(dom);
    } finally {
      dom.cleanup();
    }
  };
}

test('a card in the chat on screen, with Snotra in front, needs no notification', withDom(async () => {
  const page = await mount();
  page.request(accessDto('r1'));
  assert.deepEqual(page.shown, []);
}));

test('a card in another chat gets one, naming the chat and what waits', withDom(async () => {
  const page = await mount();
  page.request(accessDto('r1', 'chat-b'));
  assert.equal(page.shown.length, 1);
  const [payload] = page.shown;
  assert.equal(payload.requestId, 'r1');
  assert.equal(payload.chatId, 'chat-b');
  assert.equal(payload.title, 'Taxes', 'the system names the app, the title the chat');
  assert.match(payload.body, /^Needs your approval: /);
  assert.doesNotMatch(payload.body, /\{(tool|target|command|host)\}/, 'no placeholder left over');
}));

test('with Snotra in the background, even a card in the chat on screen gets one', withDom(async () => {
  const page = await mount({ focused: false, titles: {} });
  page.request(accessDto('r1'));
  assert.equal(page.shown.length, 1);
  assert.equal(page.shown[0].title, 'New chat', 'a chat without a title or a message yet');
}));

test('a sandbox card says what it is about', withDom(async () => {
  const page = await mount({ focused: false });
  page.request({
    ...accessDto('r1'),
    riskClasses: ['external'],
    checkpoint: 'sandbox',
    sandbox: {
      live: true, waitedMs: 0, domains: [], command: 'pip install torch',
      run: { exitCode: null, durationMs: null, timedOut: false }, output: '', others: [], raw: [],
      entries: [{ kind: 'network', target: 'download.pytorch.org:443', count: 1, folder: false, allow: ['download.pytorch.org:443'] }],
    },
  });
  assert.equal(page.shown[0].title, 'Moving');
  assert.equal(page.shown[0].body, 'Needs your approval: pip install torch wants to connect to download.pytorch.org.');
}));

test('a decided or expired card closes its notification', withDom(async () => {
  const page = await mount();
  page.request(accessDto('r1', 'chat-b'));
  page.resolve({ requestId: 'r1', response: 'allow-once' });
  page.request(accessDto('r2', 'chat-b'));
  page.resolve({ requestId: 'r2', invalidated: true, reason: 'request_invalidated' });
  assert.deepEqual(page.closed, ['r1', 'r2']);
}));
