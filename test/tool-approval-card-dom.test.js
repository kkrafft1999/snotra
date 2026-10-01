// The approval card as a component (CR-B13-05, #600): the click or key that
// becomes a permission decision. The view model has tests of its own
// (tool-approval-view.test.js); this file holds the wiring — one decision per
// request, a failed answer, Escape (CR-B13-02), background chats (#320), the
// outcome and the focus (CR-B13-03), a language change (#290) and invisible
// characters (CR-B13-01).
//
// happy-dom has no layout: `getClientRects()` returns a rectangle for every
// element, hidden or not. The card asks it whether an overlay is open and
// whether the card can be seen, so the tests lay out by the classes and
// attributes that hide things in the real stylesheet.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer, focusFixup: fixup } = require('./helpers/dom.js');

const RLO = String.fromCodePoint(0x202e);
const LRI = String.fromCodePoint(0x2066);
const PDI = String.fromCodePoint(0x2069);
const PDF = String.fromCodePoint(0x202c);

function layoutByClasses(window) {
  const proto = window.Element.prototype;
  const original = proto.getClientRects;
  proto.getClientRects = function getClientRects() {
    if (!this.isConnected) return [];
    for (let node = this; node; node = node.parentElement) {
      if (node.hidden || node.classList.contains('hidden')) return [];
      if (node.id === 'chat-panel' && node.ownerDocument.getElementById('app')?.classList.contains('app--no-chat')) return [];
    }
    return [{ x: 0, y: 0, width: 10, height: 10 }];
  };
  return () => { proto.getClientRects = original; };
}

function dto(requestId, patch = {}) {
  return {
    contractVersion: 1,
    requestId,
    chatId: 'chat-a',
    tool: 'edit_file',
    riskClasses: ['write'],
    targets: [{ path: 'src/config.js', kind: 'file', exists: true, sensitive: false }],
    reason: 'In “Smart” mode, file changes need an approval.',
    mode: 'smart',
    sessionAllowed: false,
    ...patch,
  };
}

/** A frame in Chromium: see `focusFixup` in the helper (CR-B13-03). */
function focusFixup() {
  fixup(document, { isLaidOut: (node) => node.getClientRects().length > 0 });
}

const settle = async () => {
  focusFixup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  focusFixup();
};

/** The card component over a stand-in API; `respond` decides each answer. */
async function mountCards({ respond = async () => ({ ok: true }), currentChatId = 'chat-a' } = {}) {
  const { initToolApprovalCards } = await importRenderer('components', 'ToolApprovalCard.js');
  const calls = [];
  const handlers = {};
  const api = {
    onToolApprovalRequest: (fn) => { handlers.request = fn; },
    onToolApprovalResolved: (fn) => { handlers.resolved = fn; },
    respondToolApproval: async (requestId, response) => {
      calls.push([requestId, response]);
      return respond(requestId, response);
    },
  };
  const appStore = { currentChatId, chatRuns: new Map() };
  const messages = document.getElementById('chat-messages');
  const bubble = document.createElement('li');
  bubble.className = 'chat-msg assistant';
  messages.appendChild(bubble);
  const cards = initToolApprovalCards({ api, appStore });
  return {
    cards,
    calls,
    appStore,
    bubble,
    request: (value) => handlers.request(value),
    resolve: (payload) => handlers.resolved(payload),
  };
}

function card(id) {
  return document.querySelector(`.chat-approval-card[data-request-id="${id}"]`);
}

function button(id, response) {
  return card(id).querySelector(`.chat-approval-card__actions button[data-response="${response}"]`);
}

