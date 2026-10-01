// The model pill and its menu (#583), on the real DOM.
//
// The pill showed the model but announced "Choose the active model", the
// German name was marked as English, and the listbox had no keyboard model.
// It now follows the mode menu next to it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

function llmState({ presets } = {}) {
  return {
    activeProvider: 'openai',
    activePresetId: 'p1',
    chatTarget: { providerId: 'openai', model: 'gpt-5' },
    encryptionAvailable: true,
    providers: [{ id: 'openai', name: 'OpenAI', configured: true, model: 'gpt-5' }],
    presets: presets ?? [
      { id: 'p1', label: 'OpenAI · gpt-5', configured: true },
      { id: 'p2', label: 'OpenAI · gpt-5-mini', configured: true },
      { id: 'p3', label: 'OpenAI · o4', configured: true },
    ],
  };
}

async function setup({ locale = 'en', state = llmState() } = {}) {
  const dom = setupRendererDom();
  const { initChatModelPicker } = await importRenderer('components', 'ChatModelPicker.js');
  const { appStore } = await importRenderer('state', 'store.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale);
  appStore.rootPath = '/work';
  appStore.chatMessages = [];
  const chosen = [];
  const picker = initChatModelPicker({
    api: {
      getLLMState: async () => state,
      setActivePreset: async (id) => { chosen.push(id); return { ok: true }; },
    },
    appStore,
  });
  await picker.refreshLLMState();
  const document = dom.document;
  return {
    dom,
    document,
    chosen,
    pill: document.getElementById('btn-chat-model-picker'),
    menu: document.getElementById('chat-model-menu'),
    options: () => [...document.querySelectorAll('#chat-model-menu .chat-model-menu-option')],
    key: (target, key) => {
      const event = new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      return event;
    },
  };
}

test('the accessible name starts with the model the pill shows', async () => {
  const { pill } = await setup();
  assert.equal(pill.getAttribute('aria-label'), 'Model OpenAI · gpt-5. Switch model');
  assert.ok(pill.getAttribute('aria-label').includes(pill.textContent.trim()));
});

test('in German the name is not marked as English — only the model name is', async () => {
  const { pill, document } = await setup({ locale: 'de' });
  assert.equal(pill.getAttribute('aria-label'), 'Modell OpenAI · gpt-5. Modell wechseln');
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
        { id: 'p1', label: 'OpenAI · gpt-5', configured: true, menuVisible: false },
        { id: 'p2', label: 'OpenAI · gpt-5-mini', configured: true },
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
