// The model pill and its menu (#583), on the real DOM.
//
// The pill showed the model but announced "Choose the active model", the
// German name was marked as English, and the listbox had no keyboard model.
// It now follows the mode menu next to it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const entry = (id, model, extra = {}) => ({
  id, providerId: 'openai', model, entryName: 'OpenAI', label: `OpenAI · ${model}`, configured: true, ...extra,
});

function llmState({ presets, reasoning } = {}) {
  return {
    activeProvider: 'openai',
    activePresetId: 'p1',
    chatTarget: { providerId: 'openai', model: 'gpt-5' },
    encryptionAvailable: true,
    providers: [{ id: 'openai', name: 'OpenAI', configured: true, model: 'gpt-5' }],
    presets: presets ?? [entry('p1', 'gpt-5'), entry('p2', 'gpt-5-mini'), entry('p3', 'o4')],
    reasoning: reasoning ?? { level: null, levels: [], defaultLevel: null },
  };
}

async function setup({ locale = 'en', state = llmState(), userAgent = null, setReasoningEffort } = {}) {
  const dom = setupRendererDom();
  if (userAgent) {
    // The renderer reads the global `navigator`, which under Node 24 may be
    // Node's own rather than happy-dom's.
    Object.defineProperty(globalThis.navigator, 'userAgent', { value: userAgent, configurable: true });
  }
  const { initChatModelPicker } = await importRenderer('components', 'ChatModelPicker.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale);
  appStore.rootPath = '/work';
  appStore.chatMessages = [];
  const chosen = [];
  const levels = [];
  // A level that is kept shows up in the next state main sends (#727).
  let current = state;
  const picker = initChatModelPicker({
    api: {
      getLLMState: async () => current,
      setActivePreset: async (id) => { chosen.push(id); return { ok: true }; },
      setReasoningEffort: setReasoningEffort || (async (level) => {
        levels.push(level);
        current = { ...current, reasoning: { ...current.reasoning, level } };
        return { ok: true };
      }),
    },
    appStore,
  });
  await picker.refreshLLMState();
  const document = dom.document;
  return {
    dom,
    document,
    chosen,
    levels,
    pill: document.getElementById('btn-chat-model-picker'),
    menu: document.getElementById('chat-model-menu'),
    options: () => [...document.querySelectorAll('#chat-model-menu .chat-model-menu-option')],
    // A pick with the mouse: the press first, then the click (#737).
    pick: (value) => {
      const input = document.querySelector(`#chat-reasoning-levels input[value="${value}"]`);
      const label = input.closest('label');
      label.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      input.click();
      return input;
    },
    key: (target, key) => {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    },
  };
}

test('the accessible name starts with the model the pill shows', async () => {
  const { pill } = await setup();
  assert.equal(pill.getAttribute('aria-label'), 'Model gpt-5. Switch model');
  assert.ok(pill.getAttribute('aria-label').includes(pill.textContent.trim()));
});

test('in German the name is not marked as English — only the model name is', async () => {
  const { pill, document } = await setup({ locale: 'de' });
  assert.equal(pill.getAttribute('aria-label'), 'Modell gpt-5. Modell wechseln');
  assert.equal(pill.getAttribute('lang'), null);
  assert.equal(document.getElementById('chat-model-pill-label').getAttribute('lang'), 'en');
});

test('opening puts the focus on the selected option', async () => {
  const { pill, menu, document, options } = await setup();
  pill.click();
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(pill.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, options()[0]);
  assert.equal(document.activeElement.getAttribute('aria-selected'), 'true');
});

test('the arrow keys move and wrap, Home and End jump', async () => {
  const { pill, document, options, key } = await setup();
  pill.click();
  key(document.activeElement, 'ArrowDown');
  assert.equal(document.activeElement, options()[1]);
  key(document.activeElement, 'ArrowUp');
  key(document.activeElement, 'ArrowUp');
  assert.equal(document.activeElement, options()[2], 'up from the first wraps to the last');
  key(document.activeElement, 'Home');
  assert.equal(document.activeElement, options()[0]);
  key(document.activeElement, 'End');
  assert.equal(document.activeElement, options()[2]);
});

test('Escape closes and gives the focus back to the pill', async () => {
  const { pill, menu, document, key } = await setup();
  pill.click();
  const event = key(document.activeElement, 'Escape');
  assert.equal(event.defaultPrevented, true);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(pill.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, pill);
});

test('choosing an option switches the preset and returns the focus to the pill', async () => {
  const { pill, menu, document, options, chosen } = await setup();
  pill.click();
  options()[1].click();
  await flush();
  assert.deepEqual(chosen, ['p2']);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(document.activeElement, pill);
});

test('tabbing out of the menu closes it', async () => {
  const { pill, menu, document } = await setup();
  pill.click();
  document.getElementById('btn-chat-send').focus();
  await flush();
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(pill.getAttribute('aria-expanded'), 'false');
});

test('the active preset stays in the menu even when it is hidden from it', async () => {
  const { pill, options } = await setup({
    state: llmState({
      presets: [
        entry('p1', 'gpt-5', { menuVisible: false }),
        entry('p2', 'gpt-5-mini'),
      ],
    }),
  });
  pill.click();
  assert.deepEqual(options().map((o) => o.dataset.presetId), ['p1', 'p2']);
});

test('without a preset to switch to, the pill is no menu that opens nothing', async () => {
  const { pill, menu } = await setup({ state: llmState({ presets: [] }) });
  assert.equal(pill.classList.contains('hidden'), false, 'the model is still named');
  assert.equal(pill.disabled, true);
  pill.click();
  assert.equal(menu.classList.contains('hidden'), true);
});

// #670: the hint pointed at a gear icon that is gone. It names the menu path
// and the shortcut of the platform instead.
const unconfigured = () => ({
  ...llmState({ presets: [{ id: 'p1', label: 'OpenAI · gpt-4o-mini', configured: false }] }),
  providers: [{ id: 'openai', name: 'OpenAI', configured: false, model: 'gpt-4o-mini' }],
  chatTarget: { providerId: 'openai', model: 'gpt-4o-mini' },
});

for (const [platform, userAgent, locale, expected] of [
  ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'en',
    'Set up a language model to start chatting: Snotra AI › Settings… (⌘,).'],
  ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'en',
    'Set up a language model to start chatting: View › Settings… (Ctrl+,).'],
  ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'de',
    'Richte ein Sprachmodell ein, um zu chatten: Snotra AI › Einstellungen… (⌘,).'],
  ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 'de',
    'Richte ein Sprachmodell ein, um zu chatten: Ansicht › Einstellungen… (Strg+,).'],
]) {
  test(`without a usable model the hint names the way to the settings on ${platform} (${locale})`, async () => {
    const { document } = await setup({ locale, userAgent, state: unconfigured() });
    const hint = document.getElementById('chat-hint');
    assert.equal(hint.classList.contains('hidden'), false);
    assert.equal(hint.textContent, expected);
    assert.equal(document.getElementById('btn-chat-send').disabled, true);
  });
}

