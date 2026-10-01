// Settings › Memory in both interface languages (#375).
//
// The panel formatted dates as DD.MM.YYYY and character counts with a German
// number format whatever the language, and its badge for entries Snotra kept
// on its own was a German literal. Checked here: all three follow the app
// language, and a switch redraws them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, focusFixup } = require('./helpers/dom.js');

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

async function mount({ memory = MEMORY, api: overrides = {} } = {}) {
  const dom = setupRendererDom();
  const { initMemoryPanel } = await importRenderer('components', 'MemoryPanel.js');
  const { setLocale } = await importRenderer('i18n.js');
  setLocale('en', { force: true });
  const api = {
    getMemory: async () => structuredClone(memory),
    setUIPrefs: async (prefs) => prefs,
    forgetMemoryEntry: async () => ({ ok: false }),
    ...overrides,
  };
  const panel = initMemoryPanel({ api });
  await panel.refresh();

  const doc = dom.document;
  const host = doc.getElementById('settings-memory-scopes');
  const dates = () => [...host.querySelectorAll('.memory-item__date')].map((el) => el.textContent);
  const badges = () => [...host.querySelectorAll('.memory-item__origin')].map((el) => el.textContent);
  const meta = () => host.querySelector('.memory-meta').textContent;
  const card = (scope) => [...host.querySelectorAll('.memory-card')].find((el) => el.dataset.scope === scope);
  const texts = (scope) => [...card(scope).querySelectorAll('.memory-item__text')].map((el) => el.firstChild.textContent);
  /** The trash button of the entry with this text. */
  const trash = (text) => [...host.querySelectorAll('.memory-item')]
    .find((item) => item.querySelector('.memory-item__text').firstChild.textContent === text)
    ?.querySelector('.memory-item__forget') || null;

  return {
    dom, doc, host, panel, dates, badges, meta, card, texts, trash, setLocale,
    cleanup: () => { setLocale('en', { force: true }); dom.cleanup(); },
  };
}

/** A user memory with these entries, one per line from line 2 on. */
function userMemory(texts) {
  return {
    available: true,
    selfEnabled: true,
    scopes: [{
      scope: 'user',
      path: '/home/me/.snotra/memory.md',
      shortPath: '~/.snotra/memory.md',
      enabled: true,
      chars: 100,
      maxChars: 8000,
      truncated: false,
      entries: texts.map((text, index) => ({ line: index + 2, date: '2026-09-21', text, origin: 'requested' })),
    }],
  };
}

