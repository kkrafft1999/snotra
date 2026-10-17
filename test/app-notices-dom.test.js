const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

/**
 * The notice strip under the title bar (#1001): notices from before the
 * window and pushed ones, worded in the interface language, with the path of
 * the kept copy, a way to show it, and a close button.
 */

const SET_ASIDE = Object.freeze({
  id: 'store:llm-config.json',
  kind: 'store-set-aside',
  store: 'models',
  file: 'llm-config.json',
  location: '/profile/llm-config.json.unreadable-2026-10-16T09-12-44-120Z',
  canReveal: true,
});

const NOT_SAVED = Object.freeze({
  id: 'store:ui-preferences.json',
  kind: 'store-not-saved',
  store: 'uiPreferences',
  file: 'ui-preferences.json',
  location: '/profile/ui-preferences.json',
  canReveal: true,
});

const BACKGROUND = Object.freeze({
  id: 'background-error',
  kind: 'background-error',
  count: 1,
  location: '/profile/logs/main.log',
  canReveal: true,
});

async function mount({ locale = 'en', listed = [], platform = 'darwin', copyResult = { ok: true } } = {}) {
  const dom = setupRendererDom();
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale, { force: true });
  const { initAppNotices } = await importRenderer('components', 'AppNotices.js');

  const calls = [];
  const push = { posted: () => {}, withdrawn: () => {} };
  const api = {
    listNotices: async () => ({ notices: listed, platform }),
    dismissNotice: async (id) => { calls.push(`dismiss:${id}`); return { ok: true }; },
    revealNotice: async (id) => { calls.push(`reveal:${id}`); return { ok: true }; },
    openManual: async (target) => { calls.push(`manual:${target.slug}#${target.fragment ?? ''}`); return { ok: true }; },
    copyDiagnostics: async () => { calls.push('copy'); if (copyResult instanceof Error) throw copyResult; return copyResult; },
    onNoticePosted: (cb) => { push.posted = cb; },
    onNoticeWithdrawn: (cb) => { push.withdrawn = cb; },
  };
  initAppNotices({ api });
  await flush();

  const root = dom.document.getElementById('app-notices');
  const entries = () => Array.from(root.querySelectorAll('.app-notice'));
  const button = (entry, action) => entry.querySelector(`[data-action="${action}"]`);
  return { dom, root, entries, button, calls, push, setLocale };
}

test('no notice: the strip is hidden', async () => {
  const { root, entries } = await mount();
  assert.equal(root.hidden, true);
  assert.equal(entries().length, 0);
});

test('a set-aside from before the window names the store, the file and the copy', async () => {
  const { root, entries, button, calls } = await mount({ listed: [SET_ASIDE] });

  assert.equal(root.hidden, false);
  const [entry] = entries();
  assert.ok(entry.classList.contains('app-notice--info'));
  assert.equal(entry.querySelector('.app-notice-heading').textContent, 'Your model settings were reset.');
  assert.match(entry.querySelector('.app-notice-text').textContent, /could not read llm-config\.json/);
  assert.equal(entry.querySelector('.app-notice-path').textContent, SET_ASIDE.location);

  assert.equal(button(entry, 'reveal').textContent, 'Reveal in Finder');
  button(entry, 'reveal').click();
  button(entry, 'help').click();
  await flush();
  assert.deepEqual(calls, ['reveal:store:llm-config.json', 'manual:troubleshooting/files-set-aside#']);
});

test('in German, with the Windows file manager', async () => {
  const { entries, button } = await mount({ locale: 'de', listed: [SET_ASIDE, NOT_SAVED], platform: 'win32' });

  const [first, second] = entries();
  assert.equal(first.querySelector('.app-notice-heading').textContent, 'Deine Modelleinstellungen wurden zurückgesetzt.');
  assert.equal(button(first, 'reveal').textContent, 'Im Explorer anzeigen');
  assert.ok(second.classList.contains('app-notice--error'));
  assert.equal(
    second.querySelector('.app-notice-heading').textContent,
    'Änderungen an deinen Ansichtseinstellungen werden nicht gespeichert.',
  );
  assert.equal(button(second, 'dismiss').getAttribute('aria-label'), 'Hinweis schließen');
});

test('a pushed notice is added, a repeated one replaces its entry, a withdrawn one goes', async () => {
  const { entries, push } = await mount({ listed: [SET_ASIDE] });

  push.posted(NOT_SAVED);
  push.posted({ ...SET_ASIDE, location: '/profile/llm-config.json.unreadable-2' });
  assert.deepEqual(
    entries().map((e) => e.dataset.noticeId),
    ['store:llm-config.json', 'store:ui-preferences.json'],
  );
  assert.equal(entries()[0].querySelector('.app-notice-path').textContent, '/profile/llm-config.json.unreadable-2');

  push.withdrawn({ id: 'store:ui-preferences.json' });
  assert.deepEqual(entries().map((e) => e.dataset.noticeId), ['store:llm-config.json']);
});

