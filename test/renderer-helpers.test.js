// The small helpers in src/renderer/utils/helpers.js (issue #376).
//
// formatSize used to know only B–GB: one terabyte printed "1.0 undefined", and
// input below one byte printed "512.0 undefined". Its main-process twin,
// src/shared/runtime/format-bytes.js, is held to the same output here.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');
const { formatBytes } = require('../src/shared/runtime/format-bytes.js');

const load = async () => {
  const helpers = await importRenderer('utils', 'helpers.js');
  const { setLocale } = await importRenderer('i18n.js');
  return { ...helpers, setLocale };
};

test('getExtension takes the part after the last dot, lower-cased', async () => {
  const { getExtension } = await load();
  assert.equal(getExtension('app.js'), 'js');
  assert.equal(getExtension('Photo.JPG'), 'jpg');
  assert.equal(getExtension('archive.tar.gz'), 'gz');
  assert.equal(getExtension('trailing.'), '');
});

test('getExtension treats a leading dot and a missing dot as no extension', async () => {
  const { getExtension } = await load();
  assert.equal(getExtension('.env'), '');
  assert.equal(getExtension('.gitignore'), '');
  assert.equal(getExtension('Makefile'), '');
  assert.equal(getExtension(''), '');
});

test('isTextFile knows text extensions and rejects binaries', async () => {
  const { isTextFile } = await load();
  for (const name of ['README.md', 'index.TS', 'config.yaml', 'data.csv', 'icon.svg', 'x.env']) {
    assert.equal(isTextFile(name), true, name);
  }
  for (const name of ['photo.png', 'app.exe', 'archive.tar.gz', 'doc.pdf']) {
    assert.equal(isTextFile(name), false, name);
  }
});

test('isTextFile recognises well-known files without an extension', async () => {
  const { isTextFile } = await load();
  for (const name of ['Makefile', 'Dockerfile', 'README', 'LICENSE', 'CHANGELOG']) {
    assert.equal(isTextFile(name), true, name);
  }
  assert.equal(isTextFile('.env'), false);
  assert.equal(isTextFile('binary'), false);
});

test('formatSize steps through B, KB, MB, GB and TB', async () => {
  const { formatSize, setLocale } = await load();
  setLocale('en');
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(1), '1 B');
  assert.equal(formatSize(1023), '1023 B');
  assert.equal(formatSize(1024), '1.0 KB');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(1024 ** 2), '1.0 MB');
  assert.equal(formatSize(2.5 * 1024 ** 3), '2.5 GB');
  assert.equal(formatSize(1024 ** 4), '1.0 TB');
});

test('formatSize stays at TB beyond it', async () => {
  const { formatSize, setLocale } = await load();
  setLocale('en');
  assert.equal(formatSize(1024 ** 5), '1024.0 TB');
});

test('formatSize uses the decimal separator of the active language', async () => {
  const { formatSize, setLocale } = await load();
  setLocale('de');
  assert.equal(formatSize(1536), '1,5 KB');
  assert.equal(formatSize(1024 ** 4), '1,0 TB');
  assert.equal(formatSize(512), '512 B');
  setLocale('en');
  assert.equal(formatSize(1536), '1.5 KB');
});

test('formatSize never prints undefined or NaN for odd input', async () => {
  const { formatSize, setLocale } = await load();
  setLocale('en');
  const odd = [-1, -1024, 0.5, 0.4, NaN, Infinity, -Infinity, undefined, null, '1024', {}];
  for (const input of odd) {
    const out = formatSize(input);
    assert.doesNotMatch(out, /undefined|NaN/, `formatSize(${String(input)}) → ${out}`);
    assert.match(out, /^\d+(\.\d)? (B|KB|MB|GB|TB)$/, `formatSize(${String(input)}) → ${out}`);
  }
  assert.equal(formatSize(-1), '0 B');
  assert.equal(formatSize(NaN), '0 B');
  assert.equal(formatSize(Infinity), '0 B');
  assert.equal(formatSize(0.5), '1 B');
});

test('formatSize and the main-process formatBytes agree', async () => {
  const { formatSize, setLocale } = await load();
  const inputs = [0, 0.5, 1, 1023, 1024, 1536, 1024 ** 2, 1024 ** 3, 1024 ** 4, 1024 ** 5, -5, NaN];
  for (const locale of ['en', 'de']) {
    setLocale(locale);
    for (const bytes of inputs) {
      assert.equal(formatSize(bytes), formatBytes(bytes, locale), `${locale}: ${bytes}`);
    }
  }
});

test('formatTimestamp writes date and time per language', async () => {
  const { formatTimestamp, setLocale } = await load();
  const moment = new Date(2026, 8, 1, 4, 5);
  setLocale('en');
  assert.equal(formatTimestamp(moment), '2026-09-01, 04:05');
  assert.equal(formatTimestamp(moment.getTime()), '2026-09-01, 04:05');
  setLocale('de');
  assert.equal(formatTimestamp(moment), '01.09.2026, 04:05');
  assert.equal(formatTimestamp(new Date(2026, 11, 31, 23, 59)), '31.12.2026, 23:59');
});

test('formatTimestamp calls an unusable value unknown', async () => {
  const { formatTimestamp, setLocale } = await load();
  setLocale('en');
  for (const input of [0, -1, NaN, 'not a date', new Date('invalid')]) {
    assert.equal(formatTimestamp(input), 'unknown', String(input));
  }
  setLocale('de');
  assert.equal(formatTimestamp(0), 'unbekannt');
});

test('dismissOnOutsideClick closes on an outside click only while open', async (t) => {
  const dom = setupRendererDom({ markup: '<div id="menu"><button id="inside"></button></div><p id="outside"></p>' });
  t.after(dom.cleanup);
  const { dismissOnOutsideClick } = await load();

  let open = true;
  let dismissed = 0;
  const menu = dom.document.getElementById('menu');
  dismissOnOutsideClick({
    isOpen: () => open,
    ownsTarget: (target) => menu.contains(target),
    onDismiss: () => { dismissed += 1; },
  });

  dom.document.getElementById('inside').click();
  assert.equal(dismissed, 0, 'a click inside keeps it open');

  dom.document.getElementById('outside').click();
  assert.equal(dismissed, 1, 'a click outside dismisses');

  open = false;
  dom.document.getElementById('outside').click();
  assert.equal(dismissed, 1, 'nothing happens while closed');
});
