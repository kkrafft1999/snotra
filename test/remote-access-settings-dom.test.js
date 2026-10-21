// Settings › Remote access (#1110) on the real markup: every state main
// pushes, the questions the panel asks itself, and the lock — pairing stays
// closed in this build until the phone's side is out (decided 2026-10-21).
//
// Nodes are compared as booleans: a failing assert on a happy-dom node
// formats the whole DOM graph and hangs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const CODE = {
  display: '0111-EP9D-ZH4Q-PYT4-HWWF',
  qr: 'snotra-pair:v1/relay.snotra-ai.dev/0111EP9DZH4QPYT4HWWF',
  modules: Array.from({ length: 21 }, (_, y) => Array.from({ length: 21 }, (_, x) => ((x + y) % 2 ? '1' : '0')).join('')),
};
const WORDS = ['coffeecake', 'groundhog', 'maestro', 'kangaroo', 'ozone', 'oncoming'];
const base = { encryptionAvailable: true, phone: null, code: null, words: null, replacing: false, reason: null, locked: false };

async function mount(t, { state = base, released = [], result = { ok: true }, now = () => 1_000_000 } = {}) {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const { initRemoteAccessSettings } = await importRenderer('components', 'RemoteAccessSettings.js');
  const calls = [];
  const opened = [];
  let push = () => {};
  const api = {
    remote: {
      getState: async () => state,
      startPairing: async () => { calls.push('start'); return result; },
      cancelPairing: async () => { calls.push('cancel'); return { ok: true }; },
      unpair: async () => { calls.push('unpair'); return { ok: true, relayDeleted: true }; },
      onState: (cb) => { push = cb; return () => {}; },
      getReleases: async () => ({ available: true, paired: true, released }),
    },
  };
  const root = dom.document.getElementById('settings-remote-body');
  const panel = initRemoteAccessSettings({ root, api, openPanel: (key) => opened.push(key), now });
  t.after(() => panel.dispose());
  await panel.open();
  const q = (selector) => root.querySelector(selector);
  const text = () => root.textContent.replace(/\s+/g, ' ');
  const action = (name) => q(`[data-action="${name}"]`);
  const buttonNamed = (label) => [...root.querySelectorAll('button')].find((b) => b.textContent === label) || null;
  return { dom, root, q, text, action, buttonNamed, calls, opened, push: (s) => { push({ ...base, ...s }); }, panel };
}

test('the panel is in the settings, between Memory and General', async (t) => {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const tabs = [...dom.document.querySelectorAll('.settings-nav-item[role="tab"]')].map((tab) => tab.dataset.settingsPanel);
  assert.deepEqual(tabs.slice(-3), ['memory', 'remote', 'general']);
  assert.ok(dom.document.getElementById('panel-settings-remote')?.hidden);
});

test('locked (#1110): the empty state with Pair a phone disabled, a Coming soon chip and why', async (t) => {
  const { action, q, text, calls } = await mount(t, { state: { ...base, state: 'empty', locked: true } });
  const pair = action('pair');
  assert.equal(pair.disabled, true);
  assert.equal(pair.getAttribute('aria-describedby'), 'ra-pair-why', 'a screen reader says why');
  assert.match(q('#ra-pair-why').textContent, /Pairing opens once the Snotra app for iPhone is out/);
  assert.equal(q('.ra-soon')?.textContent, 'Coming soon');
  assert.match(text(), /No phone paired/);
  pair.click();
  await flush();
  assert.deepEqual(calls, [], 'a disabled button starts nothing');
});

test('open: Pair a phone starts a pairing; without encryption it says why and stays disabled', async (t) => {
  const open = await mount(t, { state: { ...base, state: 'empty' } });
  assert.equal(open.action('pair').disabled, false);
  assert.equal(open.q('.ra-soon'), null);
  open.action('pair').click();
  await flush();
  assert.deepEqual(open.calls, ['start']);

  const noKeys = await mount(t, { state: { ...base, state: 'empty', encryptionAvailable: false } });
  assert.equal(noKeys.action('pair').disabled, true);
  assert.match(noKeys.q('#ra-pair-why').textContent, /cannot keep the phone’s keys encrypted/);
});

