// The appearance (#999, AR-24): light, dark, or "system", which follows the
// operating system through `prefers-color-scheme` and changes with it while
// the window is open. What is stored is the choice; `data-theme` on the root
// is what the page shows.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer } = require('./helpers/dom.js');

/** A stand-in for the OS setting: a MediaQueryList whose answer the test flips. */
function fakeSystem(window, { dark = false } = {}) {
  const listeners = new Set();
  const list = {
    media: '(prefers-color-scheme: dark)',
    matches: dark,
    addEventListener: (type, fn) => { if (type === 'change') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  window.matchMedia = (query) => {
    assert.equal(query, '(prefers-color-scheme: dark)');
    return list;
  };
  return {
    turn(value) {
      list.matches = value;
      for (const fn of listeners) fn({ matches: value, media: list.media });
    },
  };
}

async function mount({ stored = null, dark = false, onChange } = {}) {
  const dom = setupRendererDom({ markup: '<!doctype html><html><body></body></html>' });
  globalThis.localStorage = dom.window.localStorage;
  if (stored !== null) localStorage.setItem('theme', stored);
  const system = fakeSystem(dom.window, { dark });
  const { initTheme } = await importRenderer('components', 'ThemeManager.js');
  const theme = initTheme({ onChange });
  const shown = () => document.documentElement.getAttribute('data-theme') ?? 'light';
  return { dom, system, theme, shown, cleanup: () => { delete globalThis.localStorage; dom.cleanup(); } };
}

test('without a stored choice the app is light, whatever the system says', async (t) => {
  const { theme, shown, cleanup } = await mount({ dark: true });
  t.after(cleanup);
  assert.equal(theme.getTheme(), 'light');
  assert.equal(shown(), 'light');
});

for (const choice of ['light', 'dark']) {
  test(`a stored "${choice}" ignores the system`, async (t) => {
    const { theme, system, shown, cleanup } = await mount({ stored: choice, dark: choice === 'light' });
    t.after(cleanup);
    assert.equal(shown(), choice);
    system.turn(choice !== 'dark');
    assert.equal(shown(), choice, `${choice} stays ${choice} when the system turns`);
    assert.equal(theme.getEffectiveTheme(), choice);
  });
}

test('"system" shows what the OS asks for and follows it while the window is open', async (t) => {
  const changes = [];
  const { theme, system, shown, cleanup } = await mount({ stored: 'system', dark: true, onChange: (v) => changes.push(v) });
  t.after(cleanup);

  assert.equal(theme.getTheme(), 'system', 'the choice is kept as such');
  assert.equal(shown(), 'dark');
  assert.equal(theme.getEffectiveTheme(), 'dark');

  system.turn(false);
  assert.equal(shown(), 'light');
  system.turn(true);
  assert.equal(shown(), 'dark');
  assert.deepEqual(changes, ['light', 'dark'], 'onChange hears every switch, not the first draw');
});

test('picking an appearance stores the choice, and leaving "system" stops following', async (t) => {
  const { theme, system, shown, cleanup } = await mount({ stored: 'light' });
  t.after(cleanup);

  assert.equal(theme.setTheme('system'), 'system');
  assert.equal(localStorage.getItem('theme'), 'system');
  assert.equal(shown(), 'light');
  system.turn(true);
  assert.equal(shown(), 'dark');

  assert.equal(theme.setTheme('light'), 'light');
  system.turn(false);
  system.turn(true);
  assert.equal(shown(), 'light', 'a fixed choice does not follow the system any more');
});

test('an unknown stored value falls back to light', async (t) => {
  const { theme, shown, cleanup } = await mount({ stored: 'sepia', dark: true });
  t.after(cleanup);
  assert.equal(theme.getTheme(), 'light');
  assert.equal(shown(), 'light');
  assert.equal(localStorage.getItem('theme'), 'light');
});
