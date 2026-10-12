// The proposal card (#774) as a component: the compact layout decided on
// 2026-10-12 — the name and the catalogue's sentence in the headline, risk or
// origin below, the model's reason folded away — the answer it sends, Escape,
// and the folded line once decided. The engine's side is in
// chat-engine-config-proposal.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer, focusFixup } = require('./helpers/dom.js');

// Escape answers the card that is laid out; happy-dom lays out nothing (#78).
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

function dto(requestId, config = {}) {
  return {
    contractVersion: 1,
    requestId,
    chatId: 'chat-a',
    tool: 'propose_config_change',
    riskClasses: [],
    targets: [],
    mode: 'smart',
    sessionAllowed: false,
    checkpoint: 'config',
    config: {
      kind: 'tool',
      name: 'fetch_url',
      enable: true,
      reason: 'To read the page you linked.',
      descriptionKey: 'tools.short.fetch_url',
      description: 'stale text from main',
      riskClasses: ['external'],
      settingsMenu: 'settings.security',
      ...config,
    },
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
  initToolApprovalCards({ api, appStore: { currentChatId: 'chat-a', chatRuns: new Map() }, getHomeDir: () => '' });
  return { calls, request: (v) => handlers.request(v), resolve: (v) => handlers.resolved(v) };
}

const card = (id) => document.querySelector(`.chat-approval-card[data-request-id="${id}"]`);
const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const meta = (el) => [...el.querySelectorAll('.chat-approval-card__meta > span:not([aria-hidden])')].map(text);
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

test('a tool proposal: the catalogue\'s sentence, its risk, the reason folded away', withDom(async () => {
  const page = await mount();
  page.request(dto('p1'));
  const el = card('p1');
  assert.ok(el.classList.contains('chat-approval-card--config'));
  assert.equal(text(el.querySelector('.chat-approval-card__title')), 'Switch on for this chat');
  const headline = el.querySelector('.chat-approval-card__headline');
  assert.equal(text(headline.querySelector('code')), 'fetch_url');
  // The app's own sentence in the interface language, not the text main sent.
  assert.doesNotMatch(text(headline), /stale text/);
  assert.match(text(headline), /^fetch_url \S/);
  assert.deepEqual(meta(el), ['External services', 'this chat only']);
  const why = el.querySelector('.chat-approval-card__why');
  assert.equal(why.open, false, 'the model\'s reason is folded away');
  assert.equal(text(why.querySelector('summary')), 'The model’s reason');
  assert.equal(text(why.querySelector('.chat-approval-card__why-text')), 'To read the page you linked.');
  const buttons = [...el.querySelectorAll('.chat-approval-card__actions button')];
  assert.deepEqual(buttons.map(text), ['Switch on', 'Decline']);
  assert.match(text(el.querySelector('.chat-approval-card__status')), /New chats keep your settings — to keep it on: Settings › Tools & security\. Esc declines\./);

  buttons[0].click();
  await settle();
  assert.deepEqual(page.calls.at(-1), { requestId: 'p1', response: 'allow-once', extra: undefined });
  page.resolve({ requestId: 'p1', response: 'allow-once' });
  // Decided, it folds to the decision and the name — not the description.
  const toggle = el.querySelector('.chat-approval-card__toggle');
  assert.equal(text(toggle.querySelector('.chat-approval-card__toggle-label')), 'Switched on for this chat');
  assert.equal(text(toggle.querySelector('.chat-approval-card__toggle-headline')), 'fetch_url');
  assert.match(text(el.querySelector('.chat-approval-card__result')), /^Switched on for this chat New chats keep your settings\./);
}));

test('a folder skill: its description labelled as its author\'s, its origin named', withDom(async () => {
  const page = await mount();
  page.request(dto('p2', {
    kind: 'skill', name: 'pdf-export', descriptionKey: undefined, description: 'Turns Markdown into a PDF.',
    descriptionIsData: true, origin: 'folder', riskClasses: undefined, settingsMenu: 'settings.skills', reason: '',
  }));
  const el = card('p2');
  assert.equal(text(el.querySelector('.chat-approval-card__headline')), 'pdf-export From the skill’s author: “Turns Markdown into a PDF.”');
  assert.deepEqual(meta(el), ['Folder skill', 'this chat only']);
  assert.equal(el.querySelector('.chat-approval-card__why'), null, 'no reason, no fold');
  assert.match(text(el.querySelector('.chat-approval-card__status')), /Settings › Skills/);
}));

test('switching off: its own words, and Escape keeps it on', withDom(async () => {
  const page = await mount();
  page.request(dto('p3', { enable: false }));
  const el = card('p3');
  assert.equal(text(el.querySelector('.chat-approval-card__title')), 'Switch off for this chat');
  assert.deepEqual([...el.querySelectorAll('.chat-approval-card__actions button')].map(text), ['Switch off', 'Keep it on']);
  await settle();
  el.focus();
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle();
  assert.deepEqual(page.calls.at(-1), { requestId: 'p3', response: 'deny', extra: undefined });
  page.resolve({ requestId: 'p3', response: 'deny' });
  assert.equal(el.dataset.state, 'denied');
  assert.equal(text(el.querySelector('.chat-approval-card__toggle-label')), 'Declined');
  assert.match(text(el.querySelector('.chat-approval-card__result')), /Snotra will not suggest this again in this chat\./);
}));
