// New comments in the PDF view (#1386): the geometry of a selection, the
// annotation it becomes, and a round trip through the real pdf.js — the
// comment written, the file opened again, the comment read back by the same
// code that shows comments in the view.
//
// The round trip is the guard for what pdf.js does not promise: the shape
// of a new annotation in its storage and the key prefix that marks one.
// A pdf.js update that changes either fails here, not in a user's file.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

const ROOT = path.join(__dirname, '..');

/** A page of 595 × 842 pt shown at `scale` CSS px per pt, as pdf.js converts. */
function viewportAt(scale, height = 842) {
  return {
    convertToPdfPoint: (x, y) => [x / scale, height - y / scale],
    convertToViewportPoint: (x, y) => [x * scale, (height - y) * scale],
  };
}

const rect = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height });

test('the selection on a page becomes one box per run of a line, in PDF space', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const { selectionBoxes } = await importRenderer('file-views', 'pdf-annotate.js');
  const page = rect(100, 50, 1190, 1684); // at scale 2
  const boxes = selectionBoxes([
    // Two spans of the first line, touching; one of the second line.
    rect(200, 150, 100, 20), rect(300, 151, 80, 19),
    rect(200, 180, 60, 20),
    // A sliver, and the whole text layer the range swallowed: both dropped.
    rect(500, 500, 0.5, 20), rect(100, 50, 1190, 1684),
  ], page, viewportAt(2));
  assert.deepEqual(boxes, [
    { x1: 50, y1: 842 - 60, x2: 140, y2: 842 - 50 },
    { x1: 50, y1: 842 - 75, x2: 80, y2: 842 - 65 },
  ]);
});

test('two columns on one line stay two boxes; a rectangle off the page is clipped', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const { selectionBoxes, mergeLines } = await importRenderer('file-views', 'pdf-annotate.js');
  const merged = mergeLines([
    { x1: 50, y1: 700, x2: 250, y2: 712 },
    { x1: 320, y1: 700, x2: 520, y2: 712 },
  ]);
  assert.equal(merged.length, 2, 'a gap wider than the line is a gutter');
  const clipped = selectionBoxes([rect(-40, 0, 80, 10)], rect(0, 0, 595, 842), viewportAt(1));
  assert.deepEqual(clipped, [{ x1: 0, y1: 832, x2: 40, y2: 842 }]);
});

test('the annotation carries quads, outlines, author, date and the comment', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const { highlightAnnotation, HIGHLIGHT_COLOR } = await importRenderer('file-views', 'pdf-annotate.js');
  const date = new Date('2026-11-14T10:00:00Z');
  const a = highlightAnnotation({
    pageIndex: 2,
    boxes: [{ x1: 50, y1: 700, x2: 200, y2: 712 }, { x1: 50, y1: 686, x2: 120, y2: 698 }],
    text: 'Check this',
    author: 'Kim',
    date,
  });
  assert.equal(a.pageIndex, 2);
  assert.deepEqual(a.rect, [50, 686, 200, 712]);
  assert.deepEqual(a.quadPoints.slice(0, 8), [50, 712, 200, 712, 50, 700, 200, 700]);
  assert.deepEqual(a.outlines[0], [50, 700, 50, 712, 200, 712, 200, 700]);
  assert.deepEqual(a.color, [...HIGHLIGHT_COLOR]);
  assert.equal(a.user, 'Kim');
  assert.equal(a.date, date);
  assert.equal(a.popup.contents, 'Check this');
  assert.equal(highlightAnnotation({ pageIndex: 0, boxes: [{ x1: 0, y1: 0, x2: 1, y2: 1 }], text: 'x', author: '', date }).user,
    undefined, 'no name, no /T');
});

