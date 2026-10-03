// The contract of the HTML view (#479): which files it takes, the types the
// page's files are served with, and which chat links point at an HTML file.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isHtmlFileName,
  htmlPreviewMimeType,
  htmlLinkTargetOf,
  MAX_HTML_PREVIEW_BYTES,
  MAX_HTML_ASSET_BYTES,
} = require('../src/shared/contracts/html-preview');
const { MAX_WORKSPACE_IMAGE_BYTES } = require('../src/shared/contracts/workspace-image');

test('html and htm, in any case; nothing that only contains the word', () => {
  for (const name of ['index.html', 'INDEX.HTM', 'a.b.html', 'C:\\x\\Report.Html']) assert.equal(isHtmlFileName(name), true, name);
  for (const name of ['html', '.html', 'page.xhtml', 'notes.md', 'index.html.bak', '']) assert.equal(isHtmlFileName(name), false, name);
});

test('the limits are the ones of the text preview and of a workspace image', () => {
  assert.equal(MAX_HTML_PREVIEW_BYTES, 1024 * 1024);
  assert.equal(MAX_HTML_ASSET_BYTES, MAX_WORKSPACE_IMAGE_BYTES);
});

test('a page gets its files with a type a browser accepts, anything else as bytes', () => {
  assert.equal(htmlPreviewMimeType('/ws/style.css'), 'text/css; charset=utf-8');
  assert.equal(htmlPreviewMimeType('/ws/app.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(htmlPreviewMimeType('/ws/img/Logo.PNG'), 'image/png');
  assert.equal(htmlPreviewMimeType('/ws/font.woff2'), 'font/woff2');
  assert.equal(htmlPreviewMimeType('/ws/Makefile'), 'application/octet-stream');
  assert.equal(htmlPreviewMimeType('/ws/run.exe'), 'application/octet-stream');
});

test('chat links to HTML files: relative, absolute, a drive, a file URL', () => {
  assert.deepEqual(htmlLinkTargetOf('out/report.html'), { path: 'out/report.html', fragment: '' });
  assert.deepEqual(htmlLinkTargetOf('./my%20report.html#summary'), { path: './my report.html', fragment: 'summary' });
  assert.deepEqual(htmlLinkTargetOf('/Users/me/ws/index.htm?x=1'), { path: '/Users/me/ws/index.htm', fragment: '' });
  assert.deepEqual(htmlLinkTargetOf('C:\\ws\\index.html'), { path: 'C:\\ws\\index.html', fragment: '' });
  assert.deepEqual(htmlLinkTargetOf('file:///Users/me/ws/a%231.html'), { path: '/Users/me/ws/a#1.html', fragment: '' });
  assert.deepEqual(htmlLinkTargetOf('file:///C:/ws/index.html#top'), { path: 'C:/ws/index.html', fragment: 'top' });
});

test('anything else is no HTML link', () => {
  for (const href of [
    'https://example.com/index.html', 'mailto:a@b.c', 'javascript:alert(1)//.html', '//host/x.html',
    'notes.md', '#section', '', null, 'bad%zz.html', 'data:text/html,<p>x</p>.html', 'file:relative.html',
  ]) {
    assert.equal(htmlLinkTargetOf(href), null, String(href));
  }
});
