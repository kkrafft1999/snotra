// The composer bar in a narrow chat (#400): below 400 px the model and mode
// pill take a row of their own above the mic, the token counter and send.
//
// happy-dom has no layout (see test/helpers/dom.js), so the width is handed
// in rather than measured, and what is checked is the contract: where the
// pill group sits in the DOM, that the tab order follows it, and that the
// stylesheet still has the rules the attribute switches on. How it looks is
// checked in the running app (e2e/manual-docked-composer.mjs).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupRendererDom, importRenderer, RENDERER_DIR } = require('./helpers/dom.js');

const STYLES = fs.readFileSync(path.join(RENDERER_DIR, 'styles.css'), 'utf8');
const TAB_STOPS = ['btn-chat-mic', 'btn-chat-model-picker', 'btn-chat-tool-mode', 'chat-token-usage', 'btn-chat-send'];

function parts(document) {
  const bar = document.querySelector('.chat-composer-bar');
  return {
    bar,
    start: bar.querySelector('.chat-composer-bar-start'),
    pills: document.getElementById('chat-composer-pills'),
    anchor: document.getElementById('chat-voice-status'),
  };
}

/** The bar's buttons in DOM order, which is the tab order. */
function tabOrder(bar) {
  return [...bar.querySelectorAll('button')].map((el) => el.id).filter((id) => TAB_STOPS.includes(id));
}

test('in a wide bar the pills sit after the mic, in one row', async () => {
  const dom = setupRendererDom();
  try {
    const { applyComposerBarLayout } = await importRenderer('components', 'ComposerBarLayout.js');
    const p = parts(dom.document);
    assert.equal(applyComposerBarLayout(p, 560), false);
    assert.equal(p.bar.dataset.stacked, undefined);
    assert.equal(p.pills.parentElement, p.start);
    assert.equal(p.pills.previousElementSibling, p.anchor, 'right after the voice status, as in the markup');
    assert.deepEqual(tabOrder(p.bar), TAB_STOPS);
  } finally {
    dom.cleanup();
  }
});

test('in a narrow bar the pills come first, and the tab order follows them', async () => {
  const dom = setupRendererDom();
  try {
    const { applyComposerBarLayout, STACK_BAR_BELOW } = await importRenderer('components', 'ComposerBarLayout.js');
    const p = parts(dom.document);
    assert.equal(applyComposerBarLayout(p, STACK_BAR_BELOW - 1), true);
    assert.equal(p.bar.dataset.stacked, 'true');
    assert.equal(p.bar.firstElementChild, p.pills);
    assert.deepEqual(tabOrder(p.bar), ['btn-chat-model-picker', 'btn-chat-tool-mode', 'btn-chat-mic', 'chat-token-usage', 'btn-chat-send']);

    // At the threshold, and back: one row again, in the original place.
    assert.equal(applyComposerBarLayout(p, STACK_BAR_BELOW), false);
    assert.equal(p.pills.previousElementSibling, p.anchor);
    assert.deepEqual(tabOrder(p.bar), TAB_STOPS);
  } finally {
    dom.cleanup();
  }
});

test('a pill that has the focus keeps it when the group moves', async () => {
  const dom = setupRendererDom();
  try {
    const { applyComposerBarLayout } = await importRenderer('components', 'ComposerBarLayout.js');
    const p = parts(dom.document);
    const mode = dom.document.getElementById('btn-chat-tool-mode');
    mode.focus();
    applyComposerBarLayout(p, 280);
    assert.equal(dom.document.activeElement, mode);
    applyComposerBarLayout(p, 280);
    assert.equal(p.bar.firstElementChild, p.pills, 'applying twice moves nothing');
  } finally {
    dom.cleanup();
  }
});

test('the stylesheet has the rules the layout switches on', () => {
  assert.match(STYLES, /\.chat-composer-bar\[data-stacked='true'\]\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(STYLES, /\.chat-composer-bar\[data-stacked='true'\]\s*>\s*\.chat-composer-pills\s*\{[^}]*flex:\s*1 1 100%/);
  // The gutter grows with the panel: 16 px docked, 64 px from 640 px on.
  assert.match(STYLES, /--chat-gutter-x:\s*clamp\(16px, calc\(15% - 32px\), 64px\);/);
});
