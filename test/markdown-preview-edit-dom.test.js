// Editing in the Markdown preview (#1422), on the mounted view: the Edit
// toggle, what is editable, what reaches the disk, and the states around it.
//
// happy-dom has no editing commands (`execCommand`); what the reader types
// is a change of the DOM here, which is what the browser does as well. The
// commands themselves and the toolbar are checked in the running app by
// `e2e/markdown-preview-edit.test.mjs`. DOMPurify is a pass-through stand-in,
// see test/markdown-document.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const file = (content) => ({ content, size: content.length, modified: 1 });
const item = (p) => ({ path: p, name: p.split('/').pop(), size: 1, modified: 1 });
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

async function settle() {
  for (let i = 0; i < 4; i += 1) await flush();
}

/**
 * Until `check()` holds — by the clock, not by ticks: a save hashes the text
 * on the thread pool first, and a slow runner takes its time (#1422).
 */
async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await settle();
}

const NOTE = [
  '---',
  'name: plan',
  '---',
  '# Plan',
  '',
  'First paragraph with {==a comment==}{>>Ada, 2026-11-14: why?<<}.',
  '',
  '<!-- kept -->',
  '',
  '* one',
  '* two',
  '',
  '| a | b |',
  '|---|---|',
  '| 1 | 2 |',
  '',
  'Last line.',
  '',
].join('\n');

async function mountPane(t, { content = NOTE, write } = {}) {
  const dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };

  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const disk = { '/ws/notes.md': content };
  const calls = { writes: [] };
  const api = {
    setUIPrefs: async () => ({}),
    getUIPrefs: async () => ({}),
    readFile: async (p) => (p in disk ? file(disk[p]) : { error: `ENOENT: ${p}` }),
    readWorkspaceImage: async () => ({ ok: false, reason: 'not_found' }),
    writeFile: async (p, text, options) => {
      calls.writes.push({ path: p, text, options });
      const answer = write ? write(text, options) : { ok: true, size: text.length, modified: 2 };
      if (answer?.ok) disk[p] = text;
      return answer;
    },
  };
  const host = createFileViewHost({ api, getWorkspaceRoot: () => '/ws', openFile: async () => ({ ok: true }) });
  t.after(() => {
    host.dispose();
    delete globalThis.DOMPurify;
    dom.cleanup();
  });
  await host.open(item('/ws/notes.md'));
  await settle();
  return { host, calls, disk };
}

const toggle = () => $('#preview-tools .file-edit-toggle');

async function startEditing() {
  toggle().click();
  await settle();
}

/** What a reader's typing does to a text node: the text changes, an `input` follows. */
function type(selector, from, to) {
  const el = $$(selector).find((candidate) => candidate.textContent.includes(from));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.data.includes(from)) continue;
    node.data = node.data.replace(from, to);
    $('.md-doc').dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  throw new Error(`"${from}" not found in ${selector}`);
}

test('the preview has an Edit toggle next to the switch, before the zoom', async (t) => {
  await mountPane(t);
  const tools = $$('#preview-tools > *').map((el) => el.className.split(' ')[0]);
  const at = tools.indexOf('file-edit-toggle');
  assert.ok(at > 0, `toggle in ${tools.join(', ')}`);
  assert.ok(tools.indexOf('pdf-tools') > at, 'the zoom after it');
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  assert.equal(toggle().hasAttribute('aria-disabled'), false);
});

test('Edit makes the document editable, with the toolbar below the header and islands for the rest', async (t) => {
  await mountPane(t);
  await startEditing();
  assert.equal(toggle().getAttribute('aria-pressed'), 'true');
  assert.equal($('.md-doc').getAttribute('contenteditable'), 'true');
  const bar = $('.md-format-bar');
  assert.ok(bar, 'toolbar');
  assert.equal(bar.getAttribute('role'), 'toolbar');
  assert.equal(bar.nextElementSibling.classList.contains('file-edit-notice'), true);
  assert.equal($('.file-edit-notice').nextElementSibling.classList.contains('md-view'), true);
  // The table and the front matter are islands; text blocks are not.
  assert.equal($('.md-table-frame').getAttribute('contenteditable'), 'false');
  assert.equal($('.md-front-matter').getAttribute('contenteditable'), 'false');
  assert.equal($('.md-doc h1').hasAttribute('contenteditable'), false);
  assert.ok($('.md-table-frame').title, 'the island says where it is edited');
  // A comment's marker leaves while the text is edited; its passage stays marked.
  assert.equal($$('.md-comment-marker').length, 0);
  assert.ok($('.md-doc mark.md-comment'));
  // No comment button while editing.
  assert.equal($('.md-comment-action')?.hidden ?? true, true);
});

