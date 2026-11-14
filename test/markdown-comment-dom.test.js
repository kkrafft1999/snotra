// Commenting in the Markdown preview (#1388), mounted by the real host
// against the real markup: a selection brings the button, the button the
// form, the form writes the file — and what is already there opens in a
// popover.
//
// `marked` is real, DOMPurify a pass-through stand-in (see
// test/markdown-document.test.js). Where the button lands on screen is the
// smoke test's question; happy-dom has no layout.

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
  await new Promise((resolve) => setTimeout(resolve, 30));
  for (let i = 0; i < 4; i += 1) await flush();
}

async function mountPane(t, { content, author = 'Ada Lovelace', account = '', write } = {}) {
  const dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };

  const { createFileViewHost } = await importRenderer('file-views', 'host.js');
  const disk = { '/ws/notes.md': content };
  const calls = { writes: [] };
  const api = {
    setUIPrefs: async () => ({}),
    getUIPrefs: async () => ({ commentAuthor: author }),
    commentAccountName: async () => account,
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

/** Selects `text` inside the first element matching `selector`, the way a mouse would. */
function select(selector, text) {
  const el = $(selector);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = node.data.indexOf(text);
    if (at === -1) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    return range;
  }
  throw new Error(`"${text}" not found in ${selector}`);
}

function action() {
  return $('.md-comment-action');
}

async function writeComment(text) {
  action().click();
  await settle();
  const form = $('.md-comment-popover--compose');
  assert.ok(form, 'the form is open');
  const input = form.querySelector('textarea');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  form.querySelector('button[type="submit"]').click();
  await settle();
}

