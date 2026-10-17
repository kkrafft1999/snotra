// The small helpers in src/renderer/utils/helpers.js (issue #376).
//
// formatSize used to know only B–GB: one terabyte printed "1.0 undefined", and
// input below one byte printed "512.0 undefined". Its main-process twin,
// src/shared/runtime/format-bytes.js, is held to the same output here.
//
// closedMarkdownLength cuts a streaming answer into its finished blocks and
// the open one (#998); rendered piece by piece it has to come out exactly as
// the whole text would, at every point of the stream.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { RENDERER_DIR, importRenderer, setupRendererDom } = require('./helpers/dom.js');
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
  assert.equal(isTextFile('binary'), false);
});

test('isTextFile reads dot files as text, since the tree can show them (#436)', async () => {
  const { isTextFile } = await load();
  // No extension of their own — configuration by convention.
  for (const name of ['.env', '.gitignore', '.npmrc', '.nvmrc', '.editorconfig', '.gitattributes']) {
    assert.equal(isTextFile(name), true, name);
  }
  // The stage of an env file sits where the extension would be.
  for (const name of ['.env.local', '.env.example', '.ENV.production']) {
    assert.equal(isTextFile(name), true, name);
  }
  // With an extension, the extension decides.
  assert.equal(isTextFile('.eslintrc.json'), true);
  assert.equal(isTextFile('.notes.md.swp'), false);
  assert.equal(isTextFile('.cover.png'), false);
  assert.equal(isTextFile('.'), false);
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

// --- closedMarkdownLength (#998) ---------------------------------------------

/** The marked the app ships, in a context of its own, set as the global the helper reads. */
function useMarked(t) {
  const context = {};
  vm.runInNewContext(fs.readFileSync(path.join(RENDERER_DIR, 'vendor', 'marked.umd.js'), 'utf8'), context);
  globalThis.marked = context.marked;
  t.after(() => { delete globalThis.marked; });
  return context.marked;
}

/**
 * Streams `text` in steps the way ChatStream does — what is closed is
 * rendered once, the rest on every step — and fails on the first step whose
 * result differs from rendering the whole text so far.
 */
function assertStreamsLikeWhole(closedMarkdownLength, marked, text, { step = () => 1 } = {}) {
  const parse = (markdown) => marked.parse(markdown, { breaks: true, gfm: true });
  let closed = '';
  let closedHtml = '';
  for (let n = 1; n <= text.length; n += step()) {
    const sofar = text.slice(0, n);
    const length = closedMarkdownLength(sofar.slice(closed.length));
    let html;
    if (length === null) {
      html = parse(sofar);
    } else {
      closedHtml += parse(sofar.slice(closed.length, closed.length + length));
      closed += sofar.slice(closed.length, closed.length + length);
      html = closedHtml + parse(sofar.slice(closed.length));
    }
    assert.equal(html, parse(sofar), `differs from the whole text after ${JSON.stringify(sofar)}`);
  }
  return closed;
}

const ANSWER = [
  '## The plan',
  'Some *text* with `code` and a [link](https://example.com).\nA second line.',
  '- one\n- two\n  - nested\n- three',
  '1. first\n2. second',
  '```js\nfunction step(items) {\n\n  return items;\n}\n```',
  '> quoted\n> more\nlazy',
  '| a | b |\n|---|--:|\n| 1 | 2 |',
  'Setext\n---',
  '***',
  '    indented code',
  '- [ ] open\n- [x] done',
  '- loose\n\n- items\n\n-\n- empty one',
  'End **bold** ~~gone~~.',
].join('\n\n');

test('closedMarkdownLength: an answer streamed block by block renders as the whole one', async (t) => {
  const { closedMarkdownLength } = await load();
  const marked = useMarked(t);
  const closed = assertStreamsLikeWhole(closedMarkdownLength, marked, ANSWER);
  assert.ok(closed.length > ANSWER.length / 2, 'most of the answer was closed on the way');
  assert.ok(!closed.includes('End **bold**'), 'the last block stays open');
});

test('closedMarkdownLength: random block sequences stream like the whole text', async (t) => {
  const { closedMarkdownLength } = await load();
  const marked = useMarked(t);
  // Lines chosen for the cases that tempt a cut in the wrong place: blocks
  // without a blank line between them, lazy continuations, markers that are
  // only half there, tables without their delimiter row.
  const lines = [
    '', '', '', '', 'text line', 'more *em* text', '- item', '- ', '  - nested', '  indented para',
    '1. one', '2. two', '2.', '1) p', '* star', '+ plus', '> quote', '>', 'lazy', '```', '```js', '~~~',
    '    code', '---', '===', '***', '# H', '| a | b |', '|---|---|', '| 1 | 2 |', '- [ ] t', '\\',
    'x  ', '   - three', '10. ten', '\t- tab', 'a | b', '-- | --', '[l](https://a.b)', '`c` **b**', '  ',
  ];
  let seed = 998;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let doc = 0; doc < 150; doc += 1) {
    const text = Array.from({ length: 6 + Math.floor(random() * 14) }, () => lines[Math.floor(random() * lines.length)]).join('\n');
    assertStreamsLikeWhole(closedMarkdownLength, marked, text, { step: () => 1 + Math.floor(random() * 3) });
  }
});

test('closedMarkdownLength cuts only after a blank line, before a complete line', async (t) => {
  const { closedMarkdownLength } = await load();
  useMarked(t);
  assert.equal(closedMarkdownLength('One.\n\nTwo'), 0, 'the first line of the open block is not complete yet');
  assert.equal(closedMarkdownLength('One.\n\nTwo\n'), 6);
  assert.equal(closedMarkdownLength('# Title\nText\n'), 0, 'no blank line, no cut');
  assert.equal(closedMarkdownLength('- a\n\n2'), 0, 'a half marker could still join the list');
  assert.equal(closedMarkdownLength('A\n\nB\n\nC\n'), 6, 'everything above the last block');
  assert.equal(closedMarkdownLength(''), 0);
});

test('closedMarkdownLength leaves raw HTML, link definitions and CRLF to a whole render', async (t) => {
  const { closedMarkdownLength } = await load();
  useMarked(t);
  // An open <details> takes in the blocks below it when parsed together.
  assert.equal(closedMarkdownLength('<details>\n\n# Inside\n\n</details>\n'), null);
  // So does a <b> left open inside a paragraph.
  assert.equal(closedMarkdownLength('A <b>bold\n\nNext\n'), null);
  // The definition below turns the reference above into a link.
  assert.equal(closedMarkdownLength('See [x].\n\n[x]: https://example.com\n'), null);
  // marked turns \r\n into \n, so its pieces no longer measure the text.
  assert.equal(closedMarkdownLength('One.\r\n\r\nTwo\r\n'), null);
});

test('closedMarkdownLength without marked asks for a whole render', async () => {
  const { closedMarkdownLength } = await load();
  assert.equal(typeof globalThis.marked, 'undefined');
  assert.equal(closedMarkdownLength('One.\n\nTwo\n'), null);
});
