// "Distil into knowledge…" in the chat header (#1317), on the real DOM.
//
// The button sends a visible request in the interface language. It cannot run
// in an empty chat or while an answer is on its way; then it stays focusable
// (aria-disabled, not disabled) and its description says why. In a narrow
// header only its icon shows, and the tooltip names the action.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

/** A click sends on the next microtask. */
const click = async (button) => { button.click(); await new Promise((resolve) => setImmediate(resolve)); };

const QUESTION = [{ role: 'user', content: 'Which beds get the beans?' }, { role: 'assistant', content: 'The north bed.' }];

async function setup({ locale = 'en', messages = QUESTION, inFlight = false, modelReady } = {}) {
  const dom = setupRendererDom();
  const { initChatDistilAction, DISTIL_MIN_TITLE_ROOM_PX } = await importRenderer('components', 'ChatDistilAction.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale);
  appStore.chatMessages = messages;
  appStore.chatInFlight = inFlight;
  const sent = [];
  const distil = initChatDistilAction({ appStore, send: (text) => sent.push(text), modelReady });
  const document = dom.document;
  const button = document.getElementById('btn-chat-distil');
  return {
    dom, document, appStore, distil, sent, button, DISTIL_MIN_TITLE_ROOM_PX,
    reason: document.getElementById('chat-distil-reason'),
    label: button.querySelector('.chat-distil-label'),
  };
}

test('the button sits in the chat header, named by its label and described by its reason', async () => {
  const { document, button, reason, label } = await setup();
  assert.ok(document.getElementById('chat-header').contains(button));
  assert.equal(button.tagName, 'BUTTON');
  assert.equal(button.getAttribute('type'), 'button');
  assert.equal(label.textContent, 'Distil into knowledge…');
  assert.equal(button.getAttribute('aria-describedby'), 'chat-distil-reason');
  assert.equal(reason.hidden, true, 'read as the description, not shown twice');
});

test('ready: it runs, and says what it does', async () => {
  const { button, reason, sent } = await setup();
  assert.equal(button.dataset.state, 'ready');
  assert.equal(button.hasAttribute('aria-disabled'), false);
  assert.equal(reason.textContent, 'Go through this chat and propose what to keep — facts, rules, skills — one card at a time.');
  assert.equal(button.title, reason.textContent);
  await click(button);
  assert.deepEqual(sent, ['Distil this chat: what do we take away from it? Propose each fact, rule or skill worth keeping, one at a time.']);
});

test('an empty chat: disabled with its reason, still focusable, and a click sends nothing', async () => {
  // The greeting alone is no question.
  const { button, reason, sent } = await setup({ messages: [{ role: 'assistant', content: 'Hello', greeting: true }] });
  assert.equal(button.dataset.state, 'empty');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.disabled, false, 'aria-disabled keeps the tooltip and the focus');
  assert.equal(reason.textContent, 'Nothing to distil yet: this chat has no messages.');
  assert.equal(button.title, reason.textContent);
  button.focus();
  assert.equal(button.ownerDocument.activeElement, button);
  await click(button);
  assert.deepEqual(sent, []);
});

test('without a model: disabled with its reason instead of a click that does nothing', async () => {
  let ready = false;
  const { button, reason, sent, distil } = await setup({ modelReady: () => ready });
  assert.equal(button.dataset.state, 'noModel');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(reason.textContent, 'Available once a model is set up.');
  await click(button);
  assert.deepEqual(sent, []);
  ready = true;
  distil.sync();
  assert.equal(button.dataset.state, 'ready');
});

test('while an answer is on its way: disabled with its reason, ready again afterwards', async () => {
  const { appStore, distil, button, reason, sent } = await setup({ inFlight: true });
  assert.equal(button.dataset.state, 'running');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(reason.textContent, 'Available once the answer is finished.');
  await click(button);
  assert.deepEqual(sent, []);

  appStore.chatInFlight = false;
  distil.sync();
  assert.equal(button.dataset.state, 'ready');
  assert.equal(button.hasAttribute('aria-disabled'), false);
  await click(button);
  assert.equal(sent.length, 1);
});

test('in German the request and the reasons are German, addressing the user as du', async () => {
  const { button, reason, sent, appStore, distil } = await setup({ locale: 'de' });
  assert.equal(reason.textContent, 'Diesen Chat durchgehen und vorschlagen, was bleiben soll — Fakten, Regeln, Skills —, eine Karte nach der anderen.');
  await click(button);
  assert.deepEqual(sent, ['Leite Wissen aus diesem Chat ab: Was nehmen wir daraus mit? Schlag jeden Fakt, jede Regel und jeden Skill, die bleiben sollen, einzeln vor.']);
  appStore.chatInFlight = true;
  distil.sync();
  assert.equal(reason.textContent, 'Geht, sobald die Antwort fertig ist.');
  appStore.chatInFlight = false;
  appStore.chatMessages = [];
  distil.sync();
  assert.equal(reason.textContent, 'Noch nichts abzuleiten: Dieser Chat hat keine Nachrichten.');
});

test('a header too narrow for the label shows only the icon; the tooltip then names the action', async () => {
  const { document, distil, button, label, DISTIL_MIN_TITLE_ROOM_PX } = await setup();
  const header = document.getElementById('chat-header');
  const pill = document.getElementById('btn-chat-kind');
  document.getElementById('chat-kind-wrap').classList.remove('hidden');
  const width = (element, prop, value) => Object.defineProperty(element, prop, { configurable: true, get: () => value });
  width(label, 'scrollWidth', 130);
  width(pill, 'scrollWidth', 100);

  // 130 px label + 44 px around it + 102 px pill leave the title less than the minimum.
  width(header, 'clientWidth', 130 + 44 + 102 + DISTIL_MIN_TITLE_ROOM_PX - 1);
  distil.sync();
  assert.equal(button.classList.contains('chat-distil--compact'), true);
  assert.equal(button.title, 'Distil into knowledge…\nGo through this chat and propose what to keep — facts, rules, skills — one card at a time.');
  assert.equal(label.textContent, 'Distil into knowledge…', 'the label stays in the tree: the name does not change');

  width(header, 'clientWidth', 130 + 44 + 102 + DISTIL_MIN_TITLE_ROOM_PX);
  distil.sync();
  assert.equal(button.classList.contains('chat-distil--compact'), false);
  assert.equal(button.title, 'Go through this chat and propose what to keep — facts, rules, skills — one card at a time.');
});
