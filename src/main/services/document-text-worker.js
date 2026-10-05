'use strict';

/**
 * Extracting the text of a document off the main thread (#42).
 *
 * A 300-page PDF keeps pdf.js busy for seconds, and a workbook of a hundred
 * megabytes of XML keeps the tokenizer busy just as long — both synchronous
 * enough to freeze the window. In a worker_thread the work can also be cut
 * off: after the time budget, or when the user stops the run, the worker is
 * terminated, the way `regex-search-worker.js` does it for regular
 * expressions (#69).
 *
 * One worker per call: the calls are rare, and a fresh worker leaves nothing
 * of one document behind for the next.
 */

const path = require('path');
const { Worker } = require('worker_threads');

const DOCUMENT_TEXT_TIME_BUDGET_MS = 30000;
/** Heap of the worker. A document that needs more is not one to read whole. */
const WORKER_HEAP_MB = 1024;

// Started from source, not from a file name: the same way regex-search-worker
// does it, which is proven to work from inside the app's asar archive.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
require(workerData.entry).runInWorker(parentPort, workerData);
`;

/**
 * The part that runs inside the worker. Loads pdf.js only when a PDF comes —
 * a DOCX never pays for it.
 */
function runInWorker(port, { pdfjsDir }) {
  const { pathToFileURL } = require('url');
  const { extractDocumentText } = require('./document-text');
  const { openPdf } = require('./pdf-text');

  async function loadPdfjs() {
    // pdf.js advises its legacy build in Node on import; Electron's runtime is
    // new enough for the modern one, so the advice is only noise in the log.
    const { log, warn } = console;
    console.log = () => {};
    console.warn = () => {};
    try {
      // Handing pdf.js its worker module up front keeps it from starting
      // another one: inside this thread it runs the parser in place.
      globalThis.pdfjsWorker = await import(pathToFileURL(path.join(pdfjsDir, 'pdf.worker.min.mjs')).href);
      return await import(pathToFileURL(path.join(pdfjsDir, 'pdf.min.mjs')).href);
    } finally {
      console.log = log;
      console.warn = warn;
    }
  }

  port.once('message', async ({ bytes, request }) => {
    try {
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const result = await extractDocumentText(buffer, request, {
        openPdf: async (data) => openPdf(data, {
          pdfjs: await loadPdfjs(),
          cMapUrl: `${path.join(pdfjsDir, 'cmaps')}${path.sep}`,
          standardFontDataUrl: `${path.join(pdfjsDir, 'standard_fonts')}${path.sep}`,
        }),
      });
      port.postMessage({ result });
    } catch (error) {
      port.postMessage({ result: { error: error?.message || 'The text could not be extracted.' } });
    }
  });
}

/**
 * @param {object} params
 * @param {string} params.pdfjsDir  the vendored pdf.js (`src/renderer/vendor/pdfjs`)
 * @param {number} [params.timeBudgetMs]
 */
function createDocumentTextExtractor({ pdfjsDir, timeBudgetMs = DOCUMENT_TEXT_TIME_BUDGET_MS }) {
  /** `{ ...result }` or `{ error }`; never throws. */
  function extract(bytes, request, { abortSignal } = {}) {
    if (abortSignal?.aborted) return Promise.resolve({ error: 'The extraction was cancelled.' });
    return new Promise((resolve) => {
      // A copy of its own, so it can be handed over instead of cloned — the
      // Buffer of a read may share its memory with others.
      const copy = new Uint8Array(bytes);
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { entry: __filename, pdfjsDir },
        resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortSignal?.removeEventListener?.('abort', onAbort);
        worker.terminate().catch(() => {});
        resolve(result);
      };
      const timer = setTimeout(() => finish({
        error:
          `Extracting the text took longer than ${Math.round(timeBudgetMs / 1000)} s and was stopped. ` +
          'Ask for fewer pages, or a smaller sheet range.',
      }), timeBudgetMs);
      const onAbort = () => finish({ error: 'The extraction was cancelled.' });
      abortSignal?.addEventListener?.('abort', onAbort, { once: true });
      worker.on('message', (message) => finish(message?.result || { error: 'The text could not be extracted.' }));
      worker.on('error', (error) => finish({
        error: error?.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? 'The document is too large to extract in one go. Ask for fewer pages, or a smaller sheet range.'
          : error?.message || 'The text could not be extracted.',
      }));
      worker.on('exit', () => finish({ error: 'The text could not be extracted.' }));
      worker.postMessage({ bytes: copy, request }, [copy.buffer]);
    });
  }

  return { extract };
}

module.exports = { createDocumentTextExtractor, runInWorker, DOCUMENT_TEXT_TIME_BUDGET_MS };