// The reasoning level in the model menu (#727).
const withLevels = (level = 'medium', extra = {}) => llmState({
  reasoning: { level, levels: LEVELS, defaultLevel: 'medium' },
  ...extra,
});

test('the pill names model and level, without the provider (#727)', async () => {
  const { pill, document } = await setup({ state: withLevels('high') });
  assert.equal(pill.textContent.trim(), 'gpt-5 · high');
  assert.equal(document.querySelector('.chat-model-pill-level').textContent, ' · high');
  assert.equal(pill.getAttribute('aria-label'), 'Model gpt-5 · high. Switch model or reasoning level');
  assert.ok(pill.getAttribute('aria-label').includes(pill.textContent.trim()));
});

test('the menu lists models without the provider, and names the entry only for twins (#727)', async () => {
  const twins = [
    entry('p1', 'gpt-5'),
    { id: 'p4', providerId: 'openai-compatible', model: 'qwen3:32b', entryName: 'Mac Studio', configured: true },
    { id: 'p5', providerId: 'openai-compatible', model: 'qwen3:32b', entryName: 'Ollama', configured: true },
  ];
  const { pill, options } = await setup({ state: llmState({ presets: twins }) });
  pill.click();
  assert.deepEqual(options().map((o) => o.textContent), ['gpt-5', 'qwen3:32b · Mac Studio', 'qwen3:32b · Ollama']);
});

test('a model without levels shows no reasoning section (#727)', async () => {
  const { pill, document } = await setup();
  pill.click();
  assert.equal(document.getElementById('chat-reasoning').hidden, true);
  assert.equal(pill.textContent.trim(), 'gpt-5');
});

test('the levels are a radio group below the models, with the chat\'s level checked (#727)', async () => {
  const { pill, document } = await setup({ state: withLevels('low') });
  pill.click();
  const section = document.getElementById('chat-reasoning');
  assert.equal(section.hidden, false);
  const group = document.getElementById('chat-reasoning-levels');
  assert.equal(group.getAttribute('role'), 'radiogroup');
  assert.equal(document.getElementById(group.getAttribute('aria-labelledby')).textContent, 'Reasoning');
  const radios = [...group.querySelectorAll('input[type="radio"]')];
  assert.deepEqual(radios.map((r) => r.value), LEVELS);
  assert.equal(radios.find((r) => r.checked).value, 'low');
  assert.equal(document.getElementById('chat-reasoning-hint').textContent, 'Applies to this chat. New chats start with medium.');
  // The levels sit outside the listbox: a listbox owns nothing but options.
  assert.equal(document.getElementById('chat-model-list').contains(group), false);
});

