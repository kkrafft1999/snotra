// pdf.js for the PDF view (#346): loading the library, and opening a document
// the way the view needs it.
//
// The library, its worker and its data files are vendored under
// `vendor/pdfjs/` (scripts/sync-renderer-vendor.js). Library and worker load
// as ordinary scripts from the app itself — `script-src 'self'` covers both,
// and a worker falls back to that directive. The data files (CMaps, standard
// fonts, image decoders) would need `connect-src`, which the renderer does
// not have and must not get: under `file:`, where the page came from until
// #1012, it would have opened every file on the disk. pdf.js therefore gets a BinaryDataFactory that asks the main process
// for them (`pdf:readAsset`), by kind and name.
//
// What is switched off, and why:
//   * No code from strings. pdf.js 6 no longer compiles any and dropped
//     `isEvalSupported` with it; an option it does not know protects
//     nothing, so none is passed (#641). In the page
//     the CSP would refuse it (`script-src 'self'`, no `'unsafe-eval'`). The
//     worker, loaded from a `snotra-app:` URL, gets no CSP at all: there it is the
//     vendored code that holds, and test/workspace-pdf.test.js checks it.
//   * `enableXfa: false` — XFA forms are HTML that pdf.js would put into the
//     page. The view shows the drawn page, nothing else.
//   * No scripting. PDF JavaScript only runs through pdf.js's scripting
//     sandbox, which is not vendored and never created here.
//   * No annotation layer. Links are drawn as part of the page, but there is
//     no element to click: a link in a PDF does nothing. Comments are the
//     one kind of annotation that gets a button, from `pdf-comments.js`,
//     and their text only ever goes in as text (#1299).

const BASE = new URL('../vendor/pdfjs/', import.meta.url);

let libraryPromise = null;

/** The pdf.js module, loaded once per window. */
export function loadPdfjs() {
  libraryPromise ??= import(new URL('pdf.min.mjs', BASE).href).then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', BASE).href;
    return pdfjs;
  }).catch((err) => {
    // A failed import must not stick: the next PDF tries again.
    libraryPromise = null;
    throw err;
  });
  return libraryPromise;
}

/**
 * The BinaryDataFactory pdf.js constructs with its URL options and asks for
 * `{ kind, filename }`. The URLs only serve as "this kind is configured";
 * the bytes come from the main process.
 */
export function createIpcBinaryDataFactory(api) {
  return class IpcBinaryDataFactory {
    constructor(options = {}) {
      this.options = options;
    }

    async fetch({ kind, filename }) {
      const result = typeof api?.readPdfAsset === 'function'
        ? await api.readPdfAsset(kind, filename)
        : null;
      if (!result?.ok) throw new Error(`Unable to load ${kind} data: ${filename}`);
      return result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes);
    }
  };
}

/**
 * Opens a document from its bytes. `onPassword(answer, reason)` is called
 * when the document asks for a password — `reason` is 'need' or 'incorrect',
 * `answer(password)` tries one. It is set on the loading task before pdf.js
 * can ask; set later, the question goes unanswered and the load fails.
 *
 * Resolves to `{ promise, destroy }`: the document, and the way to let go of
 * it and its worker when the view goes away.
 */
export async function openPdfDocument(api, bytes, { onPassword } = {}) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: bytes,
    BinaryDataFactory: createIpcBinaryDataFactory(api),
    cMapUrl: new URL('cmaps/', BASE).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', BASE).href,
    // Also the base for the decoders' JavaScript fallback, which the worker
    // imports as a script when WebAssembly is not available.
    wasmUrl: new URL('wasm/', BASE).href,
    useWorkerFetch: false,
    enableXfa: false,
  });
  if (onPassword) {
    task.onPassword = (answer, reason) => {
      onPassword(answer, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'need');
    };
  }
  return { promise: task.promise, destroy: () => task.destroy() };
}

