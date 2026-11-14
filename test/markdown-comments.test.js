// Comments on a Markdown file (#1388): CriticMarkup rendered, a selection in
// the preview traced back to the source, and the comment written and read.
//
// `marked` is the real one from the vendor folder; the selection side is fed
// the text a reader would have selected, the way `markdown-view.js` reads it
// off the DOM.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { RENDERER_DIR, importRenderer, setupRendererDom } = require('./helpers/dom.js');

let dom = null;
let comments = null;

test.before(async () => {
  dom = setupRendererDom();
  require(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'));
  globalThis.marked = globalThis.marked || dom.window.marked;
  comments = await importRenderer('file-views', 'markdown-comments.js');
});

test.after(() => {
  dom?.cleanup();
});

function render(markdown) {
  const template = document.createElement('template');
  template.innerHTML = comments.previewMarked().parse(markdown, { gfm: true, breaks: false });
  return template.content;
}

/** Comments `selected` in `body` (one block) the way the view would, and returns the new source. */
function comment(body, selected, { occurrence = 0, text = 'Note' } = {}) {
  const located = comments.locateSelection({ blockSource: body, selected, occurrence, body });
  if (located.error) return located;
  return comments.insertComment(body, located, { author: 'Ada', date: '2026-11-14', text });
}

// ── Rendering ───────────────────────────────────────────────────────────────

test('a highlight with a comment renders as a mark that carries it', () => {
  const root = render('Some {==important **words**==}{>>Ada, 2026-11-14: check this<<} here.');
  const mark = root.querySelector('mark.md-comment');
  assert.ok(mark);
  assert.equal(mark.textContent, 'important words');
  assert.ok(mark.querySelector('strong'), 'the text inside keeps its formatting');
  assert.equal(mark.getAttribute('data-md-comment'), 'Ada, 2026-11-14: check this');
  assert.equal(root.textContent.includes('check this'), false, 'the comment is not part of the text');
});

test('a bare comment is a point, a bare highlight carries none', () => {
  const point = render('Text{>>a remark<<} more.').querySelector('mark');
  assert.ok(point.classList.contains('md-comment--point'));
  assert.equal(point.getAttribute('data-md-comment'), 'a remark');
  const plain = render('Just {==marked==}.').querySelector('mark');
  assert.equal(plain.hasAttribute('data-md-comment'), false);
});

test('CriticMarkup inside code stays code', () => {
  const root = render('Write `{==x==}` like this.\n\n```\n{>>not a comment<<}\n```');
  assert.equal(root.querySelector('mark'), null);
  assert.match(root.querySelector('code').textContent, /\{==x==\}/);
});

test('a comment with markup in it cannot break out of its attribute', () => {
  const mark = render('{==x==}{>>"><img src=a onerror=alert(1)><<}').querySelector('mark');
  assert.equal(mark.querySelector('img'), null);
  assert.equal(mark.getAttribute('data-md-comment'), '"><img src=a onerror=alert(1)>');
});

test('the chat renders with the shared parser, which knows no comments', () => {
  assert.notEqual(comments.previewMarked(), globalThis.marked);
  assert.equal(globalThis.marked.parse('{==x==}').includes('<mark'), false);
});

// ── Blocks ──────────────────────────────────────────────────────────────────

test('the blocks of a body point at their source, link definitions left out', () => {
  const body = '# Title\n\nFirst paragraph.\n\n[ref]: https://example.org\n\n- one\n- two\n';
  const blocks = comments.sourceBlocks(body);
  assert.deepEqual(blocks.map(({ start, end }) => body.slice(start, end).trim()), [
    '# Title', 'First paragraph.', '- one\n- two',
  ]);
});

test('block offsets count the \\r of a file written on Windows', () => {
  const body = 'One\r\n\r\nTwo\r\nlines\r\n';
  const [, second] = comments.sourceBlocks(body);
  assert.equal(body.slice(second.start, second.end).trim(), 'Two\r\nlines');
});

// ── Finding the selection ───────────────────────────────────────────────────

test('plain text is wrapped where it stands', () => {
  assert.equal(
    comment('A quick brown fox.', 'quick brown'),
    'A {==quick brown==}{>>Ada, 2026-11-14: Note<<} fox.',
  );
});

test('a selection across a soft line break finds the text over it', () => {
  assert.equal(
    comment('The end of a\nline and more.', 'a line'),
    'The end of {==a\nline==}{>>Ada, 2026-11-14: Note<<} and more.',
  );
});

test('emphasis is taken in whole rather than cut in half', () => {
  assert.equal(
    comment('Some **bold** text.', 'bold text'),
    'Some {==**bold** text==}{>>Ada, 2026-11-14: Note<<}.',
  );
  assert.equal(
    comment('Some **bold** text.', 'bold'),
    'Some **{==bold==}{>>Ada, 2026-11-14: Note<<}** text.',
  );
});

test('a link is crossed over, its address is not part of the text', () => {
  assert.equal(
    comment('See [the guide](https://example.org/guide) for more.', 'See the guide'),
    '{==See [the guide](https://example.org/guide)==}{>>Ada, 2026-11-14: Note<<} for more.',
  );
});

test('the occurrence the reader picked is the one that is commented', () => {
  const body = 'one two one two';
  assert.equal(comment(body, 'two', { occurrence: 1 }), 'one two one {==two==}{>>Ada, 2026-11-14: Note<<}');
  assert.equal(comments.occurrenceIndex('one two one two', 'two', 12), 1);
  assert.equal(comments.occurrenceIndex('one two one two', 'two', 3), 0);
});

test('an escaped character matches what the reader sees', () => {
  assert.equal(
    comment('Price \\*not\\* bold.', '*not*'),
    'Price {==\\*not\\*==}{>>Ada, 2026-11-14: Note<<} bold.',
  );
});

test('what cannot be placed exactly is refused with a reason', () => {
  assert.deepEqual(comment('Some text.', 'missing words'), { error: comments.COMMENT_ERRORS.NOT_FOUND });
  assert.deepEqual(comment('Some text.', '   '), { error: comments.COMMENT_ERRORS.EMPTY });
  assert.deepEqual(
    comment('A {==marked==}{>>x<<} word here.', 'A marked word'),
    { error: comments.COMMENT_ERRORS.OVERLAP },
  );
  assert.deepEqual(comment('a a', 'a', { occurrence: 5 }), { error: comments.COMMENT_ERRORS.AMBIGUOUS });
});

test('a reference link resolves against the definitions of the whole body', () => {
  const body = 'See [the docs][d] now.\n\n[d]: https://example.org\n';
  const [block] = comments.sourceBlocks(body);
  const blockSource = body.slice(block.start, block.end);
  const located = comments.locateSelection({ blockSource, selected: 'the docs', body });
  assert.equal(located.error, undefined);
});

// ── The comment ─────────────────────────────────────────────────────────────

test('a comment is written with author and date, and read back', () => {
  const raw = comments.formatComment({ author: 'Ada Lovelace', date: '2026-11-14', text: 'Line one\nline two' });
  assert.equal(raw, 'Ada Lovelace, 2026-11-14: Line one line two');
  assert.deepEqual(comments.parseComment(raw), { author: 'Ada Lovelace', date: '2026-11-14', text: 'Line one line two' });
});

test('without an author the date leads; text that is not ours stays text', () => {
  assert.equal(comments.formatComment({ author: '  ', date: '2026-11-14', text: 'x' }), '2026-11-14: x');
  assert.deepEqual(comments.parseComment('2026-11-14: x'), { author: '', date: '2026-11-14', text: 'x' });
  assert.deepEqual(comments.parseComment('just a remark'), { author: '', date: '', text: 'just a remark' });
});

test('a comment cannot close itself early', () => {
  const raw = comments.formatComment({ author: 'A: B', date: '2026-11-14', text: 'ends <<} here' });
  assert.equal(raw.includes('<<}'), false);
  assert.equal(comments.parseComment(raw).author, 'A B');
});

test('the date is the local calendar day', () => {
  assert.equal(comments.commentDate(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
});