test('a selection brings the button; the form writes the comment into the file', async (t) => {
  const content = '# Notes\n\nThe **quick** brown fox jumps.\n';
  const { calls } = await mountPane(t, { content });
  assert.equal(action(), null, 'no button without a selection');

  select('.md-doc p', 'brown fox');
  await settle();
  assert.equal(action().hidden, false);
  assert.equal(action().textContent, 'Comment');

  action().click();
  await settle();
  const form = $('.md-comment-popover--compose');
  assert.equal(form.getAttribute('role'), 'dialog');
  assert.equal(form.querySelector('.md-comment-popover__quote').textContent, 'brown fox');
  assert.equal(form.querySelector('.md-comment-popover__author').textContent, 'As Ada Lovelace');
  assert.equal(document.activeElement, form.querySelector('textarea'));
  assert.equal(form.querySelector('button[type="submit"]').disabled, true, 'nothing to save yet');

  const input = form.querySelector('textarea');
  input.value = 'Which fox?';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  form.querySelector('button[type="submit"]').click();
  await settle();

  assert.equal(calls.writes.length, 1);
  const [{ text, options }] = calls.writes;
  assert.match(text, /^# Notes\n\nThe \*\*quick\*\* \{==brown fox==\}\{>>Ada Lovelace, \d{4}-\d{2}-\d{2}: Which fox\?<<\} jumps\.\n$/);
  assert.match(options.baseHash, /^[0-9a-f]{64}$/, 'written against the text it was rendered from');
  assert.equal($('.md-comment-popover'), null, 'the form closes');
  assert.equal($('.md-doc mark.md-comment').textContent, 'brown fox', 'the preview shows the new comment');
  assert.equal($('.md-notice').textContent, 'Comment added.');
});

test('a comment that is there opens from its marker and closes with Escape', async (t) => {
  const content = 'Some {==text==}{>>Grace, 2026-11-14: Is this right?<<} here.\n';
  await mountPane(t, { content });
  const marker = $('.md-doc .md-comment-marker');
  assert.equal(marker.tagName, 'BUTTON');
  assert.equal(marker.getAttribute('aria-label'), 'Comment by Grace');
  assert.equal(marker.textContent, '', 'the marker adds no text to the document');

  marker.click();
  const popover = $('.md-comment-popover--view');
  assert.equal(popover.querySelector('.md-comment-popover__name').textContent, 'Grace');
  assert.equal(popover.querySelector('time').getAttribute('datetime'), '2026-11-14');
  assert.equal(popover.querySelector('.md-comment-popover__text').textContent, 'Is this right?');
  assert.equal(marker.getAttribute('aria-expanded'), 'true');

  popover.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal($('.md-comment-popover'), null);
  assert.equal(marker.getAttribute('aria-expanded'), 'false');
  assert.equal(document.activeElement, marker, 'the focus goes back to the marker');
});

test('a click on the highlight opens the comment as well', async (t) => {
  await mountPane(t, { content: 'Some {==text==}{>>a note<<} here.\n' });
  $('.md-doc mark.md-comment').click();
  assert.equal($('.md-comment-popover--view .md-comment-popover__text').textContent, 'a note');
  assert.equal($('.md-comment-popover__name').textContent, 'No name');
});

test('code, and a selection over two paragraphs, are refused with a reason', async (t) => {
  const { calls } = await mountPane(t, { content: 'Use `npm test` here.\n\nFirst.\n\nSecond.\n' });
  select('.md-doc code', 'npm test');
  await settle();
  action().click();
  await settle();
  assert.equal($('.md-comment-popover'), null);
  assert.equal($('.md-notice').textContent, 'Code cannot be commented.');

  const paragraphs = $$('.md-doc p');
  const range = document.createRange();
  range.setStart(paragraphs[1].firstChild, 0);
  range.setEnd(paragraphs[2].firstChild, 3);
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await settle();
  action().click();
  await settle();
  assert.equal($('.md-notice').textContent, 'Select text within one paragraph, heading, list item or table cell.');
  assert.equal(calls.writes.length, 0);
});

test('without a name the comment carries only the date, and the form says how to set one', async (t) => {
  const { calls } = await mountPane(t, { content: 'Plain words.\n', author: '' });
  select('.md-doc p', 'words');
  await settle();
  action().click();
  await settle();
  assert.equal($('.md-comment-popover__author').textContent, 'Without a name — set one in Settings › General.');
  const input = $('.md-comment-popover textarea');
  input.value = 'x';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  $('.md-comment-popover button[type="submit"]').click();
  await settle();
  assert.match(calls.writes[0].text, /^Plain \{==words==\}\{>>\d{4}-\d{2}-\d{2}: x<<\}\.\n$/);
});

test('a file changed on disk is not overwritten; it is read again', async (t) => {
  const { calls, disk } = await mountPane(t, {
    content: 'Old text here.\n',
    write: () => ({ conflict: 'changed' }),
  });
  select('.md-doc p', 'text');
  await settle();
  disk['/ws/notes.md'] = 'New text from elsewhere.\n';
  await writeComment('note');
  assert.equal(calls.writes.length, 1);
  assert.equal($('.md-notice').textContent, 'The file changed on disk and has been reloaded. Select the passage again.');
  assert.equal($('.md-doc p').textContent, 'New text from elsewhere.');
  assert.ok($('.md-comment-popover--compose'), 'what was typed stays in the form');
});

test('while Snotra is working the button is off and nothing is written', async (t) => {
  const { host, calls } = await mountPane(t, { content: 'Some words.\n' });
  host.setEditingBlocked(true);
  select('.md-doc p', 'words');
  await settle();
  assert.equal(action().disabled, true);
  assert.equal(action().title, 'Comments wait until Snotra has finished.');
  host.setEditingBlocked(false);
  await settle();
  assert.equal(action().disabled, false);
  assert.equal(calls.writes.length, 0);
});

test('the button is not offered while the source is on show', async (t) => {
  await mountPane(t, { content: 'Some words.\n' });
  select('.md-doc p', 'words');
  await settle();
  assert.equal(action().hidden, false);
  const [, source] = $$('#preview-tools input[type="radio"]');
  source.checked = true;
  source.dispatchEvent(new Event('change', { bubbles: true }));
  await settle();
  assert.equal(action(), null);
});

test('a selection over a commented passage and beyond is traced through the marker', async (t) => {
  const { calls } = await mountPane(t, { content: 'Alpha {==beta==}{>>x<<} gamma delta.\n' });
  const p = $('.md-doc p');
  const range = document.createRange();
  range.setStart(p.lastChild, 1);
  range.setEnd(p.lastChild, 6);
  document.getSelection().removeAllRanges();
  document.getSelection().addRange(range);
  document.dispatchEvent(new Event('selectionchange'));
  await settle();
  await writeComment('y');
  assert.match(calls.writes[0].text, /^Alpha \{==beta==\}\{>>x<<\} \{==gamma==\}\{>>Ada Lovelace, [\d-]+: y<<\} delta\.\n$/);
});

test('with the setting empty, the account name signs the comment, as in a PDF (#1391)', async (t) => {
  const { calls } = await mountPane(t, { content: 'Plain words.\n', author: '', account: 'Kim Example' });
  select('.md-doc p', 'words');
  await settle();
  action().click();
  await settle();
  assert.equal($('.md-comment-popover__author').textContent, 'As Kim Example');
  const input = $('.md-comment-popover textarea');
  input.value = 'x';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  $('.md-comment-popover button[type="submit"]').click();
  await settle();
  assert.match(calls.writes[0].text, /^Plain \{==words==\}\{>>Kim Example, \d{4}-\d{2}-\d{2}: x<<\}\.\n$/);
});

// ── Replies (#1399) ─────────────────────────────────────────────────────────

const THREAD = 'Some {==text==}{>>Grace, 2026-11-14: Is this right?<<}{>>Alan, 2026-11-15: I think so.<<} here.\n';

function typeReply(text) {
  const input = $('.md-comment-popover__form textarea');
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

test('a comment shows its replies, and Reply opens the form in its footer (#1399)', async (t) => {
  await mountPane(t, { content: THREAD });
  assert.equal($$('.md-doc .md-comment-marker').length, 1, 'one thread, one marker');
  $('.md-doc .md-comment-marker').click();
  const popover = $('.md-comment-popover--view');
  const list = popover.querySelector('.md-comment-popover__replies');
  assert.equal(list.getAttribute('aria-label'), '1 reply');
  assert.deepEqual([...list.querySelectorAll('.md-comment-popover__name')].map((el) => el.textContent), ['Alan']);
  assert.deepEqual([...list.querySelectorAll('.md-comment-popover__text')].map((el) => el.textContent), ['I think so.']);
  assert.equal(popover.querySelector('.md-comment-popover__text').textContent, 'Is this right?', 'the comment first');

  const trigger = popover.querySelector('.md-comment-popover__foot .md-comment-popover__reply');
  assert.equal(trigger.textContent, 'Reply');
  trigger.click();
  await settle();
  const form = $('.md-comment-popover__foot .md-comment-popover__form');
  assert.ok(form);
  assert.equal(form.getAttribute('role'), 'group');
  assert.equal(document.getElementById(form.getAttribute('aria-labelledby')).textContent, 'Your reply');
  const input = form.querySelector('textarea');
  assert.equal(document.activeElement, input);
  assert.equal(input.placeholder, 'Write a reply…');
  assert.equal(form.querySelector('.md-comment-popover__author').textContent, 'As Ada Lovelace');
  assert.equal($('.md-comment-popover__send').disabled, true);
  typeReply('Confirmed.');
  assert.equal($('.md-comment-popover__send').disabled, false);

  // Escape steps back to the comment; it stays open.
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.ok($('.md-comment-popover--view'));
  assert.equal($('.md-comment-popover__form'), null);
  assert.equal(document.activeElement, $('.md-comment-popover__reply'));
});

test('a reply is written right after the thread, and the comment opens again with it (#1399)', async (t) => {
  const { calls } = await mountPane(t, { content: THREAD });
  $('.md-doc .md-comment-marker').click();
  $('.md-comment-popover__reply').click();
  const input = typeReply('  Confirmed by sales.  ');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
  await settle();
  assert.equal(calls.writes.length, 1);
  assert.match(calls.writes[0].text,
    /^Some \{==text==\}\{>>Grace, 2026-11-14: Is this right\?<<\}\{>>Alan, 2026-11-15: I think so\.<<\}\{>>Ada Lovelace, \d{4}-\d{2}-\d{2}: Confirmed by sales\.<<\} here\.\n$/);
  const popover = $('.md-comment-popover--view');
  assert.ok(popover, 'the comment is open again');
  assert.deepEqual([...popover.querySelectorAll('.md-comment-popover__replies .md-comment-popover__text')].map((el) => el.textContent),
    ['I think so.', 'Confirmed by sales.']);
  assert.equal(document.activeElement, popover);
  assert.equal($('.md-notice').textContent, 'Reply added.');
});

test('of two alike threads in a paragraph, the reply goes after the one it answers (#1399)', async (t) => {
  const twin = '{==same==}{>>Grace, 2026-11-14: Why?<<}';
  const { calls } = await mountPane(t, { content: `First ${twin} and then ${twin} again.\n` });
  const markers = $$('.md-doc .md-comment-marker');
  assert.equal(markers.length, 2);
  markers[1].click();
  $('.md-comment-popover__reply').click();
  typeReply('Second one.');
  $('.md-comment-popover__send').click();
  await settle();
  const written = calls.writes[0].text;
  assert.ok(written.startsWith(`First ${twin} and then ${twin}{>>Ada Lovelace, `), written);
  assert.ok(written.endsWith(': Second one.<<} again.\n'));
});

test('a file changed on disk gives the reply back with the reason (#1399)', async (t) => {
  const { calls, disk } = await mountPane(t, { content: THREAD, write: () => ({ conflict: 'changed' }) });
  $('.md-doc .md-comment-marker').click();
  $('.md-comment-popover__reply').click();
  typeReply('Keep me');
  disk['/ws/notes.md'] = `# Added elsewhere\n\n${THREAD}`;
  $('.md-comment-popover__send').click();
  await settle();
  assert.equal(calls.writes.length, 1);
  assert.equal($('.md-doc h1').textContent, 'Added elsewhere', 'the file was read again');
  const input = $('.md-comment-popover--view .md-comment-popover__form textarea');
  assert.ok(input, 'the comment is open again, with the form');
  assert.equal(input.value, 'Keep me');
  assert.equal(document.activeElement, input);
  const message = $('.md-comment-popover__message');
  assert.equal(message.hidden, false);
  assert.equal(message.getAttribute('role'), 'alert');
  assert.match(message.textContent, /changed on disk.*still here/);
});

test('while Snotra is working, Reply says so and writes nothing (#1399)', async (t) => {
  const { host, calls } = await mountPane(t, { content: THREAD });
  host.setEditingBlocked(true);
  $('.md-doc .md-comment-marker').click();
  $('.md-comment-popover__reply').click();
  await settle();
  assert.equal($('.md-comment-popover__form'), null);
  assert.equal($('.md-notice').textContent, 'Comments wait until Snotra has finished.');
  assert.equal(calls.writes.length, 0);
});