test('a code: the QR code from main\'s modules, the key, a live countdown and Cancel', async (t) => {
  let clock = 1_000_000;
  const { q, text, buttonNamed, calls, panel } = await mount(t, {
    state: { ...base, state: 'code', code: { ...CODE, expiresAt: 1_000_000 + 272_000 } },
    now: () => clock,
  });
  const svg = q('.ra-qr svg');
  assert.ok(svg, 'a QR code');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), 'Pairing code to scan with the Snotra app');
  assert.match(q('.ra-qr__ink').getAttribute('d'), /^M\d+ \d+h1v1h-1z/);
  assert.equal(q('.ra-key').textContent, CODE.display);
  assert.equal(q('.ra-key').getAttribute('lang'), 'en');
  assert.match(text(), /Valid for 4:32/);
  assert.match(text(), /Tap Pair with desktop\./);
  assert.equal(q('.ra-steps [aria-current="step"]')?.textContent, '1Scan');
  assert.equal(q('.ra-wait').getAttribute('role'), 'status');
  assert.equal(q('.ra-key + button'), null, 'no copy button for the key (R3)');
  clock += 2_000;
  panel.render();
  assert.match(text(), /Valid for 4:30/);
  buttonNamed('Cancel').click();
  await flush();
  assert.deepEqual(calls, ['cancel']);
});

test('confirm: the six words, untranslated, and the hint that the system asks', async (t) => {
  const { root, q, text } = await mount(t, { state: { ...base, state: 'confirm', words: WORDS } });
  assert.deepEqual([...root.querySelectorAll('.ra-words .w')].map((w) => w.textContent), WORDS);
  assert.equal(q('.ra-words').getAttribute('lang'), 'en');
  assert.equal(q('.ra-steps [aria-current="step"]')?.textContent, '2Confirm');
  assert.match(text(), /Only a click there lets a phone in/);
  assert.equal([...root.querySelectorAll('button')].some((b) => /^Allow$/.test(b.textContent)), false, 'Allow is the system dialog’s');
});

test('paired: the phone with its status, the released workspaces and a link to Tools › Security', async (t) => {
  const { q, text, action, opened, push } = await mount(t, {
    state: { ...base, state: 'paired', phone: { pairedAt: Date.parse('2026-10-18T12:00:00Z'), connected: true } },
    released: ['/a', '/b'],
  });
  assert.ok(q('.ra-status--on'), 'a filled dot');
  assert.match(text(), /Your iPhone ?Connected/);
  assert.match(text(), /2 open to it/);
  q('.ra-link').click();
  assert.deepEqual(opened, ['sandbox']);
  assert.equal(action('replace').disabled, false);
  assert.equal(action('remove').disabled, false);

  push({ state: 'paired', phone: { pairedAt: 1, connected: false } });
  assert.ok(q('.ra-status--off'), 'a hollow ring');
  assert.match(text(), /Not connected/);
});

test('paired and locked: Replace is closed like pairing, Remove still works', async (t) => {
  const { action, q, calls, buttonNamed } = await mount(t, {
    state: { ...base, state: 'paired', locked: true, phone: { pairedAt: 1, connected: false } },
  });
  assert.equal(action('replace').disabled, true);
  assert.equal(action('remove').disabled, false);
  action('remove').click();
  assert.equal(q('[role="alertdialog"]')?.getAttribute('aria-describedby'), 'ra-ask-text');
  assert.equal(action('remove').disabled, true, 'device actions are locked while the question stands');
  buttonNamed('Cancel').click();
  assert.equal(q('[role="alertdialog"]'), null);
  action('remove').click();
  q('[role="alertdialog"] .btn-destructive').click();
  await flush();
  assert.deepEqual(calls, ['unpair']);
});

test('Replace phone asks first, and only its Pair new phone starts a pairing', async (t) => {
  const { action, q, calls } = await mount(t, { state: { ...base, state: 'paired', phone: { pairedAt: 1, connected: true } } });
  action('replace').click();
  assert.match(q('[role="alertdialog"]').textContent, /Pair a new phone\?/);
  assert.deepEqual(calls, []);
  q('[role="alertdialog"] .btn-primary').click();
  await flush();
  assert.deepEqual(calls, ['start']);
});

test('expired, stopped, unreachable and denied each say what happened and what to do', async (t) => {
  const { text, q, buttonNamed, push } = await mount(t, { state: { ...base, state: 'expired' } });
  assert.match(text(), /Code expired/);
  assert.ok(buttonNamed('New code'));

  push({ state: 'stopped', reason: 'mac' });
  assert.equal(q('.ra-error')?.getAttribute('role'), 'alert', 'the one red state');
  assert.match(text(), /keys that don’t belong to this code/);
  push({ state: 'stopped', reason: 'not-saved' });
  assert.match(text(), /could not be kept on this computer/);

  push({ state: 'unreachable', reason: 'network' });
  assert.equal(q('.ra-error'), null, 'an outage is not red');
  assert.match(text(), /Can’t reach the relay/);
  push({ state: 'unreachable', reason: 'not-configured' });
  assert.match(text(), /has no relay to pair through/);
  push({ state: 'unreachable', reason: 'rate-limited' });
  assert.match(text(), /Too many attempts/);
  assert.ok(buttonNamed('Try again'));

  push({ state: 'denied' });
  assert.match(text(), /You denied the phone/);
  assert.match(text(), /No phone paired/);
});