function escapeOn(target) {
  const event = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

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

test('one decision per request: a second click while it is sent sends nothing', withDom(async () => {
  let release;
  const page = await mountCards({ respond: () => new Promise((resolve) => { release = resolve; }) });
  page.request(dto('r1'));
  button('r1', 'allow-once').click();
  button('r1', 'deny').click();
  button('r1', 'allow-once').click();
  assert.deepEqual(page.calls, [['r1', 'allow-once']]);
  assert.equal(card('r1').querySelector('.chat-approval-card__status').textContent, 'Passing the decision on …');
  assert.equal([...card('r1').querySelectorAll('.chat-approval-card__actions button')].every((b) => b.disabled), true);
  release({ ok: true });
  await settle();
  // The answer was taken; the outcome comes as a push from main.
  page.resolve({ requestId: 'r1', response: 'allow-once' });
  assert.equal(card('r1').dataset.state, 'allowed');
  assert.equal(card('r1').querySelector('.chat-approval-card__actions').hidden, true);
  assert.match(card('r1').querySelector('.chat-approval-card__result').textContent, /^Allowed once/);
  assert.equal(card('r1').querySelector('.chat-approval-card__status').textContent, 'Allowed once.');
}));

test('a decision by keyboard keeps the focus on the card, not at the top of the window', withDom(async () => {
  const page = await mountCards();
  page.request(dto('r1'));
  const once = button('r1', 'allow-once');
  once.focus();
  once.click();
  focusFixup();
  // The card takes the focus before its buttons are disabled (CR-B13-03).
  assert.equal(document.activeElement === card('r1'), true);
  await settle();
  page.resolve({ requestId: 'r1', response: 'allow-once' });
  focusFixup();
  assert.equal(document.activeElement === card('r1'), true);
  assert.equal(card('r1').tabIndex, -1);
}));

test('a failed answer gives the buttons back, says why, and the focus returns to the button', withDom(async () => {
  const page = await mountCards({ respond: async () => ({ ok: false, error: 'the request belongs to another window' }) });
  page.request(dto('r1'));
  button('r1', 'deny').focus();
  button('r1', 'deny').click();
  await settle();
  assert.equal(button('r1', 'deny').disabled, false);
  assert.equal(button('r1', 'allow-once').disabled, false);
  assert.equal(
    card('r1').querySelector('.chat-approval-card__status').textContent,
    'Answer not accepted: the request belongs to another window. You can decide again.',
  );
  assert.equal(document.activeElement === button('r1', 'deny'), true);
  // And it can be answered again.
  button('r1', 'allow-once').click();
  await settle();
  assert.equal(page.calls.length, 2);
}));

test('an answer that fails after the request expired leaves the card resolved', withDom(async () => {
  let release;
  const page = await mountCards({ respond: () => new Promise((resolve) => { release = resolve; }) });
  page.request(dto('r1'));
  button('r1', 'allow-once').click();
  page.resolve({ requestId: 'r1', invalidated: true, reason: 'request_invalidated' });
  release({ ok: false, error: 'there is no open request with this ID' });
  await settle();
  assert.equal(card('r1').dataset.state, 'invalidated');
  assert.equal(card('r1').querySelector('.chat-approval-card__actions').hidden, true);
  assert.doesNotMatch(card('r1').querySelector('.chat-approval-card__status').textContent, /not accepted/);
}));

test('a cancelled "always" dialog leaves the card open without an error line (#121)', withDom(async () => {
  const page = await mountCards({
    respond: async () => ({ error: { key: 'approval.error.alwaysNotConfirmed' }, code: 'cancelled' }),
  });
  page.request(dto('r1', {
    tool: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    alwaysAllowed: true,
    preview: { kind: 'shell', text: 'gh pr list', shell: 'zsh', cwd: '/work' },
  }));
  button('r1', 'allow-always').focus();
  button('r1', 'allow-always').click();
  await settle();
  assert.equal(card('r1').dataset.state, 'pending');
  assert.equal(button('r1', 'allow-always').disabled, false);
  assert.equal(card('r1').querySelector('.chat-approval-card__status').textContent, 'Waiting for your decision. Esc denies.');
  assert.equal(document.activeElement === button('r1', 'allow-always'), true);
}));

test('Esc denies the oldest visible card of the chat on screen, from the composer or from nowhere', withDom(async () => {
  const page = await mountCards();
  page.request(dto('r1'));
  page.request(dto('r2'));
  const input = document.getElementById('chat-input');
  input.focus();
  const first = escapeOn(input);
  assert.equal(first.defaultPrevented, true);
  assert.deepEqual(page.calls, [['r1', 'deny']]);
  input.blur();
  escapeOn(document.body);
  assert.deepEqual(page.calls, [['r1', 'deny'], ['r2', 'deny']]);
}));

test('Esc leaves the card of a chat in the background alone (#320)', withDom(async () => {
  const page = await mountCards();
  page.request(dto('r1', { chatId: 'chat-b' }));
  assert.equal(card('r1') === null, true, 'not mounted while its chat is not on screen');
  escapeOn(document.body);
  assert.deepEqual(page.calls, []);
}));

test('Esc is left to an open overlay, the composer\'s completions and other fields (CR-B13-02)', withDom(async () => {
  const page = await mountCards();
  page.request(dto('r1'));
  const input = document.getElementById('chat-input');

  // The skill menu (`/`) and the mention menu (`@`) are listboxes.
  for (const id of ['chat-skill-menu', 'chat-mention-menu']) {
    const menu = document.getElementById(id);
    menu.classList.remove('hidden');
    let composerSaw = false;
    const listener = (e) => { if (e.key === 'Escape') composerSaw = true; };
    input.addEventListener('keydown', listener);
    input.focus();
    const event = escapeOn(input);
    input.removeEventListener('keydown', listener);
    menu.classList.add('hidden');
    assert.deepEqual(page.calls, [], `${id}: no denial`);
    assert.equal(event.defaultPrevented, false, `${id}: the key goes on`);
    assert.equal(composerSaw, true, `${id}: the composer's own handler gets the key`);
  }

  // Settings open above the chat.
  document.getElementById('modal-settings').classList.remove('hidden');
  escapeOn(document.body);
  document.getElementById('modal-settings').classList.add('hidden');
  assert.deepEqual(page.calls, []);

  // A field of its own — the PDF page number, a rename, a search.
  const field = document.createElement('input');
  document.getElementById('content-pane')?.appendChild(field) || document.body.appendChild(field);
  field.focus();
  escapeOn(field);
  assert.deepEqual(page.calls, []);
  assert.equal(card('r1').dataset.state, 'pending');
}));

test('Esc does not deny a card while the chat column is switched off (CR-B13-02)', withDom(async () => {
  const page = await mountCards();
  page.request(dto('r1'));
  document.getElementById('app').classList.add('app--no-chat');
  escapeOn(document.body);
  assert.deepEqual(page.calls, []);
  document.getElementById('app').classList.remove('app--no-chat');
  escapeOn(document.body);
  assert.deepEqual(page.calls, [['r1', 'deny']]);
}));

test('a background chat\'s card waits for its message, and leaves with its chat (#320)', withDom(async () => {
  const page = await mountCards();
  const message = { id: 'm-b' };
  page.cards.beginRun('chat-b', message);
  page.request(dto('r1', { chatId: 'chat-b' }));
  assert.equal(card('r1') === null, true);
  assert.deepEqual([...page.cards.pendingChatIds()], ['chat-b']);

  // The user opens chat B: its message is drawn and the card mounted into it.
  page.appStore.currentChatId = 'chat-b';
  const bubble = document.createElement('li');
  bubble.className = 'chat-msg assistant';
  document.getElementById('chat-messages').appendChild(bubble);
  page.cards.mount(bubble, message);
  assert.ok(bubble.contains(card('r1')));
  page.cards.mount(page.bubble, { id: 'other' });
  assert.ok(bubble.contains(card('r1')), 'another message does not take it');

  // Chat B is left and has nothing running: its cards go.
  page.cards.retainChats(['chat-a']);
  assert.equal(card('r1') === null, true);
  assert.equal(page.cards.pendingCount(), 0);
}));

test('"cancelled" only for a run stopped here; otherwise an expiry says why', withDom(async () => {
  const page = await mountCards();
  page.request(dto('r1'));
  page.appStore.chatRuns.set('chat-a', { aborted: true });
  page.resolve({ requestId: 'r1', invalidated: true, reason: 'request_invalidated' });
  assert.equal(card('r1').dataset.state, 'cancelled');
  assert.match(card('r1').querySelector('.chat-approval-card__result').textContent, /^Run cancelled/);

  page.request(dto('r2'));
  page.appStore.chatRuns.set('chat-a', { aborted: false });
  page.resolve({ requestId: 'r2', invalidated: true, reason: 'request_invalidated' });
  assert.equal(card('r2').dataset.state, 'invalidated');
  assert.match(card('r2').querySelector('.chat-approval-card__result').textContent, /^Request expired/);

  // A second resolution, or one for a request nobody knows, changes nothing.
  page.resolve({ requestId: 'r2', response: 'allow-once' });
  page.resolve({ requestId: 'unknown', response: 'allow-once' });
  assert.equal(card('r2').dataset.state, 'invalidated');
}));

test('a language change rebuilds an open card, keeps a decision on its way locked, and keeps the focus (#290)', withDom(async () => {
  const { setLocale } = await importRenderer('i18n.js');
  let release;
  const page = await mountCards({ respond: () => new Promise((resolve) => { release = resolve; }) });
  page.request(dto('r1'));
  page.request(dto('r2'));
  button('r1', 'allow-once').click();
  button('r2', 'deny').focus();
  try {
    setLocale('de');
    assert.equal(card('r1').querySelector('.chat-approval-card__title').textContent, 'Änderung bestätigen');
    assert.equal(button('r1', 'allow-once').disabled, true, 'the decision on its way stays locked');
    assert.equal(card('r1').querySelector('.chat-approval-card__status').textContent, 'Entscheidung wird übermittelt …');
    assert.equal(button('r2', 'deny').disabled, false);
    assert.equal(document.activeElement === button('r2', 'deny'), true, 'the focus follows into the new card');
  } finally {
    setLocale('en');
    release({ ok: true });
  }
}));

test('invisible characters are marked where they sit and named above the preview (CR-B13-01)', withDom(async () => {
  const page = await mountCards();
  const command = `echo safe ${RLO}${LRI}; echo PWNED ${PDI} ${LRI}#${PDI}${PDF}`;
  page.request(dto('r1', {
    tool: 'shell_execute',
    riskClasses: ['execute'],
    targets: [],
    alwaysUnavailableReason: 'not-simple',
    preview: { kind: 'shell', text: command, shell: 'zsh', cwd: '/work' },
  }));
  const preview = card('r1').querySelector('.chat-approval-card__preview-text');
  assert.equal(preview.textContent, 'echo safe ⟨U+202E⟩⟨U+2066⟩; echo PWNED ⟨U+2069⟩ ⟨U+2066⟩#⟨U+2069⟩⟨U+202C⟩');
  const warning = card('r1').querySelector('.chat-approval-card__warning--invisible');
  assert.ok(warning, 'the card says so');
  assert.match(warning.textContent, /^Careful: This call contains 6 invisible characters/);
  // The warning comes before the preview it is about.
  assert.equal(warning.compareDocumentPosition(preview) & window.Node.DOCUMENT_POSITION_FOLLOWING, window.Node.DOCUMENT_POSITION_FOLLOWING);

  page.request(dto('r2', { targets: [{ path: `invoice${RLO}fdp.exe`, kind: 'file', exists: false, sensitive: false }] }));
  assert.equal(card('r2').querySelector('.chat-approval-card__targets code').textContent, 'invoice⟨U+202E⟩fdp.exe');
  assert.match(card('r2').querySelector('.chat-approval-card__headline').textContent, /invoice⟨U\+202E⟩fdp\.exe/);

  page.request(dto('r3'));
  assert.equal(card('r3').querySelector('.chat-approval-card__warning--invisible') === null, true, 'nothing to say about plain text');
}));
