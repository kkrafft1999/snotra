'use strict';

/**
 * Office documents for extract_document_text (#42), written part by part: no
 * generator library, so a fixture holds exactly the XML the test is about —
 * and the ZIP around it is the plain kind every Office application writes.
 *
 *   makeZip(entries, { store })   entries: { 'path': string | Buffer }
 *   makeDocx({ body, styles })    body: the inside of <w:body>
 *   makeXlsx({ sheets, sharedStrings, styles, date1904 })
 *   makePptx({ slides })          slides: [{ texts: [...], notes: [...] }]
 */

const zlib = require('zlib');

function makeZip(entries, { store = false } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const packed = store ? data : zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function coreXml(title) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    `xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${title}</dc:title></cp:coreProperties>`;
}

/** A German Word names its heading styles "berschrift1"; only the style name says "heading 1". */
const GERMAN_HEADING_STYLES =
  `<w:styles ${W}>` +
  '<w:style w:type="paragraph" w:styleId="berschrift1"><w:name w:val="heading 1"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Titel"><w:name w:val="Title"/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Gliederung"><w:name w:val="Outline"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr></w:style>' +
  '</w:styles>';

function makeDocx({ body, styles = GERMAN_HEADING_STYLES, title } = {}) {
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document ${W} ` +
      'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">' +
      `<w:body>${body}</w:body></w:document>`,
  };
  if (styles) entries['word/styles.xml'] = styles;
  if (title) entries['docProps/core.xml'] = coreXml(title);
  return makeZip(entries);
}

/** One paragraph; `style` is a style id, `runs` plain text or ready XML. */
function p(text, { style, list = false } = {}) {
  const props = style || list
    ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${list ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : ''}</w:pPr>`
    : '';
  const runs = text.startsWith('<') ? text : `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
  return `<w:p>${props}${runs}</w:p>`;
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/**
 * sheets: [{ name, state?, rows: [[cell, …], …], dimension? }]. A cell is a
 * string (shared string), a number, `{ v, t, s }` raw, or null.
 */
function makeXlsx({ sheets, styles, date1904 = false, title } = {}) {
  const shared = [];
  const sharedIndex = (text) => {
    let at = shared.indexOf(text);
    if (at < 0) at = shared.push(text) - 1;
    return at;
  };
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  };
  const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const sheetEntries = [];
  const rels = [];
  sheets.forEach((sheet, i) => {
    const rows = sheet.rows.map((cells, r) => {
      const xml = cells.map((cell, c) => {
        if (cell === null || cell === undefined) return '';
        const ref = `${columnName(c)}${r + 1}`;
        if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
        if (typeof cell === 'string') return `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`;
        if (cell.inline !== undefined) return `<c r="${ref}" t="inlineStr"><is><t>${cell.inline}</t></is></c>`;
        return `<c r="${ref}"${cell.t ? ` t="${cell.t}"` : ''}${cell.s !== undefined ? ` s="${cell.s}"` : ''}>` +
          `${cell.f ? `<f>${cell.f}</f>` : ''}<v>${cell.v}</v></c>`;
      }).join('');
      return `<row r="${r + 1}">${xml}</row>`;
    }).join('');
    const dimension = sheet.dimension ? `<dimension ref="${sheet.dimension}"/>` : '';
    entries[`xl/worksheets/sheet${i + 1}.xml`] =
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${dimension}<sheetData>${rows}</sheetData></worksheet>`;
    sheetEntries.push(`<sheet name="${sheet.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${sheet.state ? ` state="${sheet.state}"` : ''}/>`);
    rels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  });
  rels.push(`<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`);
  entries['xl/workbook.xml'] = `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${R}>` +
    `${date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheetEntries.join('')}</sheets></workbook>`;
  entries['xl/_rels/workbook.xml.rels'] =
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
  entries['xl/sharedStrings.xml'] = `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    shared.map((text) => `<si><t xml:space="preserve">${text}</t></si>`).join('') + '</sst>';
  if (styles) entries['xl/styles.xml'] = styles;
  if (title) entries['docProps/core.xml'] = coreXml(title);
  return makeZip(entries);
}

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function drawing(texts) {
  return texts.map((text) => `<p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`).join('');
}

/** slides: [{ texts, notes }], in presentation order — written to the archive in reverse, so order comes from presentation.xml. */
function makePptx({ slides, title } = {}) {
  const entries = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  };
  const ids = [];
  const rels = [];
  slides.forEach((slide, i) => {
    const n = slides.length - i;
    ids.push(`<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`);
    rels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`);
    entries[`ppt/slides/slide${n}.xml`] = `<p:sld ${P} ${A}><p:cSld><p:spTree>${drawing(slide.texts)}</p:spTree></p:cSld></p:sld>`;
    if (slide.notes) {
      entries[`ppt/slides/_rels/slide${n}.xml.rels`] =
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`;
      entries[`ppt/notesSlides/notesSlide${n}.xml`] =
        `<p:notes ${P} ${A}><p:cSld><p:spTree>${drawing([...slide.notes, String(n)])}</p:spTree></p:cSld></p:notes>`;
    }
  });
  entries['ppt/presentation.xml'] = `<p:presentation ${P} ${R}><p:sldIdLst>${ids.join('')}</p:sldIdLst></p:presentation>`;
  entries['ppt/_rels/presentation.xml.rels'] =
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`;
  if (title) entries['docProps/core.xml'] = coreXml(title);
  return makeZip(entries);
}

module.exports = { makeZip, makeDocx, makeXlsx, makePptx, p, GERMAN_HEADING_STYLES };
