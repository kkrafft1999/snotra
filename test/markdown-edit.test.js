// Editing in the Markdown preview (#1422): the parts that need no mounted
// view — writing an edited block back as Markdown, and splicing the changed
// blocks into the file so that everything else stays byte for byte.
//
// `marked` is the real one from the vendor folder, DOMPurify a stand-in that
// passes everything through (see test/markdown-document.test.js). Every
// serializer case checks the round trip: the Markdown it writes renders to
// the same HTML as the block it came from.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom } = require('./helpers/dom.js');

let dom = null;
let doc = null;
let serialize = null;
let splice = null;

test.before(async () => {
  dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  globalThis.DOMPurify = { addHook() {}, sanitize: (html) => html };
  doc = await importRenderer('file-views', 'markdown-document.js');
  serialize = await importRenderer('file-views', 'markdown-serialize.js');
  splice = await importRenderer('file-views', 'markdown-splice.js');
});

test.after(() => {
  delete globalThis.DOMPurify;
  dom?.cleanup();
});

const html = (fragment) => [...fragment.children].map((el) => {
  const copy = el.cloneNode(true);
  copy.removeAttribute('data-md-range');
  return copy.outerHTML;
}).join('');

/** Renders `markdown`, writes its first block back, and checks the round trip. */
function roundTrip(markdown, options = {}) {
  const rendered = doc.renderMarkdownFragment(markdown);
  const block = rendered.firstElementChild;
  assert.ok(serialize.isEditableBlock(block), `editable: ${markdown}`);
  const written = serialize.serializeBlock(block, options);
  assert.equal(html(doc.renderMarkdownFragment(written)), html(rendered), `renders the same: ${written}`);
  return written;
}

// ── Writing a block back ────────────────────────────────────────────────────

test('a paragraph with the toolbar formats comes back as it was written', () => {
  const source = 'Plain **bold** and *italic*, ~~gone~~ and `code`.';
  assert.equal(roundTrip(source), source);
});

test('headings keep their level', () => {
  assert.equal(roundTrip('## Open points'), '## Open points');
  assert.equal(roundTrip('###### Deep'), '###### Deep');
  // A trailing hash would read as a closing sequence.
  assert.equal(roundTrip('# C \\#'), '# C \\#');
});

test('text that looks like Markdown is escaped, and only where it would act', () => {
  assert.equal(roundTrip('2 \\* 3 is not \\*emphasis\\*'), '2 \\* 3 is not \\*emphasis\\*');
  assert.equal(roundTrip('snake_case_name stays'), 'snake_case_name stays');
  assert.equal(roundTrip('a \\[link\\] that is none'), 'a \\[link\\] that is none');
  assert.equal(roundTrip('\\# not a heading'), '\\# not a heading');
  assert.equal(roundTrip('1\\. not a list'), '1\\. not a list');
  assert.equal(roundTrip('\\<div> as text'), '\\<div> as text');
  assert.equal(roundTrip('\\{== not a comment'), '\\{== not a comment');
});

test('links keep their address and title; a bare address stays an autolink', () => {
  assert.equal(roundTrip('See [the notes](./notes.md "Notes") here.'), 'See [the notes](./notes.md "Notes") here.');
  assert.equal(roundTrip('Visit <https://snotra-ai.dev> today.'), 'Visit <https://snotra-ai.dev> today.');
  assert.equal(roundTrip('Mail <ada@example.com>.'), 'Mail <ada@example.com>.');
});

test('a link the view rewrote is written with the address from the file', () => {
  const rendered = doc.renderMarkdownFragment('Open [the plan](plan%20b.md#goals).');
  const anchor = rendered.querySelector('a');
  // What markdown-view.js does in prepareLinks(): the click is its own.
  anchor.setAttribute('data-md-href', anchor.getAttribute('data-workspace-href') ?? anchor.getAttribute('href'));
  anchor.setAttribute('href', '#');
  assert.equal(serialize.serializeBlock(rendered.firstElementChild), 'Open [the plan](plan%20b.md#goals).');
});

test('whitespace at the edge of a format goes outside its delimiters', () => {
  const p = document.createElement('p');
  p.innerHTML = 'Say <b>hello </b>world and <i> twice</i>.';
  assert.equal(serialize.serializeBlock(p), 'Say **hello** world and *twice*.');
  const nested = document.createElement('p');
  nested.innerHTML = '<strong>a <b>b</b></strong><b>c</b>';
  assert.equal(serialize.serializeBlock(nested), '**a bc**');
});

test('what the editing engine leaves behind does not reach the file', () => {
  const p = document.createElement('p');
  p.innerHTML = '<span>typed</span>&nbsp;text<br>';
  assert.equal(serialize.serializeBlock(p), 'typed text');
  const empty = document.createElement('p');
  empty.innerHTML = '<br>';
  assert.equal(serialize.serializeBlock(empty), '');
  const broken = document.createElement('p');
  broken.innerHTML = 'one<br>two';
  assert.equal(serialize.serializeBlock(broken), 'one\\\ntwo');
});

