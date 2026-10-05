'use strict';

// extract_document_text (#42): format detection, the Office parts, the window.
// PDFs need Electron's runtime for pdf.js and are covered by
// e2e/document-text.test.mjs; here a stand-in plays the PDF.

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const { openZip, ZipFormatError } = require('../src/main/services/zip-reader');
const {
  extractDocumentText,
  detectDocumentFormat,
  parsePageSelection,
  compactRanges,
} = require('../src/main/services/document-text');
const { parseCellRange, formatSerialDate, classifyFormatCode, decodeXml } = require('../src/main/services/office-text');
const { makeZip, makeDocx, makeXlsx, makePptx, p } = require('./helpers/ooxml-fixtures');

const noPdf = { openPdf: () => assert.fail('pdf.js must not be loaded for an Office file') };

async function extract(bytes, request = {}, deps = noPdf) {
  return extractDocumentText(bytes, request, deps);
}

// ── ZIP ─────────────────────────────────────────────────────────────────────

test('zip reader reads stored and deflated entries', () => {
  for (const store of [false, true]) {
    const zip = openZip(makeZip({ 'a.txt': 'alpha', 'dir/b.xml': '﻿<b>beta</b>' }, { store }), {
      maxEntryBytes: 1024,
      maxTotalBytes: 4096,
    });
    assert.deepEqual(zip.names(), ['a.txt', 'dir/b.xml']);
    assert.equal(zip.readText('a.txt'), 'alpha');
    assert.equal(zip.readText('dir/b.xml'), '<b>beta</b>', 'byte order mark is dropped');
    assert.equal(zip.readText('missing.xml'), null);
  }
});

test('zip reader stops an archive that unpacks beyond its limits', () => {
  const bomb = makeZip({ 'huge.xml': 'x'.repeat(200000) });
  assert.ok(bomb.length < 2000, 'small on disk');
  const zip = openZip(bomb, { maxEntryBytes: 100000, maxTotalBytes: 1e9 });
  assert.throws(() => zip.readText('huge.xml'), ZipFormatError);

  // The declared size can lie: the inflate limit holds regardless.
  const lying = Buffer.from(bomb);
  const central = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  lying.writeUInt32LE(10, central + 24);
  assert.throws(() => openZip(lying, { maxEntryBytes: 100000, maxTotalBytes: 1e9 }).readText('huge.xml'), /limit/);

  // And all reads together count against the total.
  const two = openZip(makeZip({ 'a': 'x'.repeat(600), 'b': 'y'.repeat(600) }), { maxEntryBytes: 1000, maxTotalBytes: 1000 });
  two.readText('a');
  assert.throws(() => two.readText('b'), /limit/);
});

test('zip reader refuses what it does not read', () => {
  assert.throws(() => openZip(Buffer.from('not a zip at all, just text'), { maxEntryBytes: 1, maxTotalBytes: 1 }), ZipFormatError);
  const encrypted = makeZip({ 'a.txt': 'secret' });
  const central = encrypted.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  encrypted.writeUInt16LE(1, central + 8);
  assert.throws(() => openZip(encrypted, { maxEntryBytes: 100, maxTotalBytes: 100 }).readText('a.txt'), /Encrypted/);
  const truncated = makeZip({ 'a.txt': 'alpha' }).subarray(0, 40);
  assert.throws(() => openZip(truncated, { maxEntryBytes: 100, maxTotalBytes: 100 }), ZipFormatError);
});

// ── Detection and errors ────────────────────────────────────────────────────

test('the format is told by the first bytes, not by the name', async () => {
  assert.equal(detectDocumentFormat(Buffer.from('%PDF-1.7\n')), 'pdf');
  assert.equal(detectDocumentFormat(Buffer.concat([Buffer.from('junk\n'), Buffer.from('%PDF-1.4')])), 'pdf');
  assert.equal(detectDocumentFormat(makeZip({ a: 'b' })), 'ooxml');
  assert.equal(detectDocumentFormat(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])), 'cfb');
  assert.equal(detectDocumentFormat(Buffer.from('plain text')), null);

  assert.match((await extract(Buffer.from('plain text'))).error, /read_file_text/);
  assert.match((await extract(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]))).error, /password-protected .*\.docx/);
  assert.match((await extract(makeZip({ 'readme.txt': 'hi' }))).error, /not a DOCX, XLSX or PPTX/);
  assert.match((await extract(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]))).error, /cannot be opened/);
});

