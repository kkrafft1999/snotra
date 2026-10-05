// A popup closes when the focus leaves it (#583, #585) — but not when the
// focus only drops for a moment because the popup moves in the DOM: the
// composer bar moves its pills, open menu included, when it crosses 400 px,
// and Chromium sends a focusout without a target on the way (#741).

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer, flush } = require('./helpers/dom.js');

async function setup() {
  const dom = setupRendererDom();
  const { document } = dom;
  const { dismissOnFocusLeave } = await importRenderer('utils', 'helpers.js');
  const container = document.createElement('div');
  const inside = document.createElement('button');
  const outside = document.createElement('button');
  container.appendChild(inside);
  document.body.append(container, outside);
  const state = { open: true, dismissed: 0 };
  dismissOnFocusLeave({
    container,
    isOpen: () => state.open,
    onDismiss: () => { state.dismissed += 1; state.open = false; },
  });
  // What Chromium sends when the focused node is taken out of the DOM.
  const dropFocus = () => inside.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
  return { dom, document, inside, outside, state, dropFocus };
}

test('focus that moves to something outside closes the popup at once', async () => {
  const { dom, inside, outside, state } = await setup();
  try {
    inside.focus();
    outside.focus();
    assert.equal(state.dismissed, 1);
  } finally {
    dom.cleanup();
  }
});

test('focus that drops and comes straight back keeps the popup open (#741)', async () => {
  const { dom, inside, state, dropFocus } = await setup();
  try {
    inside.focus();
    dropFocus();
    inside.focus();
    await flush();
    assert.equal(state.dismissed, 0);
    assert.equal(state.open, true);
  } finally {
    dom.cleanup();
  }
});

test('focus that drops and does not come back closes the popup (#741)', async () => {
  const { dom, document, inside, state, dropFocus } = await setup();
  try {
    inside.focus();
    inside.blur();
    dropFocus();
    assert.equal(state.dismissed, 0, 'judged a moment later, not in the event');
    await flush();
    assert.notEqual(document.activeElement, inside);
    assert.equal(state.dismissed, 1);
  } finally {
    dom.cleanup();
  }
});

test('the composer bar moving an open menu leaves it open (#741)', async () => {
  const dom = setupRendererDom();
  try {
    const { document } = dom;
    const { dismissOnFocusLeave } = await importRenderer('utils', 'helpers.js');
    const { applyComposerBarLayout } = await importRenderer('components', 'ComposerBarLayout.js');
    const bar = document.querySelector('.chat-composer-bar');
    const parts = {
      bar,
      start: bar.querySelector('.chat-composer-bar-start'),
      pills: document.getElementById('chat-composer-pills'),
      anchor: document.getElementById('chat-voice-status'),
    };
    const wrap = document.getElementById('chat-model-picker-wrap');
    let dismissed = 0;
    dismissOnFocusLeave({ container: wrap, isOpen: () => true, onDismiss: () => { dismissed += 1; } });
    const pill = document.getElementById('btn-chat-model-picker');
    pill.focus();
    // happy-dom sends nothing when a focused node moves; Chromium does.
    const move = parts.bar.prepend.bind(parts.bar);
    parts.bar.prepend = (node) => {
      move(node);
      pill.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true, relatedTarget: null }));
    };
    applyComposerBarLayout(parts, 280);
    await flush();
    assert.equal(document.activeElement, pill);
    assert.equal(dismissed, 0);
  } finally {
    dom.cleanup();
  }
});