/**
 * The text of a page as a layer of transparent, selectable text over the
 * canvas (#1386), by pdf.js's public `TextLayer`. Nothing in it acts: it is
 * spans of text, no links, no form fields. Answers `{ promise, cancel }`; the
 * promise settles once the text is laid out.
 */
export function renderTextLayer(page, container, viewport) {
  let layer = null;
  let cancelled = false;
  const promise = loadPdfjs().then((pdfjs) => {
    if (cancelled) return;
    layer = new pdfjs.TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container,
      viewport,
    });
    return layer.render();
  });
  return {
    promise,
    cancel() {
      cancelled = true;
      layer?.cancel();
    },
  };
}

// pdf.js's `AnnotationEditorPrefix`: storage keys with it are annotations to
// be written — new ones, or `deleted` ones to be dropped. Not exported by
// pdf.js; `test/pdf-annotate.test.js` writes, deletes and reads back comments
// through the real pdf.js, so an update that changes it fails there.
const NEW_ANNOTATION_PREFIX = 'pdfjs_internal_editor_';
let saveCounter = 0;

/**
 * The document with one more highlight (#1386), as the bytes of the file:
 * pdf.js appends an incremental update and leaves everything before it as
 * it was. `highlight` from `highlightAnnotation()` in `pdf-annotate.js`.
 */
export async function saveWithHighlight(doc, highlight) {
  return addHighlight(await loadPdfjs(), doc, highlight);
}

/** `saveWithHighlight` with the pdf.js module given — for the round-trip test in Node. */
export async function addHighlight(pdfjs, doc, highlight) {
  saveCounter += 1;
  const key = `${NEW_ANNOTATION_PREFIX}snotra-comment-${saveCounter}`;
  doc.annotationStorage.setValue(key, { annotationType: pdfjs.AnnotationEditorType.HIGHLIGHT, ...highlight });
  try {
    return await doc.saveDocument();
  } finally {
    doc.annotationStorage.remove(key);
  }
}

/**
 * The document without a comment (#1397), as the bytes of the file: pdf.js
 * drops the annotations from the page's /Annots, frees their objects and
 * appends that as an incremental update, so the old file stays at the start
 * of the new one. `refs` are a comment's `refs` from `commentsFromAnnotations`
 * — the comment, its replies and their popups — on page `pageIndex`.
 */
export async function saveWithoutAnnotations(doc, pageIndex, refs) {
  saveCounter += 1;
  const keys = refs.map(({ id, popupRef }, i) => {
    const key = `${NEW_ANNOTATION_PREFIX}snotra-delete-${saveCounter}-${i}`;
    doc.annotationStorage.setValue(key, { id, deleted: true, pageIndex, popupRef: popupRef || '' });
    return key;
  });
  try {
    return await doc.saveDocument();
  } finally {
    for (const key of keys) doc.annotationStorage.remove(key);
  }
}

// ── Replies (#1399) ─────────────────────────────────────────────────────────
//
// pdf.js reads replies (`/IRT`) but writes none: it creates highlights, text
// boxes, ink and stamps. A reply therefore takes two appended updates. pdf.js
// writes the first, a placeholder highlight, and with it the page's /Annots
// that list it — the page object stays pdf.js's business, never parsed here.
// The second, written below, defines the placeholder's object again as the
// reply. Both are appended: the old file stays the start of the new one, and
// the write takes the same guarded way as a new comment.

// Print | NoZoom | NoRotate, as a reader writes a reply: it is listed with its
// comment and has no appearance of its own on the page.
const REPLY_FLAGS = 4 | 8 | 16;
const REPLY_ICON_PT = 20;

/**
 * The document with one more reply to a comment, as the bytes of the file.
 * `reply`: `{ pageIndex, parentId, parentRect, text, author, date }`, with
 * `parentId` the comment's object as pdf.js names it (`'12R'`).
 */