test('pdf.js writes the comment as an appended highlight that reads back as a comment', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const pdfjs = await import(pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  const { makeTextPdf } = await import(pathToFileURL(path.join(ROOT, 'e2e/helpers/pdf-fixtures.mjs')).href);
  const { addHighlight, commentBlockReason } = await importRenderer('file-views', 'pdf-engine.js');
  const { highlightAnnotation } = await importRenderer('file-views', 'pdf-annotate.js');
  const { commentsFromAnnotations } = await importRenderer('file-views', 'pdf-comments.js');

  const original = new Uint8Array(makeTextPdf({ pages: 2 }));
  const open = (bytes) => pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useWorkerFetch: false, verbosity: 0 }).promise;
  const doc = await open(original);
  t.after(() => doc.loadingTask.destroy());
  assert.equal(await commentBlockReason(doc), null, 'a plain PDF takes comments');

  const date = new Date('2026-11-14T10:00:00Z');
  const saved = await addHighlight(pdfjs, doc, highlightAnnotation({
    pageIndex: 1,
    boxes: [{ x1: 56, y1: 700, x2: 300, y2: 714 }],
    text: 'Grüße — and a second line\nhere',
    author: 'Kim Example',
    date,
  }));
  assert.ok(saved.length > original.length);
  assert.deepEqual(saved.subarray(0, original.length), original, 'the old file is untouched at the start');
  assert.equal(doc.annotationStorage.size, 0, 'nothing is left in the storage');

  const reopened = await open(saved);
  t.after(() => reopened.loadingTask.destroy());
  const page = await reopened.getPage(2);
  const annotations = await page.getAnnotations({ intent: 'display' });
  const highlight = annotations.find((a) => a.subtype === 'Highlight');
  assert.ok(highlight, 'a highlight on page 2');
  assert.equal(highlight.contentsObj.str, 'Grüße — and a second line\nhere');
  assert.equal(highlight.titleObj.str, 'Kim Example');
  assert.deepEqual([...highlight.quadPoints].map(Math.round), [56, 714, 300, 714, 56, 700, 300, 700]);
  assert.ok(annotations.some((a) => a.subtype === 'Popup'), 'with a popup, as readers expect');
  assert.equal((await (await reopened.getPage(1)).getAnnotations()).length, 0, 'page 1 untouched');

  const [comment] = commentsFromAnnotations(annotations);
  assert.equal(comment.text, 'Grüße — and a second line\nhere');
  assert.equal(comment.author, 'Kim Example');
  assert.equal(comment.date?.toISOString(), date.toISOString());
});

test('pdf.js deletes a comment with its replies and popup as an appended update (#1397)', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const pdfjs = await import(pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  const { makeTextPdf, lineRect } = await import(pathToFileURL(path.join(ROOT, 'e2e/helpers/pdf-fixtures.mjs')).href);
  const { addHighlight, saveWithoutAnnotations } = await importRenderer('file-views', 'pdf-engine.js');
  const { highlightAnnotation } = await importRenderer('file-views', 'pdf-annotate.js');
  const { commentsFromAnnotations } = await importRenderer('file-views', 'pdf-comments.js');
  const open = async (bytes) => {
    const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useWorkerFetch: false, verbosity: 0 }).promise;
    t.after(() => doc.loadingTask.destroy());
    return doc;
  };
  const annotationsOf = async (doc) => (await doc.getPage(1)).getAnnotations({ intent: 'display' });

  // Two comments from another tool, the first with two replies.
  const date = new Date('2026-11-01T09:00:00Z');
  const original = new Uint8Array(makeTextPdf({
    comments: [
      { kind: 'highlight', rect: lineRect(0), author: 'Ada', text: 'Check this.', date, replies: [
        { author: 'Grace', text: 'Asked sales.', date },
        { author: 'Alan', text: 'Two years.', date },
      ] },
      { kind: 'note', rect: lineRect(2, 20), author: 'Grace', text: 'Keep this one.', date },
    ],
  }));
  const doc = await open(original);
  const [threaded, kept] = commentsFromAnnotations(await annotationsOf(doc));
  assert.equal(threaded.replies.length, 2);
  assert.equal(threaded.refs.length, 3, 'the comment and both replies');

  const saved = await saveWithoutAnnotations(doc, 0, threaded.refs);
  assert.deepEqual(saved.subarray(0, original.length), original, 'the old file is untouched at the start');
  assert.equal(doc.annotationStorage.size, 0, 'nothing is left in the storage');
  const after = await annotationsOf(await open(saved));
  assert.deepEqual(after.map((a) => a.contentsObj?.str), ['Keep this one.'], 'replies gone with their comment, the other comment kept');
  assert.equal(commentsFromAnnotations(after)[0].id, kept.id);

  // A comment written by Snotra carries a popup; it goes with the comment.
  const withOwn = await addHighlight(pdfjs, await open(saved), highlightAnnotation({
    pageIndex: 0, boxes: [{ x1: 56, y1: 600, x2: 300, y2: 614 }], text: 'Mine.', author: 'Kim', date,
  }));
  const ownDoc = await open(withOwn);
  const own = commentsFromAnnotations(await annotationsOf(ownDoc)).find((c) => c.text === 'Mine.');
  assert.ok(own.refs[0].popupRef, 'the popup is named');
  const cleared = await saveWithoutAnnotations(ownDoc, 0, own.refs);
  const left = await annotationsOf(await open(cleared));
  assert.deepEqual(left.map((a) => a.subtype), ['Text'], 'neither the highlight nor its popup is left');
});

