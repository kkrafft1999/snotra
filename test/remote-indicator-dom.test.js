// The paired phone in the title bar (#1196) on the real markup: hidden until
// main says a phone is connected, the word and the shape together, "keeping
// awake" only while it holds, a click to Settings › Remote access, and a
// change said once to a screen reader.
//
// Nodes are compared as booleans: a failing assert on a happy-dom node
// formats the whole DOM graph and hangs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

async function mount(t, { state = { connected: false, keepingAwake: false }, locale = 'en' } = {}) {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { setLocale } = await importRenderer('i18n.js');
  setLocale(locale, { force: true });
  const { initRemoteIndicator } = await importRenderer('components', 'RemoteIndicator.js');
  let push = () => {};
  const opened = [];
  const api = {
    remote: {
      getPresence: async () => state,
      onPresence: (cb) => { push = cb; return () => {}; },
    },
  };
  initRemoteIndicator({ api, openSettings: () => opened.push('remote') });
  await flush();
  const doc = dom.document;
  return {
    dom,
    setLocale,
    button: doc.getElementById('titlebar-remote'),
    awake: doc.getElementById('titlebar-remote-awake'),
    status: doc.getElementById('titlebar-remote-status'),
    opened,
    push: async (next) => { push(next); await flush(); },
  };
}

test('the indicator sits in the title bar, before the wordmark, and is a button with a phone and a word', async (t) => {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const button = dom.document.getElementById('titlebar-remote');
  assert.equal(button?.tagName, 'BUTTON');
  assert.equal(button.parentElement.id, 'titlebar');
  assert.equal(button.nextElementSibling?.id, 'titlebar-remote-status');
  assert.ok(button.querySelector('svg[aria-hidden="true"]'), 'the phone, decorative');
  assert.equal(dom.document.getElementById('titlebar-remote-status').getAttribute('role'), 'status');
  assert.equal(button.hidden, true, 'hidden until main says otherwise');
});

test('hidden without a phone; a phone already there at start is shown but not announced', async (t) => {
  const quiet = await mount(t);
  assert.equal(quiet.button.hidden, true);

  const there = await mount(t, { state: { connected: true, keepingAwake: false } });
  assert.equal(there.button.hidden, false);
  assert.equal(there.awake.hidden, true);
  assert.match(there.button.textContent, /iPhone connected/);
  assert.equal(there.button.hasAttribute('aria-label'), false, 'named by its visible text (WCAG 2.5.3)');
  assert.equal(there.button.title, 'Open Settings › Remote access');
  assert.equal(there.status.textContent, '', 'no news at start');
});

test('connect and disconnect are said once; keeping awake shows the second part and a longer description', async (t) => {
  const ctx = await mount(t);
  await ctx.push({ connected: true, keepingAwake: false });
  assert.equal(ctx.button.hidden, false);
  assert.equal(ctx.status.textContent, 'Your iPhone is connected.');

  ctx.status.textContent = '';
  await ctx.push({ connected: true, keepingAwake: true });
  assert.equal(ctx.awake.hidden, false);
  assert.match(ctx.button.textContent.replace(/\s+/g, ' '), /iPhone connected · keeping awake/);
  assert.match(ctx.button.title, /stays awake while a run works/);
  assert.equal(ctx.status.textContent, '', 'staying awake is no reconnect');

  await ctx.push({ connected: false, keepingAwake: true });
  assert.equal(ctx.button.hidden, true);
  assert.equal(ctx.awake.hidden, true, 'never awake without a phone');
  assert.equal(ctx.status.textContent, 'Your iPhone is no longer connected.');
});

test('a click opens Settings › Remote access', async (t) => {
  const ctx = await mount(t, { state: { connected: true, keepingAwake: false } });
  ctx.button.click();
  assert.deepEqual(ctx.opened, ['remote']);
});

test('German, with du', async (t) => {
  const ctx = await mount(t, { state: { connected: true, keepingAwake: true }, locale: 'de' });
  assert.match(ctx.button.textContent.replace(/\s+/g, ' '), /iPhone verbunden · hält wach/);
  assert.equal(ctx.button.title, 'Dieser Computer bleibt wach, solange ein Lauf arbeitet. Einstellungen › Fernzugriff öffnen');
  await ctx.push({ connected: false, keepingAwake: false });
  assert.equal(ctx.status.textContent, 'Dein iPhone ist nicht mehr verbunden.');
});
