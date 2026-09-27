// Without encrypted storage (#419) "Auto" cannot be stored: the mode pill and
// the mode card show it, say why, and do not offer it — unless it is the mode
// already set, so that it can be left. "Always ask" stays available.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer } = require('./helpers/dom.js');

function permissions(state) {
  return {
    get: () => state,
    mode: () => state.mode,
    subscribe() {
      return () => {};
    },
    async refresh() {
      return state;
    },
    async setMode() {
      return { ok: true };
    },
    async setWorkspaceMode() {
      return { ok: true };
    },
  };
}

function stateWith(patch) {
  return {
    mode: 'smart',
    workspaceRoot: '/work/projekt',
    workspaceMode: 'smart',
    encryptionAvailable: false,
    integrity: 'unsigned',
    globalRules: [],
    workspaceRules: [],
    sensitivePathPatterns: [],
    executionIsolation: { unisolated: false, tools: [], reason: '', pending: false },
    ...patch,
  };
}

test('view: "Auto" is unavailable without encrypted storage, unless it is the mode already set', async () => {
  const { toolModeOptions } = await importRenderer('utils', 'tool-approval-view.js');
  const blocked = toolModeOptions(stateWith({}));
  assert.deepEqual(blocked.map((o) => [o.value, o.unavailable]), [['smart', false], ['ask-all', false], ['auto', true]]);
  assert.equal(blocked[2].description, 'Not available: this system offers no encrypted storage.');
  assert.equal(toolModeOptions(stateWith({ mode: 'auto' }))[2].unavailable, false);
  assert.equal(toolModeOptions(stateWith({ encryptionAvailable: true }))[2].unavailable, false);
  assert.equal(toolModeOptions()[2].unavailable, false, 'without a state nothing is marked');
});

test('mode pill: "Auto" is shown but disabled, and the arrow keys pass over it', async () => {
  const dom = setupRendererDom();
  try {
    const { initToolModePicker } = await importRenderer('components', 'ToolModePicker.js');
    initToolModePicker({ toolPermissions: permissions(stateWith({ mode: 'ask-all' })) });
    const doc = dom.document;
    doc.getElementById('btn-chat-tool-mode').click();
    const auto = doc.querySelector('.chat-tool-mode-option[data-mode="auto"]');
    assert.equal(auto.disabled, true);
    assert.equal(auto.getAttribute('aria-disabled'), 'true');
    assert.match(auto.textContent, /Not available: this system offers no encrypted storage\./);
    assert.equal(doc.querySelector('.chat-tool-mode-option[data-mode="ask-all"]').disabled, false);

    const menu = doc.getElementById('chat-tool-mode-menu');
    assert.equal(doc.activeElement?.dataset.mode, 'ask-all');
    menu.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert.equal(doc.activeElement?.dataset.mode, 'smart', 'from "Always ask" down wraps past "Auto"');
  } finally {
    dom.cleanup();
  }
});

test('mode card: the "Auto" radio is disabled with the reason, and the notice says what still works', async () => {
  const dom = setupRendererDom();
  try {
    const { initToolPermissionsPanel } = await importRenderer('components', 'ToolPermissionsPanel.js');
    const panel = initToolPermissionsPanel({ toolPermissions: permissions(stateWith({})) });
    await panel.open([]);
    const doc = dom.document;
    const radio = (value) => doc.querySelector(`#settings-tool-mode-group input[value="${value}"]`);
    assert.equal(radio('auto').disabled, true);
    assert.equal(radio('ask-all').disabled, false);
    assert.match(radio('auto').closest('label').textContent, /Not available/);
    assert.match(doc.getElementById('settings-permissions-integrity').textContent, /“Smart” and “Always ask” work as usual/);
  } finally {
    dom.cleanup();
  }
});