test('arguments of another format are refused with the one that fits', async () => {
  const docx = makeDocx({ body: p('Text') });
  assert.match((await extract(docx, { pages: '2' })).error, /start_character/);
  assert.match((await extract(docx, { sheet: 'Tabelle1' })).error, /XLSX/);
  const xlsx = makeXlsx({ sheets: [{ name: 'A', rows: [['x']] }] });
  assert.match((await extract(xlsx, { pages: '1' })).error, /sheet and range/);
  assert.match((await extract(makePptx({ slides: [{ texts: ['x'] }] }), { range: 'A1' })).error, /XLSX/);
});

// ── DOCX ────────────────────────────────────────────────────────────────────

test('docx: headings by style name, lists, tables, tabs and breaks', async () => {
  const body = [
    p('Angebot', { style: 'Titel' }),
    p('Einleitung', { style: 'berschrift1' }),
    p('<w:r><w:t>Preis:</w:t><w:tab/><w:t>1 200 &amp; mehr</w:t><w:br/><w:t>zweite Zeile</w:t></w:r>'),
    p('Erster Punkt', { list: true }),
    p('Zweiter Punkt', { list: true }),
    p('Details', { style: 'berschrift2' }),
    p('Gliederungsebene', { style: 'Gliederung' }),
    '<w:tbl><w:tr><w:tc>' + p('Posten') + '</w:tc><w:tc>' + p('Betrag') + '</w:tc></w:tr>' +
      '<w:tr><w:tc>' + p('Lizenz') + p('jährlich') + '</w:tc><w:tc>' + p('900 €') + '</w:tc></w:tr></w:tbl>',
    p(''),
    // Deleted text and field codes are no text; a text box comes once.
    p('<w:del><w:r><w:delText>gestrichen</w:delText></w:r></w:del><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:t>bleibt</w:t></w:r>'),
    p('<w:r><mc:AlternateContent><mc:Choice><w:t>Textfeld</w:t></mc:Choice><mc:Fallback><w:t>Textfeld</w:t></mc:Fallback></mc:AlternateContent></w:r>'),
  ].join('');
  const result = await extract(makeDocx({ body, title: 'Angebot 2026' }));
  assert.equal(result.format, 'docx');
  assert.equal(result.title, 'Angebot 2026');
  assert.equal(result.truncated, false);
  assert.equal(result.content, [
    '# Angebot',
    '',
    '# Einleitung',
    'Preis:\t1 200 & mehr',
    'zweite Zeile',
    '- Erster Punkt',
    '- Zweiter Punkt',
    '',
    '## Details',
    '',
    '### Gliederungsebene',
    'Posten | Betrag',
    'Lizenz jährlich | 900 €',
    'bleibt',
    'Textfeld',
  ].join('\n'));
  assert.equal(result.total_characters, result.content.length);
});

test('docx: an empty document says so instead of answering with nothing', async () => {
  const result = await extract(makeDocx({ body: p(''), styles: null }));
  assert.equal(result.content, '');
  assert.match(result.hint, /no text/);
});

test('docx: the window moves on with next_start_character', async () => {
  const body = Array.from({ length: 400 }, (_, i) => p(`Absatz ${i + 1} mit etwas Text darin.`)).join('');
  const docx = makeDocx({ body });
  const first = await extract(docx, { maxCharacters: 1000 });
  assert.equal(first.truncated, true);
  assert.equal(first.next_start_character, 1000);
  assert.match(first.content, /\[truncated — continue with start_character=1000\]$/);
  assert.ok(first.total_characters > 10000);

  const second = await extract(docx, { startCharacter: 1000, maxCharacters: 1000 });
  assert.equal(second.start_character, 1000);
  const whole = (await extract(docx, { maxCharacters: 100000 })).content;
  assert.equal(second.content.split('\n…')[0], whole.slice(1000, 2000));

  const last = await extract(docx, { startCharacter: first.total_characters - 10 });
  assert.equal(last.truncated, false);
  assert.equal(last.next_start_character, undefined);
  assert.match((await extract(docx, { startCharacter: first.total_characters + 1 })).error, /beyond the end/);

  // max_characters is clamped, never zero and never the whole of a huge file.
  assert.equal((await extract(docx, { maxCharacters: 5 })).next_start_character, 1000);
});

// ── XLSX ────────────────────────────────────────────────────────────────────

const DATE_STYLES =
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/><numFmt numFmtId="165" formatCode="#,##0.00\\ &quot;€&quot;"/></numFmts>' +
  '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="20"/></cellXfs>' +
  '</styleSheet>';