/** Main's side of "Forget": removes the named entry and answers with the new state. */
function fakeMain(texts) {
  let current = userMemory(texts);
  const calls = [];
  return {
    calls,
    getMemory: async () => structuredClone(current),
    async forgetMemoryEntry(scope, line, text) {
      calls.push({ scope, line, text });
      current = userMemory(current.scopes[0].entries.map((entry) => entry.text).filter((other) => other !== text));
      return { ok: true, removed: true, state: structuredClone(current) };
    },
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

// CR-B14-07 (#620): the pressed trash button is gone after the redraw.
test('after "Forget" the keyboard moves to the next entry, else the previous one, else the empty hint', async (t) => {
  const main = fakeMain(['First.', 'Second.', 'Third.']);
  const ui = await mount({ memory: userMemory(['First.', 'Second.', 'Third.']), api: main });
  t.after(ui.cleanup);
  const forget = async (text) => {
    ui.trash(text).focus();
    ui.trash(text).click();
    await flush();
    focusFixup(ui.doc);
  };

  await forget('Second.');
  assert.deepEqual(ui.texts('user'), ['First.', 'Third.']);
  assert.equal(ui.doc.activeElement === ui.trash('Third.'), true, 'the entry that took its place');
  await forget('Third.');
  assert.equal(ui.doc.activeElement === ui.trash('First.'), true, 'no next one: the one before');
  await forget('First.');
  const empty = ui.card('user').querySelector('.memory-empty');
  assert.equal(ui.doc.activeElement === empty, true, 'no entry left: the empty hint');
  assert.equal(empty.getAttribute('tabindex'), '-1', 'focusable from code, not a tab stop');
});

test('a "Forget" in flight keeps the focus and takes no second press; a failed one keeps it too', async (t) => {
  let release;
  const calls = [];
  const ui = await mount({
    memory: userMemory(['First.', 'Second.']),
    api: {
      forgetMemoryEntry: (...args) => {
        calls.push(args);
        return new Promise((resolve) => { release = resolve; });
      },
    },
  });
  t.after(ui.cleanup);
  const button = ui.trash('Second.');
  button.focus();
  button.click();
  // Busy: marked, not disabled, so Chromium does not drop the focus.
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  focusFixup(ui.doc);
  assert.equal(ui.doc.activeElement === button, true);
  button.click();
  assert.equal(calls.length, 1, 'the second press was ignored');

  release({ ok: false, error: { key: 'settings.error.memory.forgetFailed' } });
  await flush();
  focusFixup(ui.doc);
  assert.equal(button.hasAttribute('aria-disabled'), false);
  assert.equal(ui.doc.activeElement === button, true, 'nothing was redrawn, the focus stays');
});

// CR-B14-08 (#621): a failed "Forget" used to show nothing at all.
test('a failed "Forget" says why in its card\'s status line, and keeps the focus', async (t) => {
  let answer = { ok: false, error: { key: 'settings.error.memory.invalidRequest' } };
  const ui = await mount({
    memory: userMemory(['First.', 'Second.']),
    api: { forgetMemoryEntry: async () => answer },
  });
  t.after(ui.cleanup);
  const status = ui.card('user').querySelector('.memory-card__status');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.textContent, '', 'present and empty before anything happened');
  assert.equal(ui.trash('Second.').getAttribute('aria-describedby'), status.id);

  ui.trash('Second.').focus();
  ui.trash('Second.').click();
  await flush();
  focusFixup(ui.doc);
  assert.equal(status.textContent, 'This entry cannot be forgotten: the request is incomplete.', 'main\'s own reason');
  assert.equal(status.classList.contains('is-error'), true);
  assert.equal(ui.doc.activeElement === ui.trash('Second.'), true);

  // No reason from main: the catalogue's own sentence.
  answer = { ok: false };
  ui.trash('Second.').click();
  await flush();
  assert.equal(status.textContent, 'The entry could not be removed.');

  // A language change speaks the new language.
  answer = { ok: false, error: { key: 'settings.error.memory.forgetFailed' } };
  ui.trash('First.').click();
  await flush();
  ui.setLocale('de');
  await flush();
  assert.equal(ui.card('user').querySelector('.memory-card__status').textContent, 'Der Eintrag ließ sich nicht entfernen.');
});

test('an entry main did not find says so after the redraw, and keeps the focus where it still stands', async (t) => {
  const changed = userMemory(['First.', 'Second.', 'Added in the editor.']);
  const ui = await mount({
    memory: userMemory(['First.', 'Second.']),
    api: { forgetMemoryEntry: async () => ({ ok: true, removed: false, state: structuredClone(changed) }) },
  });
  t.after(ui.cleanup);
  ui.trash('Second.').focus();
  ui.trash('Second.').click();
  await flush();
  focusFixup(ui.doc);
  assert.deepEqual(ui.texts('user'), ['First.', 'Second.', 'Added in the editor.'], 'drawn from main\'s answer');
  const status = ui.card('user').querySelector('.memory-card__status');
  assert.equal(status.textContent, 'Not removed: the file has changed in the meantime. The list now shows what it holds.');
  assert.equal(status.classList.contains('is-error'), false, 'nothing failed, the file moved on');
  assert.equal(ui.doc.activeElement === ui.trash('Second.'), true);
  assert.equal(ui.doc.activeElement.getAttribute('aria-describedby'), status.id, 'read out with the focus');

  // Reopening the dialog starts without it.
  await ui.panel.refresh();
  assert.equal(ui.card('user').querySelector('.memory-card__status').textContent, '');
});

test('the memory card\'s small texts use the stronger grey, 4.5:1 or more in light and dark', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'renderer');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8').replace(/\r\n/g, '\n');
  const tokens = fs.readFileSync(path.join(dir, 'styles', 'tokens.css'), 'utf8').replace(/\r\n/g, '\n');
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.notEqual(at, -1, `${selector} is missing`);
    return css.slice(at, css.indexOf('}', at));
  };
  for (const selector of ['.memory-card__path', '.memory-item__origin', '.memory-meta', '.memory-card__status']) {
    assert.match(rule(selector), /color:\s*var\(--text-muted-strong\)/, selector);
  }
  assert.match(css, /--text-muted-strong:\s*var\(--ds-grey-strong\)/);

  const value = (block, name) => new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`).exec(block)[1];
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const dark = tokens.slice(tokens.indexOf("[data-theme='dark']"));
  for (const block of [tokens, dark]) {
    assert.ok(ratio(value(block, '--ds-grey-strong'), value(block, '--ds-surface')) >= 4.5);
  }
});

// ── CR-B14-09 (#622) ────────────────────────────────────────────────────

/** Both memories: the project one of an open folder and the global one. */
function bothMemories() {
  const user = userMemory(['Prefers tabs.']).scopes[0];
  return {
    available: true,
    selfEnabled: true,
    scopes: [
      {
        scope: 'workspace',
        folderName: 'snotra',
        path: '/work/snotra/.agents/memory.md',
        shortPath: '.agents/memory.md',
        enabled: true,
        chars: 40,
        maxChars: 8000,
        truncated: false,
        entries: [
          { line: 2, date: '2026-09-21', text: 'Uses node 24.', origin: 'requested' },
          { line: 3, date: '2026-09-22', text: 'Tests with node --test.', origin: 'self' },
        ],
      },
      user,
    ],
  };
}

// Item 14: the payload and the redraw had no test.
test('"Forget" names the entry by scope, line and text, and the list is what main answers', async (t) => {
  const calls = [];
  // Main re-read the file: besides the forgotten entry, another one is gone.
  const answer = bothMemories();
  answer.scopes[0].entries = [];
  const ui = await mount({
    memory: bothMemories(),
    api: {
      forgetMemoryEntry: async (...args) => {
        calls.push(args);
        return { ok: true, removed: true, state: structuredClone(answer) };
      },
    },
  });
  t.after(ui.cleanup);
  ui.trash('Tests with node --test.').click();
  await flush();
  assert.deepEqual(calls, [['workspace', 3, 'Tests with node --test.']]);
  assert.equal(ui.card('workspace').querySelector('.memory-list'), null, 'drawn from main\'s state, not patched locally');
  assert.match(ui.card('workspace').querySelector('.memory-empty').textContent, /^Nothing remembered yet/);
  assert.deepEqual(ui.texts('user'), ['Prefers tabs.']);
});

test('each "Send along" switch saves its own preference at once and snaps back when it is not stored', async (t) => {
  const saved = [];
  let accept = true;
  const ui = await mount({
    memory: bothMemories(),
    api: {
      setUIPrefs: async (prefs) => {
        saved.push(prefs);
        return accept ? prefs : {};
      },
    },
  });
  t.after(ui.cleanup);
  const project = ui.doc.getElementById('memory-send-workspace');
  const global = ui.doc.getElementById('memory-send-user');
  const flip = (box, on) => {
    box.checked = on;
    box.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
  };

  flip(project, false);
  await flush();
  assert.deepEqual(saved, [{ memoryWorkspaceEnabled: false }]);
  assert.equal(project.checked, false);
  assert.equal(project.parentElement.querySelector('.settings-instant-status').textContent, 'Saved');

  accept = false;
  flip(global, false);
  await flush();
  assert.deepEqual(saved.at(-1), { memoryUserEnabled: false });
  assert.equal(global.checked, true, 'not stored: back to what is');
  assert.equal(global.parentElement.querySelector('.settings-instant-status').textContent, 'Not saved');
});

// Item 4: the card names one folder, the preference is one for all of them.
test('the project memory switch says that it applies to every folder', async (t) => {
  const ui = await mount({ memory: bothMemories() });
  t.after(ui.cleanup);
  const project = ui.doc.getElementById('memory-send-workspace');
  const hint = ui.doc.getElementById(project.getAttribute('aria-describedby'));
  assert.equal(hint.textContent, 'This switch applies to every folder, not just this one.');
  assert.equal(ui.card('workspace').contains(hint), true);
  assert.equal(ui.doc.getElementById('memory-send-user').hasAttribute('aria-describedby'), false,
    'the global card already says "applies in every folder" in its title');

  ui.setLocale('de');
  await flush();
  const again = ui.doc.getElementById(ui.doc.getElementById('memory-send-workspace').getAttribute('aria-describedby'));
  assert.equal(again.textContent, 'Dieser Schalter gilt für alle Ordner, nicht nur für diesen.');
});

// Item 3: the self switch's status sits in the markup and kept its language.
test('a "Not saved" next to the self switch is gone after a language change and on the next open', async (t) => {
  const ui = await mount({ api: { setUIPrefs: async () => ({}) } });
  t.after(ui.cleanup);
  const self = ui.doc.getElementById('input-memory-self');
  const status = ui.doc.getElementById('status-memory-self');
  const fail = async () => {
    self.checked = !self.checked;
    self.dispatchEvent(new ui.dom.window.Event('change', { bubbles: true }));
    await flush();
    assert.equal(status.textContent, 'Not saved');
  };
  await fail();
  ui.setLocale('de');
  await flush();
  assert.equal(status.textContent, '');
  ui.setLocale('en');
  await fail();
  await ui.panel.refresh();
  assert.equal(status.textContent, '');
});
