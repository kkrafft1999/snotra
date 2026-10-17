'use strict';

// The app's pages from `snotra-app://app/` (AR-37, #1012): the handler serves
// the renderer folder and nothing next to it or above it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const {
  APP_SCHEME_PRIVILEGES,
  RENDERER_ROOT,
  appUrl,
  appMimeType,
  resolveAppPath,
  createAppProtocolHandler,
} = require('../src/main/app-protocol');
const { RENDERER_URL, MANUAL_URL, isTrustedRendererUrl, isManualRendererUrl } = require('../src/main/permissions');

const request = (url, method = 'GET') => ({ url, method });

test('both windows load from the app scheme, and the old file: URLs are no longer trusted', () => {
  assert.equal(RENDERER_URL, 'snotra-app://app/index.html');
  assert.equal(MANUAL_URL, 'snotra-app://app/manual.html');
  const oldRenderer = pathToFileURL(path.join(RENDERER_ROOT, 'index.html')).href;
  const oldManual = pathToFileURL(path.join(RENDERER_ROOT, 'manual.html')).href;
  assert.equal(isTrustedRendererUrl(oldRenderer), false);
  assert.equal(isManualRendererUrl(oldManual), false);
  assert.equal(isTrustedRendererUrl('snotra-app://other/index.html'), false, 'another host is another origin');
});

test('the scheme is standard and secure, and asks for nothing more', () => {
  assert.equal(APP_SCHEME_PRIVILEGES.scheme, 'snotra-app');
  assert.deepEqual(APP_SCHEME_PRIVILEGES.privileges, { standard: true, secure: true, codeCache: true });
});

test('a URL names a file inside the renderer folder, or nothing', () => {
  assert.equal(resolveAppPath(appUrl('index.html')), path.join(RENDERER_ROOT, 'index.html'));
  assert.equal(resolveAppPath(appUrl('vendor/pdfjs/pdf.min.mjs')), path.join(RENDERER_ROOT, 'vendor', 'pdfjs', 'pdf.min.mjs'));
  assert.equal(resolveAppPath(appUrl('styles/a%20b.css')), path.join(RENDERER_ROOT, 'styles', 'a b.css'));
  for (const outside of [
    'snotra-app://app/',
    'snotra-app://app/..%2fmain%2findex.js',
    'snotra-app://app/%2e%2e/main/index.js',
    'snotra-app://app/styles%5c..%5c..%5cmain%5cindex.js',
    'snotra-app://app/a%00.js',
    'snotra-app://app/%E0%A4%A',
    'snotra-app://app/C:/Windows/win.ini',
    'snotra-app://other/index.html',
    'file:///etc/passwd',
    'not a url',
  ]) {
    const resolved = resolveAppPath(outside);
    assert.ok(resolved === null || resolved.startsWith(RENDERER_ROOT + path.sep), `${outside} → ${resolved}`);
  }
  // The URL parser folds `..` before the handler sees the path: what is
  // left still points inside the folder.
  assert.equal(resolveAppPath('snotra-app://app/../../main/index.js'), path.join(RENDERER_ROOT, 'main', 'index.js'));
});

test('the handler serves files with their type, and refuses the rest', async () => {
  const serve = createAppProtocolHandler();
  const page = await serve(request(RENDERER_URL));
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await page.text(), fs.readFileSync(path.join(RENDERER_ROOT, 'index.html'), 'utf8'));

  const app = await serve(request(appUrl('app.js')));
  assert.equal(app.headers.get('content-type'), 'text/javascript; charset=utf-8', 'module scripts need a JavaScript type');

  const head = await serve(request(RENDERER_URL, 'HEAD'));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  assert.equal((await serve(request(RENDERER_URL, 'POST'))).status, 405);
  assert.equal((await serve(request(appUrl('missing.js')))).status, 404);
  assert.equal((await serve(request(appUrl('styles')))).status, 404, 'a folder is not a file');
  assert.equal((await serve(request('snotra-app://app/..%2f..%2fpackage.json'))).status, 404);
});

test('file types', () => {
  assert.equal(appMimeType('x.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(appMimeType('x.CSS'), 'text/css; charset=utf-8');
  assert.equal(appMimeType('x.woff2'), 'font/woff2');
  assert.equal(appMimeType('x.bcmap'), 'application/octet-stream');
});