test('xlsx: rows with row numbers and column letters, values of every type', async () => {
  const xlsx = makeXlsx({
    title: 'Budget',
    styles: DATE_STYLES,
    sheets: [
      { name: 'Geheim', state: 'hidden', rows: [['nicht zuerst']] },
      {
        name: 'Übersicht',
        dimension: 'A1:E4',
        rows: [
          ['Posten', 'Datum', 'Betrag', null, 'Notiz'],
          ['Miete', { v: 46300, s: 1 }, { v: 1200.5, s: 3 }, null, 'Tab\tund\nUmbruch'],
          [null, { v: 46301.5, s: 2 }, { v: 'SUM(C2)', t: 'str', f: 'C2' }, null, { inline: 'inline' }],
          [{ v: 1, t: 'b' }, { v: 0.75, s: 4 }, { v: '#DIV/0!', t: 'e' }],
        ],
      },
    ],
  });
  const result = await extract(xlsx);
  assert.equal(result.format, 'xlsx');
  assert.equal(result.title, 'Budget');
  assert.deepEqual(result.sheets, [{ name: 'Geheim', hidden: true }, { name: 'Übersicht' }]);
  assert.equal(result.sheet, 'Übersicht', 'the first visible sheet');
  assert.equal(result.dimension, 'A1:E4');
  assert.equal(result.content, [
    'row\tA\tB\tC\tD\tE',
    '1\tPosten\tDatum\tBetrag\t\tNotiz',
    '2\tMiete\t2026-10-05\t1200.5\t\tTab und ⏎ Umbruch',
    '3\t\t2026-10-06 12:00:00\tSUM(C2)\t\tinline',
    '4\tTRUE\t18:00:00\t#DIV/0!',
  ].join('\n'));
});

test('xlsx: sheet by name, range, the 1904 system and an empty selection', async () => {
  const rows = Array.from({ length: 30 }, (_, r) => Array.from({ length: 6 }, (_, c) => `${'ABCDEF'[c]}${r + 1}`));
  const xlsx = makeXlsx({ sheets: [{ name: 'Daten', rows }, { name: 'Leer', rows: [] }] });

  const ranged = await extract(xlsx, { sheet: 'daten', range: 'B10:C12' });
  assert.equal(ranged.sheet, 'Daten', 'names match case-insensitively as a fallback');
  assert.equal(ranged.range, 'B10:C12');
  assert.equal(ranged.content, 'row\tB\tC\n10\tB10\tC10\n11\tB11\tC11\n12\tB12\tC12');
  assert.equal((await extract(xlsx, { range: 'E:F' })).content.split('\n')[1], '1\tE1\tF1');
  assert.equal((await extract(xlsx, { range: '29:40' })).content.split('\n').length, 3);
  assert.equal((await extract(xlsx, { range: 'D5' })).content, 'row\tD\n5\tD5');

  assert.match((await extract(xlsx, { sheet: 'Fehlt' })).error, /no sheet "Fehlt". Sheets: "Daten", "Leer"/);
  assert.match((await extract(xlsx, { range: 'Z9:A1' })).error, /backwards/);
  assert.match((await extract(xlsx, { range: 'hello' })).error, /not a cell range/);
  assert.match((await extract(xlsx, { sheet: 'Leer' })).hint, /No values/);

  const in1904 = makeXlsx({
    date1904: true,
    styles: DATE_STYLES,
    sheets: [{ name: 'S', rows: [[{ v: 44838, s: 1 }]] }],
  });
  assert.equal((await extract(in1904)).content.split('\n')[1], '1\t2026-10-05');
});

test('xlsx helpers: cell ranges, serial dates, format codes, entities', () => {
  assert.deepEqual(parseCellRange('$A$1:$C$3'), { minCol: 1, minRow: 1, maxCol: 3, maxRow: 3 });
  assert.deepEqual(parseCellRange('B:D'), { minCol: 2, minRow: 1, maxCol: 4, maxRow: Infinity });
  assert.deepEqual(parseCellRange('aa7'), { minCol: 27, minRow: 7, maxCol: 27, maxRow: 7 });
  assert.equal(formatSerialDate(1, 'date', false), '1899-12-31');
  assert.equal(formatSerialDate(61, 'date', false), '1900-03-01');
  assert.equal(formatSerialDate(0.5, 'time', false), '12:00:00');
  assert.equal(classifyFormatCode('dd.mm.yyyy'), 'date');
  assert.equal(classifyFormatCode('[$-407]mmmm yyyy'), 'date');
  assert.equal(classifyFormatCode('mmm'), 'date');
  assert.equal(classifyFormatCode('hh:mm'), 'time');
  assert.equal(classifyFormatCode('#,##0.00 "days"'), null);
  assert.equal(classifyFormatCode('_-* #,##0.00 _€_-'), null);
  assert.equal(classifyFormatCode('[Red]0.0'), null);
  assert.equal(decodeXml('&lt;a&gt; &amp;amp; &#228;&#x1F600; &bogus;'), '<a> &amp; ä😀 &bogus;');
});

