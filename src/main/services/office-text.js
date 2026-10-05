'use strict';

/**
 * Text out of DOCX, XLSX and PPTX (#42), straight from their XML parts.
 *
 * Nothing here renders: the aim is the text a model needs, in as few tokens
 * as the content allows. So a Word document comes back as paragraphs with its
 * headings marked the Markdown way, a workbook as tab-separated rows with their
 * cell addresses, a presentation slide by slide with its speaker notes.
 *
 * The XML is scanned with one tokenizer rather than parsed into a tree — an
 * Office part can run to tens of megabytes, and the text needs a single pass.
 */

const { posix: path } = require('path');

const ENTITY = /&(?:#(\d+)|#x([0-9a-fA-F]+)|(lt|gt|amp|quot|apos));/g;
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXml(text) {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (match, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name];
    const code = dec ? Number(dec) : parseInt(hex, 16);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

// Tag, comment, processing instruction, CDATA, doctype — or a run of text.
const TOKEN =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|([^<]+)/g;

/**
 * Walks `xml` once. `open(name, attrs, selfClosing)`, `close(name)` and
 * `text(decoded)` are called in document order; a self-closing element only
 * gets `open`.
 */
function scanXml(xml, { open, close, text }) {
  TOKEN.lastIndex = 0;
  let match;
  while ((match = TOKEN.exec(xml)) !== null) {
    const [, slash, name, attrs, selfClose, cdata, chars] = match;
    if (name) {
      if (slash) close?.(name);
      else open?.(name, attrs, selfClose === '/');
    } else if (chars !== undefined) {
      text?.(decodeXml(chars));
    } else if (cdata !== undefined) {
      text?.(cdata);
    }
  }
}

/** The value of one attribute in the raw attribute text of a tag. */
function attr(attrs, name) {
  const match = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, '\\$&')}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs || '');
  return match ? decodeXml(match[1] ?? match[2]) : null;
}

/** Relationship id → part path, for the `_rels` file of `partPath`. */
function readRelationships(zip, partPath) {
  const relsPath = path.join(path.dirname(partPath), '_rels', `${path.basename(partPath)}.rels`);
  const xml = zip.readText(relsPath);
  const targets = new Map();
  if (!xml) return targets;
  scanXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship' || attr(attrs, 'TargetMode') === 'External') return;
      const id = attr(attrs, 'Id');
      const target = attr(attrs, 'Target');
      if (!id || !target) return;
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : path.normalize(path.join(path.dirname(partPath), target));
      targets.set(id, { target: resolved, type: attr(attrs, 'Type') || '' });
    },
  });
  return targets;
}

/** `dc:title` from the document properties, when the author set one. */
function readCoreTitle(zip) {
  const xml = zip.readText('docProps/core.xml');
  if (!xml) return null;
  let inTitle = false;
  let title = '';
  scanXml(xml, {
    open(name, _attrs, selfClosing) {
      if (name === 'dc:title' && !selfClosing) inTitle = true;
    },
    close(name) {
      if (name === 'dc:title') inTitle = false;
    },
    text(chars) {
      if (inTitle) title += chars;
    },
  });
  return title.trim() || null;
}

/**
 * `mc:AlternateContent` carries the same text twice — once for new readers,
 * once as a fallback for old ones. Only the first counts.
 */
function createFallbackGuard() {
  let depth = 0;
  return {
    open(name, selfClosing) {
      if (name === 'mc:Fallback' && !selfClosing) depth += 1;
    },
    close(name) {
      if (name === 'mc:Fallback' && depth > 0) depth -= 1;
    },
    get skipping() {
      return depth > 0;
    },
  };
}

// ── DOCX ────────────────────────────────────────────────────────────────────

/**
 * Style id → heading level. The ids are localised (a German Word writes
 * "berschrift1"), the names of the built-in styles are not ("heading 1").
 */
function readHeadingStyles(zip) {
  const levels = new Map();
  const xml = zip.readText('word/styles.xml');
  if (!xml) return levels;
  let styleId = null;
  scanXml(xml, {
    open(name, attrs, selfClosing) {
      if (name === 'w:style') {
        styleId = selfClosing ? null : attr(attrs, 'w:styleId');
      } else if (styleId && name === 'w:name') {
        const styleName = (attr(attrs, 'w:val') || '').toLowerCase();
        const heading = /^heading\s*([1-9])$/.exec(styleName);
        if (heading) levels.set(styleId, Number(heading[1]));
        else if (styleName === 'title') levels.set(styleId, 1);
      } else if (styleId && name === 'w:outlineLvl' && !levels.has(styleId)) {
        const level = Number(attr(attrs, 'w:val'));
        if (Number.isInteger(level) && level >= 0 && level < 9) levels.set(styleId, level + 1);
      }
    },
    close(name) {
      if (name === 'w:style') styleId = null;
    },
  });
  return levels;
}

