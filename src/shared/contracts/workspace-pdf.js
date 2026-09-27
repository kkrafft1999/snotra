'use strict';

/**
 * Contract for the PDF view in the file preview (#346): the bytes of a PDF
 * from the open folder, and the data files pdf.js asks for while it renders.
 *
 * Both go through the main process, for the reason #244 gave for images: the
 * renderer never gets a path it could use on its own, and its CSP stays as it
 * is — no `file://` in a frame, no `connect-src`. The PDF travels as bytes
 * (a Uint8Array through structured clone), not as a `data:` URI: pdf.js wants
 * the bytes anyway, and base64 would cost a third more for nothing.
 */

/**
 * 50 MB. A scanned contract of a few hundred pages stays below it; above it
 * pdf.js would still manage, but the whole file sits in the renderer and in
 * the worker at once.
 */
const MAX_WORKSPACE_PDF_BYTES = 50 * 1024 * 1024;

/**
 * Why a PDF does not come. The first four share their values with the image
 * contract, so that both views can speak about a path in the same words.
 */
const WORKSPACE_PDF_ERRORS = Object.freeze({
  NO_WORKSPACE: 'no-workspace',
  OUTSIDE_WORKSPACE: 'outside-workspace',
  NOT_FOUND: 'not-found',
  TOO_LARGE: 'too-large',
  NOT_PDF: 'not-pdf',
});

/**
 * The spec puts `%PDF-` at the start, and every reader, pdf.js included,
 * accepts it within the first kilobyte — some generators write junk first.
 */
const WORKSPACE_PDF_SNIFF_BYTES = 1024;
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Does this head of a file belong to a PDF? The name does not count. */
function isPdfHeader(header) {
  const bytes = header || [];
  const end = Math.min(bytes.length, WORKSPACE_PDF_SNIFF_BYTES) - PDF_SIGNATURE.length;
  for (let start = 0; start <= end; start += 1) {
    let match = true;
    for (let i = 0; i < PDF_SIGNATURE.length; i += 1) {
      if (bytes[start + i] !== PDF_SIGNATURE[i]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
}

function createWorkspacePdfResult({ bytes, size = 0, mtimeMs = 0 } = {}) {
  return { ok: true, bytes, size, mtimeMs };
}

function createWorkspacePdfError(reason, extra = {}) {
  const known = Object.values(WORKSPACE_PDF_ERRORS).includes(reason)
    ? reason
    : WORKSPACE_PDF_ERRORS.NOT_FOUND;
  return { ok: false, reason: known, ...extra };
}

/**
 * The data pdf.js asks for, by the option name it uses for them, and the
 * folder under `src/renderer/vendor/pdfjs/` they are copied to. Nothing else
 * can be asked for: the ICC profile would need a synchronous request from
 * the worker, and without it CMYK colours are converted the simple way.
 */
const PDF_ASSET_DIRS = Object.freeze({
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
  wasmUrl: 'wasm',
});

/**
 * A file name pdf.js may ask for: one plain name, no path, no dot at the
 * start. `78-EUC-H.bcmap`, `FoxitSerif.pfb`, `openjpeg.wasm`.
 */
function isPdfAssetName(name) {
  return typeof name === 'string'
    && name.length <= 128
    && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
    && !name.includes('..');
}

module.exports = {
  MAX_WORKSPACE_PDF_BYTES,
  WORKSPACE_PDF_ERRORS,
  WORKSPACE_PDF_SNIFF_BYTES,
  PDF_ASSET_DIRS,
  isPdfHeader,
  isPdfAssetName,
  createWorkspacePdfResult,
  createWorkspacePdfError,
};
