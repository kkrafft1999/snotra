'use strict';

/**
 * `extract_document_text` (#42): which format a file is, which part of it was
 * asked for, and how much of that part goes back.
 *
 * The token goal is in the shape of the answer, not in a promise of the
 * description: never the whole document unasked, always a window of at most
 * `max_characters` with the way to the next one (`next_start_character`), and
 * the size of the whole (pages, slides, sheets) so the model can aim.
 *
 * Runs inside the worker of `document-text-worker.js`, which is why pdf.js
 * arrives as `openPdf` instead of being loaded here.
 */

const { openZip, ZipFormatError } = require('./zip-reader');
const { detectOfficeFormat, extractDocx, extractXlsx, extractPptx } = require('./office-text');

const DOCUMENT_TEXT_DEFAULT_MAX_CHARS = 16000;
const DOCUMENT_TEXT_MAX_CHARS = 100000;
const DOCUMENT_TEXT_MIN_CHARS = 1000;

/** What one part of an Office archive, and all parts together, may unpack to. */
const MAX_OFFICE_PART_BYTES = 100 * 1024 * 1024;
const MAX_OFFICE_TOTAL_BYTES = 200 * 1024 * 1024;

/** More numbers than this in `pages` is not a selection any more. */
const MAX_SELECTED_UNITS = 2000;

/** @type {Record<string, string>} */
const UNIT_LABELS = { pdf: 'Page', pptx: 'Slide' };

/**
 * What the tool answers: the keys the model reads (`content`, `truncated`,
 * `next_start_character`, ...), or `error` with a sentence it can act on.
 *
 * @typedef {{ error?: string, format?: string, title?: string } & Record<string, unknown>} DocumentAnswer
 *
 * What a page- or slide-wise document offers: its size and the text of one unit.
 * @typedef {{ format: string, unitCount: number, readUnit: (number: number) => Promise<string> }} UnitSource
 *
 * The arguments of the tool, as the model passed them.
 * @typedef {{ pages?: unknown, sheet?: unknown, range?: unknown, startCharacter?: unknown, maxCharacters?: unknown }} DocumentRequest
 */

/**
 * @param {Uint8Array} bytes
 * @param {number[]} signature
 * @param {number} [at]
 */
function startsWith(bytes, signature, at = 0) {
  if (bytes.length < at + signature.length) return false;
  return signature.every((byte, i) => bytes[at + i] === byte);
}

/**
 * 'pdf', 'ooxml', 'cfb' (the old binary Office format — and every
 * password-protected Office file, which is an encrypted ZIP inside one) or
 * null. The name does not count, the first bytes do.
 *
 * @param {Buffer} bytes
 * @returns {'pdf'|'ooxml'|'cfb'|null}
 */
function detectDocumentFormat(bytes) {
  const head = bytes.subarray(0, 1024);
  if (head.includes('%PDF-')) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'ooxml';
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'cfb';
  return null;
}

/**
 * "3", "2-5", "1-3,8,10-" (to the end) → page numbers, or `{ error }`.
 *
 * @param {unknown} raw
 * @param {number} count
 * @param {string} label
 * @returns {{ numbers: number[], error?: undefined } | { error: string, numbers?: undefined }}
 */
function parsePageSelection(raw, count, label) {
  const text = String(raw).replace(/\s+/g, '');
  /** @type {Set<number>} */
  const numbers = new Set();
  for (const part of text.split(',')) {
    const match = /^(\d+)(?:-(\d*))?$/.exec(part);
    if (!match) {
      return { error: `pages "${raw}" is not a selection like "3", "2-5" or "1-3,8".` };
    }
    const first = Number(match[1]);
    const last = match[2] === undefined ? first : match[2] === '' ? count : Number(match[2]);
    if (first < 1 || last < first) {
      return { error: `pages "${raw}": ranges start at 1 and run forwards.` };
    }
    if (first > count) {
      return { error: `pages "${raw}" lies beyond the end: the document has ${count} ${label.toLowerCase()}${count === 1 ? '' : 's'}.` };
    }
    for (let n = first; n <= Math.min(last, count); n += 1) {
      numbers.add(n);
      if (numbers.size > MAX_SELECTED_UNITS) {
        return { error: `pages "${raw}" selects more than ${MAX_SELECTED_UNITS} ${label.toLowerCase()}s.` };
      }
    }
  }
  return { numbers: [...numbers].sort((a, b) => a - b) };
}