function extractDocx(zip) {
  const xml = zip.readText('word/document.xml');
  if (xml === null) throw new Error('The document has no main part (word/document.xml).');
  const headingStyles = readHeadingStyles(zip);
  const fallback = createFallbackGuard();
  const blocks = [];
  let paragraph = null;
  let inText = false;
  let tableDepth = 0;
  let row = null;
  let cell = null;
  let tableRows = null;

  function finishParagraph() {
    const text = paragraph.text.replace(/[ \t]+$/gm, '').trim();
    const { level, list } = paragraph;
    paragraph = null;
    if (!text) return;
    if (cell !== null) {
      cell.push(text.replace(/\s*\n\s*/g, ' '));
      return;
    }
    if (level) blocks.push(`\n${'#'.repeat(Math.min(level, 6))} ${text}`);
    else blocks.push(list ? `- ${text}` : text);
  }

  scanXml(xml, {
    open(name, attrs, selfClosing) {
      fallback.open(name, selfClosing);
      if (fallback.skipping) return;
      switch (name) {
        case 'w:p':
          if (!selfClosing && !paragraph) paragraph = { text: '', level: 0, list: false };
          break;
        case 'w:pStyle':
          if (paragraph) paragraph.level = headingStyles.get(attr(attrs, 'w:val')) || paragraph.level;
          break;
        case 'w:outlineLvl': {
          const level = Number(attr(attrs, 'w:val'));
          if (paragraph && Number.isInteger(level) && level >= 0 && level < 9) paragraph.level = level + 1;
          break;
        }
        case 'w:numPr':
          if (paragraph) paragraph.list = true;
          break;
        case 'w:t':
          inText = !selfClosing;
          break;
        case 'w:tab':
          if (paragraph && !attrs.includes('w:val')) paragraph.text += '\t';
          break;
        case 'w:br':
        case 'w:cr':
          if (paragraph) paragraph.text += '\n';
          break;
        case 'w:noBreakHyphen':
          if (paragraph) paragraph.text += '-';
          break;
        case 'w:tbl':
          if (!selfClosing) {
            tableDepth += 1;
            if (tableDepth === 1) tableRows = [];
          }
          break;
        case 'w:tr':
          if (tableDepth === 1 && !selfClosing) row = [];
          break;
        case 'w:tc':
          if (tableDepth === 1 && !selfClosing) cell = [];
          break;
        default:
      }
    },
    close(name) {
      const wasSkipping = fallback.skipping;
      fallback.close(name);
      if (wasSkipping) return;
      switch (name) {
        case 'w:t':
          inText = false;
          break;
        case 'w:p':
          if (paragraph) finishParagraph();
          break;
        case 'w:tc':
          if (tableDepth === 1 && cell !== null && row !== null) {
            row.push(cell.join(' '));
            cell = null;
          }
          break;
        case 'w:tr':
          if (tableDepth === 1 && row !== null) {
            if (row.some(Boolean)) tableRows.push(row.join(' | '));
            row = null;
          }
          break;
        case 'w:tbl':
          if (tableDepth === 1 && tableRows?.length) blocks.push(tableRows.join('\n'));
          if (tableDepth === 1) tableRows = null;
          tableDepth = Math.max(0, tableDepth - 1);
          break;
        default:
      }
    },
    text(chars) {
      if (inText && paragraph && !fallback.skipping) paragraph.text += chars;
    },
  });

  return {
    format: 'docx',
    title: readCoreTitle(zip),
    text: blocks.join('\n').replace(/^\n+/, ''),
  };
}

// ── XLSX ────────────────────────────────────────────────────────────────────

