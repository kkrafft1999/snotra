// HTML pages in the preview run outside the app (#479) — and the app does not
// open up for them. The issue asks for this to be asserted, not claimed:
// the renderer's CSP and the window's webPreferences are pinned here as they
// were before, and a page's frame is no sender main listens to.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { isTrustedIpcSender } = require('../src/main/ipc/trusted-sender');
const { isTrustedRendererUrl } = require('../src/main/permissions');

const SRC = path.join(__dirname, '..', 'src');

test('the renderer CSP is the one from before #479: no frames, no inline script', () => {
  const html = fs.readFileSync(path.join(SRC, 'renderer', 'index.html'), 'utf8');
  const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1];
  assert.equal(
    csp,
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; "
      + "media-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none';",
  );
  assert.doesNotMatch(csp, /frame-src|child-src|snotra-html|unsafe-inline|unsafe-eval/);
});

test('the window keeps its webPreferences: sandbox, isolation, no Node, no webview', () => {
  const source = fs.readFileSync(path.join(SRC, 'main', 'window.js'), 'utf8');
  const block = /webPreferences:\s*\{([^}]*)\}/.exec(source)?.[1] ?? '';
  const entries = block.split('\n').map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(entries, [
    "preload: path.join(projectRoot, 'src', 'preload', 'bundle.js'),",
    'contextIsolation: true,',
    'nodeIntegration: false,',
    'sandbox: true,',
  ]);
});

test('a page of the preview is no sender main answers, and no renderer it trusts', () => {
  const page = 'snotra-html://00000000000000000000000000000001/ws/index.html';
  assert.equal(isTrustedRendererUrl(page), false);
  assert.equal(isTrustedIpcSender({ senderFrame: { parent: null, url: page } }), false);
});

test('the preview has no preload, and the scheme is handled in its own session only', () => {
  const service = fs.readFileSync(path.join(SRC, 'main', 'services', 'html-preview-service.js'), 'utf8');
  assert.doesNotMatch(service, /preload\s*:/);
  assert.match(service, /session\.fromPartition\(HTML_PREVIEW_PARTITION\)/);
  assert.match(service, /ses\.protocol\.handle\(/);
  // No handler on the global `protocol`, which would serve the app's window too.
  const main = fs.readFileSync(path.join(SRC, 'main', 'index.js'), 'utf8');
  assert.doesNotMatch(main, /protocol\.handle\(/);
});