export async function saveWithReply(doc, reply) {
  return addReply(await loadPdfjs(), doc, reply);
}

/** `saveWithReply` with the pdf.js module given — for the round-trip test in Node. */
export async function addReply(pdfjs, doc, { pageIndex, parentId, parentRect, text, author, date }) {
  saveCounter += 1;
  // What finds the placeholder again in the bytes pdf.js appends.
  const marker = `snotra-reply-${saveCounter}-${Math.random().toString(36).slice(2, 10)}`;
  const [x1, , , y2] = parentRect;
  const key = `${NEW_ANNOTATION_PREFIX}snotra-reply-${saveCounter}`;
  doc.annotationStorage.setValue(key, {
    annotationType: pdfjs.AnnotationEditorType.HIGHLIGHT,
    pageIndex,
    rect: [x1, y2 - 1, x1 + 1, y2],
    quadPoints: [x1, y2, x1 + 1, y2, x1, y2 - 1, x1 + 1, y2 - 1],
    outlines: [[x1, y2 - 1, x1, y2, x1 + 1, y2, x1 + 1, y2 - 1]],
    color: [255, 255, 152],
    opacity: 1,
    user: author || undefined,
    date,
    popup: { contents: marker, rect: [x1, y2 - 120, x1 + 200, y2] },
  });
  let bytes;
  try {
    bytes = await doc.saveDocument();
  } finally {
    doc.annotationStorage.remove(key);
  }
  return redefineAsReply(bytes, {
    marker,
    parentId,
    rect: [x1, y2 - REPLY_ICON_PT, x1 + REPLY_ICON_PT, y2],
    text,
    author,
    date,
  });
}

/** A PDF text string as UTF-16BE hex: any name and any text, nothing to escape. */
export function pdfTextString(value) {
  let hex = 'FEFF';
  const text = String(value ?? '');
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}

function pdfDate(date) {
  return `D:${date.toISOString().replace(/[-:T]/g, '').slice(0, 14)}Z`;
}

/** pdf.js's name for an object (`'12R'`, `'12R3'`) as a PDF reference. */
function refOf(id) {
  const m = /^(\d+)R(\d*)$/.exec(String(id));
  if (!m) throw new Error(`not an object reference: ${id}`);
  return `${m[1]} ${m[2] || 0} R`;
}

function lastMatch(re, text, before = text.length) {
  let found = null;
  for (const m of text.matchAll(re)) {
    if (m.index >= before) break;
    found = m;
  }
  return found;
}

/**
 * Appends an update that defines the placeholder object carrying `marker`
 * again, as a reply to `parentId`, and its appearance as an empty one — a
 * reply draws nothing on the page, in any reader. The cross-reference is a
 * table or a stream, whichever the update before it used. Throws when the
 * bytes are not what pdf.js writes; then nothing is saved.
 */