/**
 * [1, 2, 3, 7, 9, 10] → "1-3,7,9-10".
 *
 * @param {number[]} numbers
 */
function compactRanges(numbers) {
  /** @type {string[]} */
  const parts = [];
  for (let i = 0; i < numbers.length; i += 1) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j += 1;
    parts.push(i === j ? String(numbers[i]) : `${numbers[i]}-${numbers[j]}`);
    i = j;
  }
  return parts.join(',');
}

/** @param {DocumentRequest} request */
function readWindow(request) {
  const { startCharacter, maxCharacters } = request;
  const start = typeof startCharacter === 'number' && Number.isInteger(startCharacter) && startCharacter > 0 ? startCharacter : 0;
  let max = typeof maxCharacters === 'number' && Number.isFinite(maxCharacters) ? Math.floor(maxCharacters) : DOCUMENT_TEXT_DEFAULT_MAX_CHARS;
  max = Math.min(Math.max(DOCUMENT_TEXT_MIN_CHARS, max), DOCUMENT_TEXT_MAX_CHARS);
  return { start, max };
}

/**
 * Cuts the window out of `full` and says how to go on.
 *
 * @param {string} full
 * @param {{ start: number, max: number }} window
 * @param {{ complete: boolean }} state
 * @returns {DocumentAnswer}
 */
function sliceWindow(full, { start, max }, { complete }) {
  if (start > 0 && start >= full.length && complete) {
    return { error: `start_character ${start} lies beyond the end of the text (${full.length} characters).` };
  }
  const end = start + max;
  const truncated = full.length > end || !complete;
  let content = full.slice(start, end);
  /** @type {DocumentAnswer} */
  const out = {};
  if (start > 0) out.start_character = start;
  if (complete) out.total_characters = full.length;
  out.truncated = truncated;
  if (truncated) {
    out.next_start_character = end;
    content += `\n… [truncated — continue with start_character=${end}]`;
  }
  out.content = content;
  return out;
}

/**
 * Page- or slide-wise documents: read unit by unit, and stop as soon as the
 * window is full — the 300th page of a manual is not parsed for the first 16 000
 * characters of it.
 *
 * @param {UnitSource} source
 * @param {DocumentRequest} request
 * @param {{ start: number, max: number }} window
 * @returns {Promise<DocumentAnswer>}
 */
async function sliceUnits(source, request, window) {
  const label = UNIT_LABELS[source.format];
  const count = source.unitCount;
  /** @type {number[]} */
  let numbers;
  if (request.pages !== undefined && request.pages !== null && String(request.pages).trim()) {
    const selection = parsePageSelection(request.pages, count, label);
    if (selection.error !== undefined) return { error: selection.error };
    numbers = selection.numbers;
  } else {
    numbers = Array.from({ length: count }, (_, i) => i + 1);
  }

  const needed = window.start + window.max + 1;
  /** @type {string[]} */
  const chunks = [];
  /** @type {Array<{ number: number, from: number, to: number, empty: boolean }>} */
  const spans = [];
  let length = 0;
  let complete = true;
  for (const number of numbers) {
    if (length >= needed) {
      complete = false;
      break;
    }
    const text = await source.readUnit(number);
    const chunk = `[${label} ${number}]\n${text || '(no text)'}\n\n`;
    spans.push({ number, from: length, to: length + chunk.length, empty: !text });
    chunks.push(chunk);
    length += chunk.length;
  }
  const full = chunks.join('').replace(/\n+$/, '');
  const sliced = sliceWindow(full, window, { complete });
  if (sliced.error) return sliced;

  const windowEnd = window.start + window.max;
  const shown = spans.filter((span) => span.from < windowEnd && span.to > window.start);
  /** @type {DocumentAnswer} */
  const out = { [source.format === 'pptx' ? 'slide_count' : 'page_count']: count };
  if (shown.length) out[source.format === 'pptx' ? 'slides' : 'pages'] = compactRanges(shown.map((span) => span.number));
  if (source.format === 'pdf' && shown.length && shown.every((span) => span.empty)) {
    out.hint = 'No text layer on these pages — the PDF probably holds scanned images. Text recognition (OCR) is not available.';
  }
  return { ...out, ...sliced };
}

/**
 * @param {string} format
 * @param {DocumentRequest} request
 */