test('lists keep their marker, their numbering and their tasks', () => {
  assert.equal(roundTrip('- one\n- **two**'), '- one\n- **two**');
  assert.equal(roundTrip('* one\n* two', { bullet: '*' }), '* one\n* two');
  assert.equal(roundTrip('3. three\n4. four'), '3. three\n4. four');
  assert.equal(roundTrip('- [ ] open\n- [x] done'), '- [ ] open\n- [x] done');
  assert.equal(roundTrip('- outer\n  - inner\n  - more\n- last'), '- outer\n  - inner\n  - more\n- last');
  assert.equal(roundTrip('1. first\n   - nested\n2. second'), '1. first\n   - nested\n2. second');
});

test('a loose list stays loose', () => {
  assert.equal(roundTrip('- one\n\n- two'), '- one\n\n- two');
});

test('a quote keeps its paragraphs', () => {
  assert.equal(roundTrip('> First line\n>\n> Second **part**'), '> First line\n>\n> Second **part**');
});

test('comments and their replies survive an edit of their paragraph (#1388)', () => {
  const source = 'Signed before it is {==published==}{>>Grace, 2026-11-12: Also the website?<<}{>>Ada, 2026-11-13: Yes.<<} today.';
  const rendered = doc.renderMarkdownFragment(source);
  const mark = rendered.querySelector('mark');
  // What the comment UI puts after a commented passage.
  const marker = document.createElement('button');
  marker.className = 'md-comment-marker';
  marker.textContent = 'Comment';
  mark.after('⁠', marker);
  mark.firstChild.data = 'published to GitHub';
  assert.equal(serialize.serializeBlock(rendered.firstElementChild),
    'Signed before it is {==published to GitHub==}{>>Grace, 2026-11-12: Also the website?<<}{>>Ada, 2026-11-13: Yes.<<} today.');
  assert.equal(roundTrip('A point{>>Ada, 2026-11-14: here<<} comment.'), 'A point{>>Ada, 2026-11-14: here<<} comment.');
});

test('a block that could not be written back is not editable', () => {
  const blocks = doc.renderMarkdownFragment([
    '![logo](logo.png)', '', '| a |\n|---|\n| ![b](b.png) |', '', '```\ncode\n```', '', '<details>x</details>', '',
    'Text with <kbd>Ctrl</kbd>', '', '---', '', 'Text with ![inline](i.png) image',
  ].join('\n'));
  for (const el of blocks.children) assert.equal(serialize.isEditableBlock(el), false, el.outerHTML);
});

// ── Tables (#1430) ──────────────────────────────────────────────────────────

test('a table is editable, and a changed one comes back as a padded pipe table', () => {
  const written = roundTrip('| Name | Status |\n|---|---|\n| Ada | open |\n| Grace | **done** |');
  assert.equal(written, [
    '| Name  | Status   |',
    '| ----- | -------- |',
    '| Ada   | open     |',
    '| Grace | **done** |',
  ].join('\n'));
});

test('a table keeps the alignment of its columns', () => {
  const source = '| L | C | R | N |\n|:--|:-:|--:|---|\n| a | b | c | d |';
  const align = serialize.tableAlignOf(source);
  assert.deepEqual(align, ['left', 'center', 'right', '']);
  const lines = roundTrip(source, { tableAlign: align }).split('\n');
  assert.equal(lines[1], '| :-- | :-: | --: | --- |');
  assert.equal(lines[2], '| a   |  b  |   c | d   |');
  // Without the source, the cells say how they are aligned.
  assert.equal(roundTrip(source).split('\n')[1], '| :-- | :-: | --: | --- |');
});

test('a bar in a cell is escaped, also in code; a line break is a <br>', () => {
  const written = roundTrip('| a | b |\n|---|---|\n| x \\| y | `p\\|q` |\n| one<br>two | [link](https://e.com) |');
  assert.match(written, /\| x \\\| y +\| `p\\\|q` +\|/);
  assert.match(written, /\| one<br>two \| \[link\]\(https:\/\/e\.com\) \|/);
});

test('an emptied cell stays a cell, and a short row is filled up', () => {
  const rendered = doc.renderMarkdownFragment('| a | b |\n|---|---|\n| 1 | 2 |');
  const frame = rendered.firstElementChild;
  frame.querySelector('tbody td').textContent = '';
  frame.querySelector('tbody tr').lastElementChild.remove();
  assert.equal(serialize.serializeBlock(frame), '| a   | b   |\n| --- | --- |\n|     |     |');
});

test('the delimiter row is read only from a table', () => {
  assert.equal(serialize.tableAlignOf('Just a paragraph\nwith two lines'), null);
  assert.equal(serialize.tableAlignOf('| a |'), null);
  assert.deepEqual(serialize.tableAlignOf('a | b\n--- | :---:'), ['', 'center']);
});

// ── Splicing into the file ──────────────────────────────────────────────────