test('a click on a level applies it and closes the menu (#727, #737)', async () => {
  const { pill, menu, document, levels, chosen, pick } = await setup({ state: withLevels('medium') });
  pill.click();
  pick('high');
  await flush();
  assert.deepEqual(levels, ['high']);
  assert.deepEqual(chosen, []);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(pill.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, pill);
  assert.equal(pill.textContent.trim(), 'gpt-5 · high');
});

test('a click on the level that holds closes the menu without a request (#737)', async () => {
  const { pill, menu, document, levels, pick } = await setup({ state: withLevels('medium') });
  pill.click();
  pick('medium');
  await flush();
  assert.deepEqual(levels, []);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(document.activeElement, pill);
});

test('the arrow keys apply a level and keep the menu open; Enter closes it (#737)', async () => {
  const { pill, menu, document, levels, key } = await setup({ state: withLevels('medium') });
  pill.click();
  const medium = document.querySelector('#chat-reasoning-levels input[value="medium"]');
  medium.focus();
  key(medium, 'ArrowRight');
  // happy-dom does not walk a radio group; this is what a browser does next.
  const high = document.querySelector('#chat-reasoning-levels input[value="high"]');
  high.checked = true;
  high.focus();
  high.dispatchEvent(new document.defaultView.Event('change', { bubbles: true }));
  await flush();
  assert.deepEqual(levels, ['high']);
  assert.equal(menu.classList.contains('hidden'), false);

  const enter = key(high, 'Enter');
  assert.equal(enter.defaultPrevented, true);
  await flush();
  assert.deepEqual(levels, ['high'], 'the level that holds is not sent again');
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(document.activeElement, pill);
});

test('Enter on a level that is not set yet applies it and closes the menu (#737)', async () => {
  const { pill, menu, document, levels, key } = await setup({ state: withLevels('medium') });
  pill.click();
  const low = document.querySelector('#chat-reasoning-levels input[value="low"]');
  low.focus();
  key(low, 'Enter');
  await flush();
  assert.deepEqual(levels, ['low']);
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(pill.textContent.trim(), 'gpt-5 · low');
});

test('a refused level goes back, says why and keeps the menu open (#727, #737)', async () => {
  const { pill, menu, document, pick } = await setup({
    state: withLevels('medium'),
    setReasoningEffort: async () => ({ ok: false, error: { key: 'settings.error.reasoningNoChat' } }),
  });
  pill.click();
  pick('max');
  await flush();
  assert.equal(menu.classList.contains('hidden'), false);
  assert.equal(document.querySelector('#chat-reasoning-levels input:checked').value, 'medium');
  const status = document.getElementById('chat-reasoning-status');
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, 'The reasoning level could not be set: no chat is open.');
  assert.equal(pill.textContent.trim(), 'gpt-5 · medium');
});

test('the model list is one tab stop; the levels keep their own arrow keys (#727)', async () => {
  const { pill, menu, document, options, key } = await setup({ state: withLevels('medium') });
  pill.click();
  assert.deepEqual(options().map((o) => o.tabIndex), [0, -1, -1]);
  key(document.activeElement, 'ArrowDown');
  assert.deepEqual(options().map((o) => o.tabIndex), [-1, 0, -1]);

  const radio = document.querySelector('#chat-reasoning-levels input:checked');
  radio.focus();
  const event = key(radio, 'ArrowDown');
  assert.equal(event.defaultPrevented, false, 'the list does not take the radio group\'s keys');
  assert.equal(document.activeElement, radio);

  key(radio, 'Escape');
  assert.equal(menu.classList.contains('hidden'), true);
  assert.equal(document.activeElement, pill);
});

test('a single entry with levels still opens: the level can be changed (#727)', async () => {
  const { pill, menu } = await setup({ state: withLevels('medium', { presets: [entry('p1', 'gpt-5')] }) });
  assert.equal(pill.disabled, false);
  pill.click();
  assert.equal(menu.classList.contains('hidden'), false);
});

test('a press on a level gives the focus to its radio, so the menu stays open (#727)', async () => {
  const { pill, menu, document, dom } = await setup({ state: withLevels('medium') });
  pill.click();
  const word = document.querySelector('#chat-reasoning-levels input[value="high"]').closest('label').querySelector('span');
  const press = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  word.dispatchEvent(press);
  assert.equal(press.defaultPrevented, true);
  assert.equal(document.activeElement, document.querySelector('#chat-reasoning-levels input[value="high"]'));
  assert.equal(menu.classList.contains('hidden'), false);

  const hint = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  document.getElementById('chat-reasoning-hint').dispatchEvent(hint);
  assert.equal(hint.defaultPrevented, true, 'a press on the text keeps the focus where it is');
});