test('closing a notice tells main and hides the strip with the last one', async () => {
  const { root, entries, button, calls } = await mount({ listed: [SET_ASIDE] });

  button(entries()[0], 'dismiss').click();
  await flush();

  assert.equal(entries().length, 0);
  assert.equal(root.hidden, true);
  assert.deepEqual(calls, ['dismiss:store:llm-config.json']);
});

test('a notice without a file to show offers no reveal button', async () => {
  const { entries, button, push } = await mount();
  push.posted({ ...NOT_SAVED, location: null });

  assert.equal(button(entries()[0], 'reveal'), null);
  assert.equal(entries()[0].querySelector('.app-notice-path'), null);
});

test('a notice that does not fit the contract is not shown', async () => {
  const { root, push } = await mount();
  push.posted({ id: 'x', kind: 'shout', store: 'models', file: 'f' });
  assert.equal(root.hidden, true);
});

test('switching the language words the notices again', async () => {
  const { entries, setLocale } = await mount({ listed: [SET_ASIDE] });

  setLocale('de');
  await flush();

  assert.equal(entries()[0].querySelector('.app-notice-heading').textContent, 'Deine Modelleinstellungen wurden zurückgesetzt.');
});

// The errors nobody caught (#978): one notice, counted, with the diagnostics.

test('an error in the background: heading, count, and copy, log and help buttons', async () => {
  const { entries, button, calls } = await mount({ listed: [BACKGROUND] });

  const [entry] = entries();
  assert.ok(entry.classList.contains('app-notice--error'));
  assert.equal(entry.querySelector('.app-notice-heading').textContent, 'Something went wrong in the background.');
  assert.match(entry.querySelector('.app-notice-text').textContent, /^Snotra ran into an error it did not expect\./);
  assert.equal(entry.querySelector('.app-notice-path'), null, 'the log path stays behind its button');
  assert.deepEqual(
    Array.from(entry.querySelectorAll('.app-notice-actions button')).map((b) => b.dataset.action),
    ['copy-diagnostics', 'reveal', 'help'],
  );
  assert.equal(button(entry, 'reveal').textContent, 'Show log file');

  button(entry, 'reveal').click();
  button(entry, 'help').click();
  await flush();
  assert.deepEqual(calls, ['reveal:background-error', 'manual:troubleshooting/logs-and-reports#the-log-file']);
});

test('copying the diagnostics says so on the button, and says it when it failed', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const ok = await mount({ listed: [BACKGROUND] });
  const copy = ok.button(ok.entries()[0], 'copy-diagnostics');
  assert.equal(copy.textContent, 'Copy diagnostics');
  copy.click();
  await flush();
  assert.equal(copy.textContent, 'Copied');
  assert.deepEqual(ok.calls, ['copy']);
  t.mock.timers.tick(2500);
  assert.equal(copy.textContent, 'Copy diagnostics');

  const failed = await mount({ listed: [BACKGROUND], copyResult: new Error('no clipboard') });
  const button = failed.button(failed.entries()[0], 'copy-diagnostics');
  button.click();
  await flush();
  assert.equal(button.textContent, 'Could not copy');
});

test('a higher count rewords the same entry and keeps the focus on its button', async () => {
  const { dom, entries, button, push } = await mount({ listed: [BACKGROUND] });
  button(entries()[0], 'copy-diagnostics').focus();

  push.posted({ ...BACKGROUND, count: 3 });

  assert.equal(entries().length, 1);
  assert.match(entries()[0].querySelector('.app-notice-text').textContent, /^Snotra ran into 3 errors it did not expect\./);
  assert.equal(dom.document.activeElement, button(entries()[0], 'copy-diagnostics'));
});

test('in German', async () => {
  const { entries, button } = await mount({ locale: 'de', listed: [{ ...BACKGROUND, count: 2 }] });
  const [entry] = entries();
  assert.equal(entry.querySelector('.app-notice-heading').textContent, 'Im Hintergrund ist etwas schiefgegangen.');
  assert.match(entry.querySelector('.app-notice-text').textContent, /^Snotra ist auf 2 unerwartete Fehler gestoßen\./);
  assert.equal(button(entry, 'copy-diagnostics').textContent, 'Diagnose kopieren');
  assert.equal(button(entry, 'reveal').textContent, 'Logdatei zeigen');
});