const BODY = '# Title\n\nFirst paragraph\nwrapped.\n\n- a\n- b\n\n[ref]: https://example.com\n\nLast.\n';
const blocksOf = (body) => {
  const rendered = doc.renderMarkdownFragment(body);
  return [...rendered.children].map((el) => {
    const [start, end] = el.getAttribute('data-md-range').split(':').map(Number);
    return { start, end };
  });
};

test('nothing changed: the file comes back byte for byte', () => {
  const blocks = blocksOf(BODY);
  const result = splice.spliceBlocks(BODY, blocks, blocks.map((_, orig) => ({ orig, text: null })));
  assert.equal(result.text, BODY);
});

test('a changed block replaces only its own source', () => {
  const blocks = blocksOf(BODY);
  const items = blocks.map((_, orig) => ({ orig, text: orig === 1 ? 'First paragraph, edited.' : null }));
  const result = splice.spliceBlocks(BODY, blocks, items);
  assert.equal(result.text, BODY.replace('First paragraph\nwrapped.', 'First paragraph, edited.'));
  const { start, end } = result.ranges[1];
  assert.equal(result.text.slice(start, end), 'First paragraph, edited.');
});

test('a new block goes in after the one before it, with a blank line', () => {
  const blocks = blocksOf(BODY);
  const items = blocks.map((_, orig) => ({ orig, text: null }));
  items.splice(1, 0, { orig: null, text: 'Inserted.' });
  assert.equal(splice.spliceBlocks(BODY, blocks, items).text, BODY.replace('# Title\n\n', '# Title\n\nInserted.\n\n'));
  // At the very start, too.
  items.splice(1, 1);
  items.unshift({ orig: null, text: 'Top.' });
  assert.equal(splice.spliceBlocks(BODY, blocks, items).text, `Top.\n\n${BODY}`);
});

test('a deleted block takes one blank gap along; a link definition stays', () => {
  const blocks = blocksOf(BODY);
  const without = (gone) => blocks.map((_, orig) => ({ orig, text: null })).filter((item) => !gone.includes(item.orig));
  assert.equal(splice.spliceBlocks(BODY, blocks, without([1])).text, '# Title\n\n- a\n- b\n\n[ref]: https://example.com\n\nLast.\n');
  assert.equal(splice.spliceBlocks(BODY, blocks, without([3])).text, '# Title\n\nFirst paragraph\nwrapped.\n\n- a\n- b\n\n[ref]: https://example.com\n');
  assert.equal(splice.spliceBlocks(BODY, blocks, without([2, 3])).text, '# Title\n\nFirst paragraph\nwrapped.\n\n[ref]: https://example.com\n');
});

test('an emptied block writes nothing', () => {
  const blocks = blocksOf(BODY);
  const items = blocks.map((_, orig) => ({ orig, text: orig === 1 ? '  ' : null }));
  assert.equal(splice.spliceBlocks(BODY, blocks, items).text, '# Title\n\n- a\n- b\n\n[ref]: https://example.com\n\nLast.\n');
});

test('two blocks that only a line break kept apart get a blank line once one is changed', () => {
  const body = '# Title\nText under it.\n';
  const blocks = blocksOf(body);
  assert.equal(blocks.length, 2);
  const untouched = splice.spliceBlocks(body, blocks, [{ orig: 0, text: null }, { orig: 1, text: null }]);
  assert.equal(untouched.text, body);
  const changed = splice.spliceBlocks(body, blocks, [{ orig: 0, text: 'New text' }, { orig: 1, text: null }]);
  assert.equal(changed.text, 'New text\n\nText under it.\n');
});

test('a Windows file keeps its line endings', () => {
  const body = '# Title\r\n\r\nOne\r\n';
  const blocks = blocksOf(body);
  const result = splice.spliceBlocks(body, blocks, [{ orig: 0, text: null }, { orig: 1, text: 'One\nand two' }, { orig: null, text: 'Three' }]);
  assert.equal(result.text, '# Title\r\n\r\nOne\r\nand two\r\n\r\nThree\r\n');
});

test('an HTML comment between blocks does not stop the blocks from being traced', () => {
  const body = 'Before\n\n<!-- note -->\n\nAfter\n';
  const rendered = doc.renderMarkdownFragment(body);
  const ranges = [...rendered.children].map((el) => el.getAttribute('data-md-range'));
  // The last block's range carries the file's final newline, as marked reads it.
  assert.deepEqual(ranges, ['0:6', '23:29']);
  const blocks = blocksOf(body);
  const result = splice.spliceBlocks(body, blocks, [{ orig: 0, text: null }, { orig: 1, text: 'After, edited' }]);
  assert.equal(result.text, 'Before\n\n<!-- note -->\n\nAfter, edited\n');
});

test('blocks out of order are refused rather than written', () => {
  const blocks = blocksOf(BODY);
  assert.throws(() => splice.spliceBlocks(BODY, blocks, [{ orig: 1, text: null }, { orig: 0, text: null }]), /out of order/);
});