// ── PPTX ────────────────────────────────────────────────────────────────────

test('pptx: slides in presentation order, with speaker notes, and pages picks them', async () => {
  const pptx = makePptx({
    title: 'Roadmap',
    slides: [
      { texts: ['Roadmap 2027', 'Konrad'] },
      { texts: ['Q1', 'Dokumente lesen'], notes: ['Hier die Demo zeigen.'] },
      { texts: [] },
    ],
  });
  const all = await extract(pptx);
  assert.equal(all.format, 'pptx');
  assert.equal(all.title, 'Roadmap');
  assert.equal(all.slide_count, 3);
  assert.equal(all.slides, '1-3');
  assert.equal(all.content, [
    '[Slide 1]', 'Roadmap 2027', 'Konrad', '',
    '[Slide 2]', 'Q1', 'Dokumente lesen', 'Notes: Hier die Demo zeigen.', '',
    '[Slide 3]', '(no text)',
  ].join('\n'));
  const second = await extract(pptx, { pages: '2' });
  assert.equal(second.slides, '2');
  assert.match(second.content, /^\[Slide 2\]/);
  assert.match((await extract(pptx, { pages: '4' })).error, /3 slides/);
});

// ── Pages and the window over them ──────────────────────────────────────────

test('page selections', () => {
  assert.deepEqual(parsePageSelection('3', 10, 'Page').numbers, [3]);
  assert.deepEqual(parsePageSelection(' 1-3, 8,7 ', 10, 'Page').numbers, [1, 2, 3, 7, 8]);
  assert.deepEqual(parsePageSelection('9-', 10, 'Page').numbers, [9, 10]);
  assert.deepEqual(parsePageSelection('8-40', 10, 'Page').numbers, [8, 9, 10], 'the end is clamped');
  assert.match(parsePageSelection('11', 10, 'Page').error, /10 pages/);
  assert.match(parsePageSelection('0', 10, 'Page').error, /start at 1/);
  assert.match(parsePageSelection('5-2', 10, 'Page').error, /forwards/);
  assert.match(parsePageSelection('first', 10, 'Page').error, /not a selection/);
  assert.match(parsePageSelection('1-', 5000, 'Page').error, /more than 2000/);
  assert.equal(compactRanges([1, 2, 3, 7, 9, 10]), '1-3,7,9-10');
});

/** A PDF stand-in: `pages` texts, counting which pages were read. */
function fakePdf(pages, { title = null } = {}) {
  const read = [];
  let closed = false;
  return {
    read,
    get closed() {
      return closed;
    },
    deps: {
      openPdf: async (data) => {
        assert.ok(data instanceof Uint8Array);
        return {
          format: 'pdf',
          title,
          unitCount: pages.length,
          readUnit: async (n) => {
            read.push(n);
            return pages[n - 1];
          },
          close: async () => {
            closed = true;
          },
        };
      },
    },
  };
}

const PDF_BYTES = Buffer.from('%PDF-1.7\n');

test('pdf: pages are read only until the window is full', async () => {
  const pdf = fakePdf(Array.from({ length: 300 }, (_, i) => `Seite ${i + 1} `.repeat(40)), { title: 'Handbuch' });
  const result = await extract(PDF_BYTES, { maxCharacters: 1000 }, pdf.deps);
  assert.equal(result.format, 'pdf');
  assert.equal(result.title, 'Handbuch');
  assert.equal(result.page_count, 300);
  // About 330 characters a page: page 4 starts at 996, inside the window.
  assert.equal(result.pages, '1-4');
  assert.equal(result.truncated, true);
  assert.equal(result.total_characters, undefined, 'unknown without reading every page');
  assert.deepEqual(pdf.read, [1, 2, 3, 4]);
  assert.equal(pdf.closed, true);
});

test('pdf: a selection, the end of it, and pages without text', async () => {
  const pdf = fakePdf(['Eins', '', 'Drei', '']);
  const picked = await extract(PDF_BYTES, { pages: '3-' }, pdf.deps);
  assert.equal(picked.content, '[Page 3]\nDrei\n\n[Page 4]\n(no text)');
  assert.equal(picked.pages, '3-4');
  assert.equal(picked.truncated, false);
  assert.equal(picked.hint, undefined);

  const scanned = await extract(PDF_BYTES, { pages: '2,4' }, fakePdf(['Eins', '', 'Drei', '']).deps);
  assert.match(scanned.hint, /scanned images/);
  assert.match((await extract(PDF_BYTES, { pages: '5' }, fakePdf(['a']).deps)).error, /1 page\b/);
});
