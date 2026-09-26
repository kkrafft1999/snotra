// Settings › Memory in both interface languages (#375).
//
// The panel formatted dates as DD.MM.YYYY and character counts with a German
// number format whatever the language, and its badge for entries Snotra kept
// on its own was a German literal. Checked here: all three follow the app
// language, and a switch redraws them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const MEMORY = {
  available: true,
  selfEnabled: true,
  scopes: [
    {
      scope: 'user',
      path: '/home/me/.snotra/memory.md',
      shortPath: '~/.snotra/memory.md',
      enabled: true,
      chars: 1234,
      maxChars: 8000,
      truncated: false,
      entries: [
        { line: 1, date: '2026-09-21', text: 'Prefers tabs.', origin: 'self' },
        { line: 2, date: 'someday', text: 'Likes tea.', origin: 'requested' },
      ],
    },
  ],
};

async function mount() {
  const dom = setupRendererDom();
  const { initMemoryPanel } = await importRenderer('components', 'MemoryPanel.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const api = {
    getMemory: async () => structuredClone(MEMORY),
    setUIPrefs: async (prefs) => prefs,
    forgetMemoryEntry: async () => ({ ok: false }),
  };
  const panel = initMemoryPanel({ api });
  await panel.refresh();

  const host = dom.document.getElementById('settings-memory-scopes');
  const dates = () => [...host.querySelectorAll('.memory-item__date')].map((el) => el.textContent);
  const badges = () => [...host.querySelectorAll('.memory-item__origin')].map((el) => el.textContent);
  const meta = () => host.querySelector('.memory-meta').textContent;

  return {
    dates, badges, meta, setLocale,
    cleanup: () => { setLocale('en', { force: true }); dom.cleanup(); },
  };
}

test('English: ISO dates, English number format and an English badge', async (t) => {
  const ui = await mount();
  t.after(ui.cleanup);

  assert.deepEqual(ui.dates(), ['2026-09-21', 'someday'], 'an unparseable date stays as written');
  assert.deepEqual(ui.badges(), ['remembered on its own']);
  assert.match(ui.meta(), /1,234 of 8,000 characters/);
});

test('German: dates, numbers and badge follow a switch to German', async (t) => {
  const ui = await mount();
  t.after(ui.cleanup);

  ui.setLocale('de');
  await flush();
  assert.deepEqual(ui.dates(), ['21.09.2026', 'someday']);
  assert.deepEqual(ui.badges(), ['selbst gemerkt']);
  assert.match(ui.meta(), /1\.234 von 8\.000 Zeichen/);
});
