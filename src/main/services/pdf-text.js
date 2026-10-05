'use strict';

/**
 * The text layer of a PDF (#42), through the pdf.js the file preview already
 * ships (#346) — no second PDF library.
 *
 * pdf.js is handed in rather than required: it is an ES module that lives next
 * to the renderer code, and it needs a runtime as new as Electron's (the
 * modern build uses `Uint8Array.prototype.toHex`, which plain Node 24 lacks).
 * `document-text-worker.js` loads it and passes it here.
 */

class PdfPasswordError extends Error {
  constructor() {
    super('The PDF is password-protected; its text cannot be read.');
    this.name = 'PdfPasswordError';
  }
}

/**
 * One page's text items as lines. pdf.js marks line ends itself (`hasEOL`),
 * but not the gaps between items on a line — a gap wider than a fraction of
 * the font size becomes a space, a jump in height a line break.
 */
function joinTextItems(items) {
  let out = '';
  let lastY = null;
  let lastEnd = null;
  for (const item of items) {
    if (typeof item?.str !== 'string') continue;
    const [a = 0, b = 0, c = 0, d = 0, x = 0, y = 0] = item.transform || [];
    const height = Math.hypot(c, d) || Math.hypot(a, b) || 1;
    if (item.str) {
      if (lastY !== null && Math.abs(y - lastY) > height * 0.5) {
        if (!out.endsWith('\n')) out += '\n';
      } else if (lastEnd !== null && x - lastEnd > height * 0.15 && !/\s$/.test(out) && !/^\s/.test(item.str)) {
        out += ' ';
      }
      out += item.str;
      lastY = y;
      lastEnd = x + (Number(item.width) || 0);
    }
    if (item.hasEOL) {
      out += '\n';
      lastEnd = null;
    }
  }
  return out
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Opens `bytes` with `pdfjs`. `cMapUrl` and `standardFontDataUrl` point at the
 * data files of the vendored copy; without the CMaps the text of CJK fonts
 * would come back as nothing.
 */
async function openPdf(bytes, { pdfjs, cMapUrl, standardFontDataUrl }) {
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
    // Text only: no script, no fonts of the document. `isEvalSupported` is not
    // passed: pdf.js 6 no longer knows it (#641), and test/workspace-pdf.test.js
    // guards the vendored code against `eval` itself.
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    await loadingTask.destroy().catch(() => {});
    if (error?.name === 'PasswordException') throw new PdfPasswordError();
    if (error?.name === 'InvalidPDFException') throw new Error('The PDF is damaged and cannot be read.');
    throw error;
  }
  let title = null;
  try {
    const meta = await doc.getMetadata();
    title = typeof meta?.info?.Title === 'string' && meta.info.Title.trim() ? meta.info.Title.trim() : null;
  } catch {
    /* no metadata is no reason to fail */
  }
  return {
    format: 'pdf',
    title,
    unitCount: doc.numPages,
    async readUnit(number) {
      const page = await doc.getPage(number);
      try {
        const content = await page.getTextContent();
        return joinTextItems(content.items);
      } finally {
        page.cleanup();
      }
    },
    close: () => loadingTask.destroy(),
  };
}

module.exports = { openPdf, joinTextItems, PdfPasswordError };