test('a changed word writes only its block; the rest of the file stays byte for byte', async (t) => {
  const { host, calls, disk } = await mountPane(t);
  await startEditing();
  type('.md-doc p', 'Last line.', 'Last line, edited.');
  type('.md-doc mark', 'a comment', 'a long comment');
  assert.equal(await host.settleUnsaved(), true);
  assert.equal(calls.writes.length, 1);
  assert.equal(disk['/ws/notes.md'], NOTE
    .replace('Last line.', 'Last line, edited.')
    .replace('{==a comment==}', '{==a long comment==}'));
  assert.equal($('.file-edit-status').textContent, 'Saved');
});

test('a second change after a save is measured against what was saved', async (t) => {
  const { host, disk } = await mountPane(t);
  await startEditing();
  type('.md-doc h1', 'Plan', 'Plan B');
  assert.equal(await host.settleUnsaved(), true);
  type('.md-doc li', 'two', 'two and three');
  assert.equal(await host.settleUnsaved(), true);
  assert.equal(disk['/ws/notes.md'], NOTE.replace('# Plan', '# Plan B').replace('* two', '* two and three'));
});

test('leaving saves, and the preview is a preview again', async (t) => {
  const { disk } = await mountPane(t);
  await startEditing();
  type('.md-doc p', 'Last line.', 'Final line.');
  toggle().click();
  await until(() => !$('.md-format-bar'), 'editing to end');
  assert.equal(disk['/ws/notes.md'], NOTE.replace('Last line.', 'Final line.'));
  assert.equal($('.md-doc').hasAttribute('contenteditable'), false);
  assert.equal($('.md-format-bar'), null);
  assert.equal(toggle().getAttribute('aria-pressed'), 'false');
  // The markers are back.
  assert.equal($$('.md-comment-marker').length, 1);
});

test('entering and leaving without a change writes nothing', async (t) => {
  const { calls } = await mountPane(t);
  await startEditing();
  toggle().click();
  await settle();
  assert.equal(calls.writes.length, 0);
});

test('a document whose blocks cannot all be traced is not editable', async (t) => {
  // One HTML block that renders as two elements.
  await mountPane(t, { content: '# Title\n\n<div>a</div><div>b</div>\n' });
  assert.equal(toggle().getAttribute('aria-disabled'), 'true');
  assert.equal(toggle().title, 'This document can only be edited in the source.');
  toggle().click();
  await settle();
  assert.equal($('.md-format-bar'), null);
});

test('while the agent works, Edit is paused, and a run that starts ends editing after saving', async (t) => {
  const { host, disk } = await mountPane(t);
  await startEditing();
  type('.md-doc p', 'Last line.', 'Saved before the run.');
  host.setEditingBlocked(true);
  await until(() => !$('.md-format-bar'), 'editing to end');
  assert.equal(disk['/ws/notes.md'], NOTE.replace('Last line.', 'Saved before the run.'));
  assert.equal($('.md-format-bar'), null);
  assert.equal(toggle().getAttribute('aria-disabled'), 'true');
  assert.equal(toggle().title, 'Editing is paused while the agent is working.');
  host.setEditingBlocked(false);
  await settle();
  assert.equal(toggle().hasAttribute('aria-disabled'), false);
});

test('a change on disk is taken while nothing is unsaved, and is a conflict otherwise', async (t) => {
  const { host, disk } = await mountPane(t);
  await startEditing();
  disk['/ws/notes.md'] = NOTE.replace('Last line.', 'Changed elsewhere.');
  await host.refresh('/ws/notes.md');
  await settle();
  assert.ok($$('.md-doc p').some((p) => p.textContent === 'Changed elsewhere.'), 'shown');
  assert.equal($('.md-doc').getAttribute('contenteditable'), 'true', 'still editing');

  type('.md-doc h1', 'Plan', 'Mine');
  disk['/ws/notes.md'] = NOTE.replace('# Plan', '# Theirs');
  await host.refresh('/ws/notes.md');
  await settle();
  const notice = $('.file-edit-notice');
  assert.equal(notice.hidden, false);
  assert.equal(notice.dataset.kind, 'changed');
  assert.equal($('.md-doc h1').textContent, 'Mine', 'nothing under the caret');
});

test('the toolbar is a labelled toolbar with one tab stop', async (t) => {
  await mountPane(t);
  await startEditing();
  const controls = $$('.md-format-bar select, .md-format-bar__button');
  assert.equal(controls.length, 10);
  assert.equal(controls.filter((el) => el.tabIndex === 0).length, 1);
  assert.equal($('.md-format-bar').getAttribute('aria-label'), 'Formatting');
  for (const button of $$('.md-format-bar__button')) {
    assert.ok(button.getAttribute('aria-label'), 'labelled');
    assert.ok(button.hasAttribute('aria-pressed'));
  }
  assert.deepEqual([...$('.md-format-bar__block').options].filter((o) => !o.hidden).map((o) => o.textContent),
    ['Paragraph', 'Heading 1', 'Heading 2', 'Heading 3']);
  assert.match($('.md-format-bar__button[data-format="code"]').title, /^Code \((⌘E|Ctrl\+E)\)$/);
});