function columnToNumber(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function numberToColumn(n) {
  let letters = '';
  for (let rest = n; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/**
 * "A1:F200", "B:D", "5:40", "C7" — the parts left out are open. Returns
 * `{ minCol, maxCol, minRow, maxRow }` or `{ error }`.
 */
function parseCellRange(raw) {
  const text = String(raw).trim().toUpperCase().replace(/\$/g, '');
  const match = /^([A-Z]{1,3})?(\d{1,7})?(?::([A-Z]{1,3})?(\d{1,7})?)?$/.exec(text);
  if (!text || !match || (!match[1] && !match[2])) {
    return { error: `range "${raw}" is not a cell range like "A1:F200", "B:D" or "5:40".` };
  }
  const [, c1, r1, c2, r2] = match;
  const single = !text.includes(':');
  const bounds = {
    minCol: c1 ? columnToNumber(c1) : 1,
    minRow: r1 ? Number(r1) : 1,
    maxCol: single ? (c1 ? columnToNumber(c1) : Infinity) : (c2 ? columnToNumber(c2) : Infinity),
    maxRow: single ? (r1 ? Number(r1) : Infinity) : (r2 ? Number(r2) : Infinity),
  };
  if (bounds.minCol > bounds.maxCol || bounds.minRow > bounds.maxRow) {
    return { error: `range "${raw}" runs backwards; write the top-left cell first.` };
  }
  return bounds;
}

/** Built-in number formats that show a date or a time (ECMA-376, 18.8.30). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
const BUILTIN_TIME_ONLY = new Set([18, 19, 20, 21, 45, 46, 47]);

/**
 * Is a custom format code a date or a time? Quoted text, escaped characters,
 * `[colours]`/`[$-407]` and the `_x`/`*x` padding do not count. An `m` alone
 * is a month ("mmm yyyy"); next to `h` or `s` it is a minute.
 */
function classifyFormatCode(code) {
  const bare = code.replace(/"[^"]*"|\\.|[_*].|\[[^\]]*\]/g, '').toLowerCase();
  if (/[dy]/.test(bare)) return 'date';
  if (/[hs]/.test(bare)) return 'time';
  if (/m/.test(bare)) return 'date';
  return null;
}

/** Style index (the `s` of a cell) → 'date' | 'time' | null. */
function readDateStyles(zip) {
  const xml = zip.readText('xl/styles.xml');
  const kinds = [];
  if (!xml) return kinds;
  const custom = new Map();
  let inCellXfs = false;
  scanXml(xml, {
    open(name, attrs, selfClosing) {
      if (name === 'numFmt') {
        custom.set(Number(attr(attrs, 'numFmtId')), classifyFormatCode(attr(attrs, 'formatCode') || ''));
      } else if (name === 'cellXfs' && !selfClosing) {
        inCellXfs = true;
      } else if (inCellXfs && name === 'xf') {
        const id = Number(attr(attrs, 'numFmtId') || 0);
        let kind = custom.has(id) ? custom.get(id) : null;
        if (!custom.has(id) && BUILTIN_DATE_FORMATS.has(id)) kind = BUILTIN_TIME_ONLY.has(id) ? 'time' : 'date';
        kinds.push(kind);
      }
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
  return kinds;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** An Excel serial number as ISO 8601, in the 1900 or the 1904 date system. */
function formatSerialDate(serial, kind, date1904) {
  if (!Number.isFinite(serial)) return null;
  const ms = Math.round(serial * 86400000);
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const date = new Date(epoch + ms);
  if (Number.isNaN(date.getTime())) return null;
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  if (kind === 'time') return time;
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  return ms % 86400000 === 0 ? day : `${day} ${time}`;
}

function readSharedStrings(zip, target) {
  const xml = target ? zip.readText(target) : zip.readText('xl/sharedStrings.xml');
  const strings = [];
  if (!xml) return strings;
  let current = null;
  let inText = false;
  let phonetic = 0;
  scanXml(xml, {
    open(name, _attrs, selfClosing) {
      if (name === 'si') current = selfClosing ? (strings.push(''), null) : '';
      else if (name === 'rPh' && !selfClosing) phonetic += 1;
      else if (name === 't' && !selfClosing && current !== null && phonetic === 0) inText = true;
    },
    close(name) {
      if (name === 't') inText = false;
      else if (name === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (name === 'si' && current !== null) {
        strings.push(current);
        current = null;
      }
    },
    text(chars) {
      if (inText) current += chars;
    },
  });
  return strings;
}

/** One cell value on one line: tabs and line breaks would break the row. */
function flattenCell(value) {
  return value.replace(/\r\n?|\n/g, ' ⏎ ').replace(/\t/g, ' ');
}

function readWorkbook(zip) {
  const xml = zip.readText('xl/workbook.xml');
  if (xml === null) throw new Error('The workbook has no main part (xl/workbook.xml).');
  const sheets = [];
  let date1904 = false;
  scanXml(xml, {
    open(name, attrs) {
      if (name === 'sheet') {
        sheets.push({ name: attr(attrs, 'name') || '', relId: attr(attrs, 'r:id'), state: attr(attrs, 'state') || 'visible' });
      } else if (name === 'workbookPr') {
        const value = attr(attrs, 'date1904');
        date1904 = value === '1' || value === 'true';
      }
    },
  });
  const rels = readRelationships(zip, 'xl/workbook.xml');
  for (const sheet of sheets) sheet.part = rels.get(sheet.relId)?.target || null;
  const sharedStringsRel = [...rels.values()].find((rel) => rel.type.endsWith('/sharedStrings'));
  return { sheets, date1904, sharedStringsPart: sharedStringsRel?.target || null };
}

/**
 * The workbook's sheet list, and the text of one sheet within `range`.
 * `sheetName` defaults to the first visible sheet.
 */
function extractXlsx(zip, { sheet: sheetName, range } = {}) {
  const workbook = readWorkbook(zip);
  const sheets = workbook.sheets.filter((entry) => entry.part);
  if (!sheets.length) throw new Error('The workbook contains no worksheets.');
  const listing = sheets.map((entry) => (entry.state === 'visible' ? { name: entry.name } : { name: entry.name, hidden: true }));

  let chosen;
  if (typeof sheetName === 'string' && sheetName.trim()) {
    const wanted = sheetName.trim();
    chosen = sheets.find((entry) => entry.name === wanted)
      || sheets.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
    if (!chosen) {
      return { error: `There is no sheet "${wanted}". Sheets: ${sheets.map((entry) => `"${entry.name}"`).join(', ')}.` };
    }
  } else {
    chosen = sheets.find((entry) => entry.state === 'visible') || sheets[0];
  }

  let bounds = { minCol: 1, maxCol: Infinity, minRow: 1, maxRow: Infinity };
  if (range !== undefined && range !== null && String(range).trim()) {
    bounds = parseCellRange(range);
    if (bounds.error) return { error: bounds.error };
  }

  const xml = zip.readText(chosen.part);
  if (xml === null) throw new Error(`The part of sheet "${chosen.name}" is missing.`);
  const shared = readSharedStrings(zip, workbook.sharedStringsPart);
  const dateStyles = readDateStyles(zip);

  let dimension = null;
  const rows = new Map();
  let usedMinCol = Infinity;
  let usedMaxCol = 0;
  let cell = null;
  let rowNumber = 0;
  let inValue = false;
  let inInline = false;
  let inInlineText = false;
  let column = 0;

  scanXml(xml, {
    open(name, attrs, selfClosing) {
      if (name === 'dimension') {
        dimension = attr(attrs, 'ref');
      } else if (name === 'row') {
        rowNumber = Number(attr(attrs, 'r')) || rowNumber + 1;
        column = 0;
      } else if (name === 'c') {
        const ref = attr(attrs, 'r');
        const match = ref ? /^([A-Z]+)(\d+)$/.exec(ref) : null;
        column = match ? columnToNumber(match[1]) : column + 1;
        if (match) rowNumber = Number(match[2]);
        cell = selfClosing ? null : { type: attr(attrs, 't') || 'n', style: Number(attr(attrs, 's') || 0), value: '', inline: '' };
      } else if (cell && name === 'v' && !selfClosing) {
        inValue = true;
      } else if (cell && name === 'is' && !selfClosing) {
        inInline = true;
      } else if (inInline && name === 't' && !selfClosing) {
        inInlineText = true;
      }
    },
    close(name) {
      if (name === 'v') inValue = false;
      else if (name === 't') inInlineText = false;
      else if (name === 'is') inInline = false;
      else if (name === 'c' && cell) {
        const inRange = column >= bounds.minCol && column <= bounds.maxCol
          && rowNumber >= bounds.minRow && rowNumber <= bounds.maxRow;
        const value = inRange ? cellText(cell) : '';
        if (value !== '') {
          if (!rows.has(rowNumber)) rows.set(rowNumber, new Map());
          rows.get(rowNumber).set(column, flattenCell(value));
          usedMinCol = Math.min(usedMinCol, column);
          usedMaxCol = Math.max(usedMaxCol, column);
        }
        cell = null;
      }
    },
    text(chars) {
      if (inValue) cell.value += chars;
      else if (inInlineText) cell.inline += chars;
    },
  });

  function cellText({ type, style, value, inline }) {
    switch (type) {
      case 's': {
        const index = Number(value);
        return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : '';
      }
      case 'inlineStr':
        return inline;
      case 'b':
        return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : value;
      case 'str':
      case 'e':
        return value;
      default: {
        const kind = dateStyles[style];
        if (kind && value !== '') return formatSerialDate(Number(value), kind, workbook.date1904) ?? value;
        return value;
      }
    }
  }

  const lines = [];
  if (rows.size) {
    const columns = [];
    for (let col = usedMinCol; col <= usedMaxCol; col += 1) columns.push(col);
    lines.push(['row', ...columns.map(numberToColumn)].join('\t'));
    for (const number of [...rows.keys()].sort((a, b) => a - b)) {
      const cells = rows.get(number);
      lines.push([String(number), ...columns.map((col) => cells.get(col) ?? '')].join('\t').replace(/\t+$/, ''));
    }
  }

  const result = {
    format: 'xlsx',
    title: readCoreTitle(zip),
    sheets: listing,
    sheet: chosen.name,
    text: lines.join('\n'),
  };
  if (dimension) result.dimension = dimension;
  return result;
}

// ── PPTX ────────────────────────────────────────────────────────────────────

/** The paragraphs of one DrawingML part (a slide or its notes). */
function drawingParagraphs(xml) {
  const paragraphs = [];
  const fallback = createFallbackGuard();
  let current = null;
  let inText = false;
  scanXml(xml, {
    open(name, _attrs, selfClosing) {
      fallback.open(name, selfClosing);
      if (fallback.skipping) return;
      if (name === 'a:p' && !selfClosing) current = '';
      else if (name === 'a:t' && !selfClosing) inText = true;
      else if (name === 'a:br' && current !== null) current += '\n';
    },
    close(name) {
      const wasSkipping = fallback.skipping;
      fallback.close(name);
      if (wasSkipping) return;
      if (name === 'a:t') inText = false;
      else if (name === 'a:p' && current !== null) {
        const text = current.trim();
        if (text) paragraphs.push(text);
        current = null;
      }
    },
    text(chars) {
      if (inText && current !== null && !fallback.skipping) current += chars;
    },
  });
  return paragraphs;
}

/** The slides in presentation order, each readable on demand. */
function extractPptx(zip) {
  const xml = zip.readText('ppt/presentation.xml');
  if (xml === null) throw new Error('The presentation has no main part (ppt/presentation.xml).');
  const ids = [];
  scanXml(xml, {
    open(name, attrs) {
      if (name === 'p:sldId') ids.push(attr(attrs, 'r:id'));
    },
  });
  const rels = readRelationships(zip, 'ppt/presentation.xml');
  const parts = ids.map((id) => rels.get(id)?.target).filter((target) => target && zip.has(target));

  function readSlide(number) {
    const part = parts[number - 1];
    const body = drawingParagraphs(zip.readText(part) || '');
    const notesRel = [...readRelationships(zip, part).values()].find((rel) => rel.type.endsWith('/notesSlide'));
    // A notes page repeats the slide number in a placeholder; one bare number is no note.
    const notes = notesRel ? drawingParagraphs(zip.readText(notesRel.target) || '').filter((p) => !/^\d+$/.test(p)) : [];
    const lines = [...body];
    if (notes.length) lines.push(`Notes: ${notes.join('\n')}`);
    return lines.join('\n');
  }

  return {
    format: 'pptx',
    title: readCoreTitle(zip),
    unitCount: parts.length,
    readUnit: async (number) => readSlide(number),
  };
}

/** Which Office format an opened archive is, from the parts it contains. */
function detectOfficeFormat(zip) {
  if (zip.has('word/document.xml')) return 'docx';
  if (zip.has('xl/workbook.xml')) return 'xlsx';
  if (zip.has('ppt/presentation.xml')) return 'pptx';
  return null;
}

module.exports = {
  detectOfficeFormat,
  extractDocx,
  extractXlsx,
  extractPptx,
  parseCellRange,
  formatSerialDate,
  classifyFormatCode,
  scanXml,
  decodeXml,
};