test('a retry on a locked build is disabled too', async (t) => {
  const { buttonNamed } = await mount(t, { state: { ...base, state: 'unreachable', reason: 'network', locked: true } });
  assert.equal(buttonNamed('Try again').disabled, true);
});

test('a refused action says so in the panel', async (t) => {
  const { action, q } = await mount(t, { state: { ...base, state: 'empty' }, result: { ok: false, reason: 'busy' } });
  action('pair').click();
  await flush();
  await flush();
  assert.equal(q('.ra-notice')?.getAttribute('role'), 'alert');
  assert.match(q('.ra-notice').textContent, /That did not work/);
});

test('in German the panel speaks German, the words stay as they are', async (t) => {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('de', { force: true });
  const { initRemoteAccessSettings } = await importRenderer('components', 'RemoteAccessSettings.js');
  const root = dom.document.getElementById('settings-remote-body');
  let state = { ...base, state: 'empty', locked: true };
  const panel = initRemoteAccessSettings({
    root,
    api: { remote: { getState: async () => state, onState: () => () => {}, getReleases: async () => ({ released: [] }) } },
  });
  t.after(() => panel.dispose());
  await panel.open();
  assert.match(root.textContent, /Kein Handy gekoppelt/);
  assert.match(root.textContent, /Bald verfügbar/);
  assert.match(root.textContent, /Koppeln geht, sobald die Snotra-App fürs iPhone da ist/);
  state = { ...base, state: 'confirm', words: WORDS };
  await panel.open();
  assert.deepEqual([...root.querySelectorAll('.ra-words .w')].map((w) => w.textContent), WORDS);
  setLocale('en', { force: true });
});

// ---------------------------------------------------------------- developer mode (#1213)

async function mountVisibility(t, { developer = false, phone = null } = {}) {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const { initRemoteSectionVisibility } = await importRenderer('components', 'RemoteAccessSettings.js');
  const hooks = {};
  let toggles = 0;
  let active = false;
  const left = [];
  const api = {
    developerMode: {
      get: async () => ({ on: developer }),
      toggle: async () => { toggles += 1; return { on: !developer }; },
      onChange: (cb) => { hooks.change = cb; },
      onShortcut: (cb) => { hooks.shortcut = cb; },
    },
    remote: {
      getState: async () => ({ ...base, state: phone ? 'paired' : 'empty', phone }),
      onState: (cb) => { hooks.state = cb; },
    },
  };
  const tab = dom.document.getElementById('tab-settings-remote');
  const section = initRemoteSectionVisibility({ api, tab, leave: () => left.push('models'), isActive: () => active });
  await section.refresh();
  const chip = tab.querySelector('.settings-nav-chip');
  return { tab, chip, hooks, left, toggles: () => toggles, setActive: (value) => { active = value; } };
}

test('without developer mode and without a phone, Remote access is not in the settings', async (t) => {
  const { tab } = await mountVisibility(t);
  assert.equal(tab.hidden, true);
});

test('developer mode shows Remote access with a Developer chip; switching it off hides it and leaves the section', async (t) => {
  const { tab, chip, hooks, left, setActive } = await mountVisibility(t, { developer: true });
  assert.equal(tab.hidden, false);
  assert.equal(chip.hidden, false);
  assert.equal(chip.textContent, 'Developer');
  setActive(true);
  hooks.change({ on: false });
  assert.equal(tab.hidden, true);
  assert.deepEqual(left, ['models'], 'an open section that disappears gives way to Models');
});

test('a paired phone keeps Remote access in the settings without developer mode, so it can be removed', async (t) => {
  const { tab, chip, hooks } = await mountVisibility(t, { phone: { pairedAt: 1, connected: false } });
  assert.equal(tab.hidden, false);
  assert.equal(chip.hidden, true, 'no Developer chip: it is shown for the phone');
  hooks.state({ ...base, state: 'empty', phone: null });
  assert.equal(tab.hidden, true, 'removed: gone with it');
});

test('the shortcut, caught by main, switches developer mode through main', async (t) => {
  const { hooks, toggles } = await mountVisibility(t);
  hooks.shortcut();
  await flush();
  assert.equal(toggles(), 1);
});

test('Remote access is hidden in the markup until main says otherwise', async (t) => {
  const dom = setupRendererDom();
  t.after(dom.cleanup);
  const tabs = [...dom.document.querySelectorAll('.settings-nav-item[role="tab"]')];
  const remote = dom.document.getElementById('tab-settings-remote');
  assert.equal(remote.hidden, true, 'hidden in the markup until main says otherwise');
  assert.ok(tabs.includes(remote));
});