function rejectForeignArguments(format, request) {
  /** @param {unknown} value */
  const has = (value) => value !== undefined && value !== null && String(value).trim() !== '';
  if (format !== 'xlsx' && (has(request.sheet) || has(request.range))) {
    return 'sheet and range apply to XLSX workbooks only.';
  }
  if (format !== 'pdf' && format !== 'pptx' && has(request.pages)) {
    return format === 'xlsx'
      ? 'pages applies to PDF and PPTX; choose a part of a workbook with sheet and range.'
      : 'pages applies to PDF and PPTX; a DOCX has no fixed pages — continue with start_character.';
  }
  return null;
}

/**
 * The answer of the tool, without the path and size the caller adds — or
 * `{ error }` with a sentence the model can act on.
 *
 * @param {Buffer} bytes
 * @param {DocumentRequest} request
 * @param {{ openPdf: (data: Uint8Array) => Promise<import('./pdf-text').PdfSource> }} deps
 * @returns {Promise<DocumentAnswer>}
 */
async function extractDocumentText(bytes, request, { openPdf }) {
  const kind = detectDocumentFormat(bytes);
  if (kind === 'cfb') {
    return {
      error:
        'This is a password-protected Office file or an old binary one (.doc, .xls, .ppt). Neither can be read; ' +
        'an unprotected copy saved as .docx, .xlsx or .pptx can.',
    };
  }
  if (!kind) {
    return { error: 'Not a PDF, DOCX, XLSX or PPTX file. For plain text files use read_file_text.' };
  }
  const window = readWindow(request);

  if (kind === 'pdf') {
    const foreign = rejectForeignArguments('pdf', request);
    if (foreign) return { error: foreign };
    const pdf = await openPdf(new Uint8Array(bytes));
    try {
      return withTitle(pdf.title, { format: 'pdf', ...(await sliceUnits(pdf, request, window)) });
    } finally {
      await pdf.close();
    }
  }

  /** @type {ReturnType<typeof openZip>} */
  let zip;
  /** @type {ReturnType<typeof detectOfficeFormat>} */
  let format;
  try {
    zip = openZip(bytes, { maxEntryBytes: MAX_OFFICE_PART_BYTES, maxTotalBytes: MAX_OFFICE_TOTAL_BYTES });
    format = detectOfficeFormat(zip);
  } catch (error) {
    if (error instanceof ZipFormatError) return { error: `The file cannot be opened: ${error.message}` };
    throw error;
  }
  if (!format) {
    return { error: 'A ZIP archive, but not a DOCX, XLSX or PPTX document.' };
  }
  const foreign = rejectForeignArguments(format, request);
  if (foreign) return { error: foreign };

  try {
    if (format === 'pptx') {
      const deck = extractPptx(zip);
      return withTitle(deck.title, { format, ...(await sliceUnits(deck, request, window)) });
    }
    if (format === 'xlsx') {
      const sheet = extractXlsx(zip, { sheet: request.sheet, range: request.range });
      if ('error' in sheet) return { error: sheet.error };
      /** @type {DocumentAnswer} */
      const out = { format, sheets: sheet.sheets, sheet: sheet.sheet };
      if (sheet.dimension) out.dimension = sheet.dimension;
      if (request.range !== undefined && request.range !== null && String(request.range).trim()) {
        out.range = String(request.range).trim();
      }
      const sliced = sliceWindow(sheet.text, window, { complete: true });
      if (sliced.error) return sliced;
      if (!sheet.text) out.hint = 'No values in this sheet or range.';
      return withTitle(sheet.title, { ...out, ...sliced });
    }
    const doc = extractDocx(zip);
    const sliced = sliceWindow(doc.text, window, { complete: true });
    if (sliced.error) return sliced;
    /** @type {DocumentAnswer} */
    const out = { format, ...sliced };
    if (!doc.text) out.hint = 'The document contains no text.';
    return withTitle(doc.title, out);
  } catch (error) {
    if (error instanceof ZipFormatError) return { error: `The file cannot be read: ${error.message}` };
    throw error;
  }
}

/**
 * The title goes right after the format, and only when there is one.
 *
 * @param {string|null|undefined} title
 * @param {DocumentAnswer} result
 * @returns {DocumentAnswer}
 */
function withTitle(title, result) {
  if (!title || result.error) return result;
  const { format, ...rest } = result;
  return { format, title, ...rest };
}

module.exports = {
  extractDocumentText,
  detectDocumentFormat,
  parsePageSelection,
  compactRanges,
  DOCUMENT_TEXT_DEFAULT_MAX_CHARS,
  DOCUMENT_TEXT_MAX_CHARS,
};
