// pdf.js for the PDF view (#346): loading the library, and opening a document
// the way the view needs it.
//
// The library, its worker and its data files are vendored under
// `vendor/pdfjs/` (scripts/sync-renderer-vendor.js). Library and worker load
// as ordinary scripts from the app itself — `script-src 'self'` covers both,
// and a worker falls back to that directive. The data files (CMaps, standard
// fonts, image decoders) would need `connect-src`, which the renderer does
// not have and must not get: under `file:` it would open every file on the
// disk. pdf.js therefore gets a BinaryDataFactory that asks the main process
// for them (`pdf:readAsset`), by kind and name.
//
// What is switched off, and why:
//   * `isEvalSupported: false` — pdf.js would otherwise try `new Function`
//     for faster glyph drawing; the CSP forbids it anyway.
//   * `enableXfa: false` — XFA forms are HTML that pdf.js would put into the
//     page. The view shows the drawn page, nothing else.
//   * No scripting. PDF JavaScript only runs through pdf.js's scripting
//     sandbox, which is not vendored and never created here.
//   * No annotation layer. Links are drawn as part of the page, but there is
//     no element to click: a link in a PDF does nothing.

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
    isEvalSupported: false,
    enableXfa: false,
  });
  if (onPassword) {
    task.onPassword = (answer, reason) => {
      onPassword(answer, reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'incorrect' : 'need');
    };
  }
  return { promise: task.promise, destroy: () => task.destroy() };
}