for (const xrefStream of [false, true]) {
  test(`a reply is appended as an /IRT text annotation and reads back under its comment (#1399, ${xrefStream ? 'xref stream' : 'xref table'})`, async (t) => {
    const dom = setupRendererDom();
    t.after(() => dom.cleanup());
    const pdfjs = await import(pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
    const { makeTextPdf, lineRect } = await import(pathToFileURL(path.join(ROOT, 'e2e/helpers/pdf-fixtures.mjs')).href);
    const { addReply } = await importRenderer('file-views', 'pdf-engine.js');
    const { commentsFromAnnotations } = await importRenderer('file-views', 'pdf-comments.js');
    const open = async (bytes) => {
      const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useWorkerFetch: false, verbosity: 0 }).promise;
      t.after(() => doc.loadingTask.destroy());
      return doc;
    };
    const annotationsOf = async (doc) => (await doc.getPage(1)).getAnnotations({ intent: 'display' });

    const first = new Date('2026-11-01T09:00:00Z');
    const original = new Uint8Array(makeTextPdf({
      xrefStream,
      comments: [{ kind: 'highlight', rect: lineRect(0), author: 'Ada', text: 'Check this.', date: first, replies: [
        { author: 'Grace', text: 'Asked sales.', date: first },
      ] }],
    }));
    const doc = await open(original);
    const [comment] = commentsFromAnnotations(await annotationsOf(doc));
    const date = new Date('2026-11-14T10:30:00Z');
    const saved = await addReply(pdfjs, doc, {
      pageIndex: 0, parentId: comment.id, parentRect: comment.rect, text: 'Two years — confirmed (Grüße).', author: 'Zoë Example', date,
    });
    assert.deepEqual(saved.subarray(0, original.length), original, 'the old file is untouched at the start');
    assert.equal(doc.annotationStorage.size, 0, 'nothing is left in the storage');
    const tail = Buffer.from(saved.subarray(original.length)).toString('latin1');
    assert.equal(Buffer.from(original).includes('/Type /XRef'), xrefStream, 'the fixture has the kind of cross-reference it claims');
    assert.equal((tail.match(/\/Type \/XRef/g) ?? []).length, xrefStream ? 2 : 0, 'both updates keep that kind');

    const reopened = await open(saved);
    const annotations = await annotationsOf(reopened);
    const [after] = commentsFromAnnotations(annotations);
    assert.equal(after.id, comment.id);
    assert.deepEqual(after.replies.map((r) => [r.author, r.text]), [
      ['Grace', 'Asked sales.'],
      ['Zoë Example', 'Two years — confirmed (Grüße).'],
    ]);
    assert.equal(after.replies[1].date?.toISOString(), date.toISOString());
    assert.equal(annotations.filter((a) => a.subtype === 'Highlight').length, 1, 'the placeholder is gone, only the comment is a highlight');
    const reply = annotations.find((a) => a.contentsObj?.str === 'Two years — confirmed (Grüße).');
    assert.equal(reply.subtype, 'Text');
    assert.equal(reply.inReplyTo, comment.id);
    assert.equal(after.refs.length, 3, 'deleting the comment takes the new reply along');
  });
}

test('a protected PDF takes no comments', async (t) => {
  const dom = setupRendererDom();
  t.after(() => dom.cleanup());
  const pdfjs = await import(pathToFileURL(path.join(ROOT, 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href);
  const { makeEncryptedPdf } = await import(pathToFileURL(path.join(ROOT, 'e2e/helpers/pdf-fixtures.mjs')).href);
  const { commentBlockReason } = await importRenderer('file-views', 'pdf-engine.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(makeEncryptedPdf({ password: 'secret' })), password: 'secret', isEvalSupported: false, verbosity: 0 }).promise;
  t.after(() => doc.loadingTask.destroy());
  assert.equal(await commentBlockReason(doc), 'protected');
  assert.equal(await commentBlockReason({ getMetadata: async () => ({ info: { IsSignaturesPresent: true } }) }), 'signed');
  assert.equal(await commentBlockReason({ getMetadata: async () => { throw new Error('x'); } }), 'protected');
});
