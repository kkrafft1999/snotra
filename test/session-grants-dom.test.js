// Session approvals one by one (#447): the Permissions tab lists them grouped
// by chat, each with its own "Revoke", keeps "Revoke all", and moves the focus
// on so that the keyboard does not fall back to the top of the dialog.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer } = require('./helpers/dom.js');

function grant(id, patch = {}) {
  return {
    id,
    chatId: 'chat-a',
    chatTitle: 'Release notes',
    current: true,
    tool: 'write_file_text',
    classes: ['write'],
    grantedAt: Date.UTC(2026, 8, 29, 12, 30),
    scope: { key: 'approval.sessionScope.targets', params: { tool: 'write_file_text', paths: `docs/${id}.md`, effectKeys: [] } },
    ...patch,
  };
}

function stateWith(sessionGrants) {
  return {
    mode: 'smart',
    workspaceRoot: '/work/projekt',
    workspaceMode: 'smart',
    encryptionAvailable: true,
    integrity: 'ok',
    globalRules: [],
    workspaceRules: [],
    sensitivePathPatterns: [],
    executionIsolation: { unisolated: false, tools: [], reason: '', pending: false },
    sessionGrantCount: sessionGrants.length,
    sessionGrants,
  };
}

/** A stand-in for the renderer state: revoking really removes and redraws. */
function permissions(initial) {
  let state = stateWith(initial);
  const listeners = new Set();
  const calls = [];
  const redraw = () => {
    for (const listener of listeners) listener(state);
  };
  return {
    calls,
    get: () => state,
    mode: () => state.mode,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async refresh() {
      return state;
    },
    async revokeSessionGrant(id) {
      calls.push(['revoke', id]);
      state = stateWith(state.sessionGrants.filter((g) => g.id !== id));
      redraw();
      return { ok: true, revoked: true };
    },
    async clearSessionGrants() {
      calls.push(['clear']);
      state = stateWith([]);
      redraw();
      return { ok: true };
    },
  };
}

async function openPanel(dom, grants) {
  const { initToolPermissionsPanel } = await importRenderer('components', 'ToolPermissionsPanel.js');
  const toolPermissions = permissions(grants);
  const panel = initToolPermissionsPanel({ toolPermissions });
  await panel.open([]);
  return toolPermissions;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('the list groups by chat, the open chat first, and says what each approval covers', async () => {
  const dom = setupRendererDom();
  try {
    await openPanel(dom, [
      grant('bg', { chatId: 'chat-b', chatTitle: 'Tree filter', current: false }),
      grant('one'),
    ]);
    const doc = dom.document;
    const labels = [...doc.querySelectorAll('.settings-grants__group-label')].map((el) => el.textContent);
    assert.deepEqual(labels, ['Release notes · open chat', 'Tree filter · running in the background']);
    const first = doc.querySelector('.settings-grant');
    assert.match(first.querySelector('.settings-grant__scope').textContent, /docs\/one\.md/);
    assert.match(first.querySelector('.settings-grant__meta').textContent, /^Granted at /);
    const button = first.querySelector('button[data-grant-id="one"]');
    assert.match(button.getAttribute('aria-label'), /^Revoke: .*docs\/one\.md/);
    assert.equal(doc.getElementById('settings-grants-empty').classList.contains('hidden'), true);
    assert.equal(doc.querySelector('.settings-grants__footer').classList.contains('hidden'), false);
    assert.equal(doc.querySelector('#settings-reset-actions [data-reset="session"]'), null, 'no second place for the bulk action');
  } finally {
    dom.cleanup();
  }
});

test('revoking one moves the focus to the next, the last one to the empty hint', async () => {
  const dom = setupRendererDom();
  try {
    const toolPermissions = await openPanel(dom, [grant('one'), grant('two')]);
    const doc = dom.document;
    doc.querySelector('button[data-grant-id="one"]').click();
    await settle();
    assert.deepEqual(toolPermissions.calls, [['revoke', 'one']]);
    assert.equal(doc.activeElement?.dataset.grantId, 'two');
    assert.match(doc.getElementById('status-session-grants').textContent, /next identical call asks again/);

    doc.querySelector('button[data-grant-id="two"]').click();
    await settle();
    const empty = doc.getElementById('settings-grants-empty');
    assert.equal(empty.classList.contains('hidden'), false);
    assert.match(empty.textContent, /Allow for this session/);
    assert.equal(doc.activeElement, empty);
    assert.equal(doc.querySelector('.settings-grants__footer').classList.contains('hidden'), true);
  } finally {
    dom.cleanup();
  }
});

test('"Revoke all" clears the list', async () => {
  const dom = setupRendererDom();
  try {
    const toolPermissions = await openPanel(dom, [grant('one'), grant('two')]);
    const doc = dom.document;
    doc.getElementById('btn-grants-revoke-all').click();
    await settle();
    assert.deepEqual(toolPermissions.calls, [['clear']]);
    assert.equal(doc.querySelectorAll('.settings-grant').length, 0);
    assert.equal(doc.activeElement, doc.getElementById('settings-grants-empty'));
  } finally {
    dom.cleanup();
  }
});