export function redefineAsReply(bytes, { marker, parentId, rect, text, author, date }) {
  // One character per byte, so an index in the text is an offset in the file.
  const source = new TextDecoder('latin1').decode(bytes);
  const at = source.lastIndexOf(`(${marker})`);
  if (at < 0) throw new Error('the reply placeholder is not in the saved document');
  const head = lastMatch(/(\d+) (\d+) obj\b/g, source, at);
  const end = source.indexOf('endobj', at);
  if (!head || end < 0) throw new Error('the reply placeholder is not an object');
  const placeholder = source.slice(head.index, end);
  const popup = /\/Popup (\d+ \d+ R)/.exec(placeholder)?.[1] ?? null;
  const appearance = /\/AP\s*<<\s*\/N (\d+) (\d+) R/.exec(placeholder);

  const startxref = lastMatch(/startxref\s+(\d+)/g, source);
  if (!startxref) throw new Error('no startxref');
  const prev = Number(startxref[1]);
  const classic = source.startsWith('xref', prev);
  const trailer = classic
    ? source.slice(source.indexOf('trailer', prev), startxref.index)
    : source.slice(prev, source.indexOf('stream', prev));
  const root = /\/Root (\d+ \d+ R)/.exec(trailer)?.[1];
  const size = Number(/\/Size (\d+)/.exec(trailer)?.[1]);
  if (!root || !Number.isInteger(size) || size <= Number(head[1])) throw new Error('no usable trailer');
  const info = /\/Info (\d+ \d+ R)/.exec(trailer)?.[1];
  const id = /\/ID\s*(\[[^\]]*\])/.exec(trailer)?.[1];
  const carried = `/Root ${root}${info ? ` /Info ${info}` : ''}${id ? ` /ID ${id}` : ''} /Prev ${prev}`;

  const when = pdfDate(date);
  const objects = [{
    num: Number(head[1]),
    gen: Number(head[2]),
    body: `<< /Type /Annot /Subtype /Text /IRT ${refOf(parentId)} /Rect [${rect.join(' ')}] /F ${REPLY_FLAGS}`
      + ` /Name /Comment /Open false /T ${pdfTextString(author)} /Contents ${pdfTextString(text)}`
      + ` /M (${when}) /CreationDate (${when})`
      + `${appearance ? ` /AP << /N ${appearance[1]} ${appearance[2]} R >>` : ''}${popup ? ` /Popup ${popup}` : ''} >>`,
  }];
  if (appearance) {
    objects.push({
      num: Number(appearance[1]),
      gen: Number(appearance[2]),
      body: `<< /Type /XObject /Subtype /Form /BBox [0 0 ${REPLY_ICON_PT} ${REPLY_ICON_PT}] /Length 0 >>\nstream\n\nendstream`,
    });
  }
  objects.sort((a, b) => a.num - b.num);

  const encoder = new TextEncoder();
  const parts = [];
  let offset = bytes.length;
  const push = (part) => {
    parts.push(part);
    offset += part.length;
  };
  for (const object of objects) {
    object.offset = offset + 1;
    push(encoder.encode(`\n${object.num} ${object.gen} obj\n${object.body}\nendobj\n`));
  }
  const xrefOffset = offset;
  if (classic) {
    const rows = objects.map((o) => `${o.num} 1\n${String(o.offset).padStart(10, '0')} ${String(o.gen).padStart(5, '0')} n \n`).join('');
    push(encoder.encode(`xref\n${rows}trailer\n<< /Size ${size} ${carried} >>\nstartxref\n${xrefOffset}\n%%EOF\n`));
  } else {
    // The stream is an object of its own, the next free number, and lists
    // itself; uncompressed.
    const listed = [...objects, { num: size, gen: 0, offset: xrefOffset }];
    const entries = new Uint8Array(listed.length * 7);
    const view = new DataView(entries.buffer);
    listed.forEach((o, i) => {
      view.setUint8(i * 7, 1);
      view.setUint32(i * 7 + 1, o.offset);
      view.setUint16(i * 7 + 5, o.gen);
    });
    const index = listed.map((o) => `${o.num} 1`).join(' ');
    push(encoder.encode(`${size} 0 obj\n<< /Type /XRef /Size ${size + 1} /Index [${index}] /W [1 4 2] ${carried} /Length ${entries.length} >>\nstream\n`));
    push(entries);
    push(encoder.encode(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`));
  }
  const out = new Uint8Array(offset);
  out.set(bytes, 0);
  let cursor = bytes.length;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/**
 * Why this document takes no comments, or null: a signature over it is
 * left alone, and so is a protected file — `'signed'`, `'protected'`.
 */
export async function commentBlockReason(doc) {
  try {
    const { info } = await doc.getMetadata();
    if (info?.IsSignaturesPresent) return 'signed';
    if (info?.EncryptFilterName) return 'protected';
    return null;
  } catch {
    // Unreadable metadata: no way to tell, so no write.
    return 'protected';
  }
}
