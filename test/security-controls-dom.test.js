// The controls on Settings › Security (#449): tool switches that apply at
// once, rules removed and approvals revoked in their row, the rule form opened
// in place, the slots that keep their elements across redraws, and the jump
// from the approval card to the sandbox switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupRendererDom, importRenderer } = require('./helpers/dom.js');
const { describeSecurityOverview } = require('../src/application/permissions/security-overview');

const ROOT = '/work/snotra';

function tool(name, riskClasses, extra = {}) {
  return { name, shortDescription: `${name} does its job.`, riskClasses, available: true, disabled: false, mcpServer: null, ...extra };
}

const TOOLS = [
  tool('read_file_text', ['read']),
  tool('write_file_text', ['write'], { mayOverwrite: true }),
  tool('edit_file', ['write']),
  tool('shell_execute', ['execute']),
  tool('run_python', ['execute'], { available: false }),
  tool('web_search', ['external'], { available: false }),
  tool('mcp__gh__issues', ['execute', 'external'], { mcpServer: 'GitHub' }),
];

function overviewWith(patch = {}) {
  return describeSecurityOverview({
    root: ROOT,
    mode: 'smart',
    tools: TOOLS,
    execution: { sandbox: { status: 'isolated', isolated: true }, programAllowances: [] },
    ...patch,
  });
}

function stateWith(patch = {}) {
  return {
    mode: 'smart',
    workspaceRoot: ROOT,
    workspaceMode: 'smart',
    encryptionAvailable: true,
    integrity: 'ok',
    globalRules: [],
    workspaceRules: [],
    sensitivePathPatterns: [],
    sessionGrants: [],
    programAllowances: [],
    homeDir: '/Users/u',
    ...patch,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function openPage(overview, { toggle = async () => true, results = {} } = {}) {
  const { initSecurityPanel } = await importRenderer('components', 'SecurityPanel.js');
  const { initToolPermissionsPanel } = await importRenderer('components', 'ToolPermissionsPanel.js');
  const state = stateWith();
  const listeners = new Set();
  const calls = [];
  const toolPermissions = {
    get: () => state,
    mode: () => state.mode,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener(state);
    },
    async refresh() {
      return state;
    },
    async removeRule(id) {
      calls.push(['removeRule', id]);
      return results.removeRule || { ok: true };
    },
    async revokeSessionGrant(id) {
      calls.push(['revoke', id]);
      return { ok: true, revoked: true };
    },
    async addRule(rule) {
      calls.push(['addRule', rule]);
      return { ok: true };
    },
    async setSensitivePathPatterns(patterns) {
      calls.push(['sensitive', patterns]);
      return { ok: true };
    },
    async setWorkspaceMode() {
      return { ok: true };
    },
  };
  let current = overview;
  const api = {
    async getSecurityOverview() {
      return current;
    },
  };
  const permissionsPanel = initToolPermissionsPanel({ toolPermissions });
  await permissionsPanel.open([{ name: 'edit_file' }, { name: 'write_file_text' }]);
  const toggles = [];
  const panel = initSecurityPanel({
    api,
    toolPermissions,
    permissionsPanel,
    onToggleTool: async (name, on) => {
      toggles.push([name, on]);
      return toggle(name, on);
    },
  });
  await panel.open();
  return { panel, toolPermissions, calls, toggles, setOverview: (next) => { current = next; } };
}

function row(doc, riskClass) {
  return doc.querySelector(`.settings-security-row[data-risk-class="${riskClass}"]`);
}

function openRow(doc, riskClass) {
  const toggle = row(doc, riskClass).querySelector('.settings-security-row__toggle');
  if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  return row(doc, riskClass);
}

test('a tool switch applies at once, and snaps back when it could not be stored', async () => {
  const dom = setupRendererDom();
  try {
    let accept = true;
    const page = await openPage(overviewWith(), { toggle: async () => accept });
    const doc = dom.document;
    const edit = () => openRow(doc, 'write').querySelector('input[data-tool-switch="edit_file"]');
    assert.equal(edit().checked, true);
    assert.equal(edit().getAttribute('role'), 'switch');
    assert.equal(edit().getAttribute('aria-label'), 'Offer edit_file to the model');

    edit().checked = false;
    edit().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.deepEqual(page.toggles, [['edit_file', false]]);

    accept = false;
    edit().checked = false;
    edit().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    await settle();
    assert.equal(edit().checked, true, 'the switch shows what is stored');
    assert.match(doc.getElementById('settings-security-error').textContent, /./);
  } finally {
    dom.cleanup();
  }
});

test('a tool is switched in its own row; elsewhere the row says where', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith());
    const doc = dom.document;
    const overwrite = openRow(doc, 'delete');
    assert.equal(overwrite.querySelector('input[data-tool-switch]'), null);
    assert.match(overwrite.textContent, /switched under “Change”/);
    const external = openRow(doc, 'external');
    assert.ok(external.querySelector('input[data-tool-switch="mcp__gh__issues"]'), 'MCP tools are switched with the services');
    assert.equal(external.querySelector('input[data-tool-switch="web_search"]'), null, 'no key, no switch');
    assert.match(external.textContent, /not available/);
    const execute = openRow(doc, 'execute');
    assert.equal(execute.querySelector('input[data-tool-switch]'), null, 'the execution tools have their own switches');
    assert.ok(execute.querySelector('#input-shell-enabled'));
    assert.match(execute.textContent, /Always allow this command/);
  } finally {
    dom.cleanup();
  }
});

test('an allowance or a block is removed in its row, a session approval revoked', async () => {
  const dom = setupRendererDom();
  try {
    const page = await openPage(overviewWith({
      globalRules: [
        { id: 'a1', effect: 'allow', scope: 'global', root: null, tool: null, riskClass: 'write', pathPattern: 'docs/**' },
        { id: 'd1', effect: 'deny', scope: 'global', root: null, tool: null, riskClass: 'write', pathPattern: '.git/**' },
      ],
      sessionGrants: [{ id: 'g1', tool: 'edit_file', classes: ['write'], chatId: 'c', chatTitle: 'Release', current: true, scope: null }],
    }));
    const doc = dom.document;
    const write = openRow(doc, 'write');
    const removeAllow = write.querySelector('button[data-rule-remove="a1"]');
    assert.match(removeAllow.getAttribute('aria-label'), /docs\/\*\*/);
    removeAllow.click();
    await settle();
    openRow(doc, 'write').querySelector('button[data-rule-remove="d1"]').click();
    await settle();
    // Main answers with the approval gone; the keyboard lands on its row.
    page.setOverview(overviewWith());
    openRow(doc, 'write').querySelector('button[data-grant-revoke="g1"]').click();
    await settle();
    assert.deepEqual(page.calls, [['removeRule', 'a1'], ['removeRule', 'd1'], ['revoke', 'g1']]);
    assert.equal(doc.activeElement === row(doc, 'write').querySelector('.settings-security-row__toggle'), true);
    assert.equal(row(doc, 'write').querySelector('button[data-grant-revoke]'), null);
  } finally {
    dom.cleanup();
  }
});

test('a cancelled system dialog says nothing and gives the button back', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith({
      globalRules: [{ id: 'd1', effect: 'deny', scope: 'global', root: null, tool: null, riskClass: 'write', pathPattern: '.git/**' }],
    }), { results: { removeRule: { ok: false, code: 'cancelled' } } });
    const doc = dom.document;
    const button = openRow(doc, 'write').querySelector('button[data-rule-remove="d1"]');
    button.click();
    await settle();
    assert.equal(button.disabled, false);
    assert.equal(doc.getElementById('settings-security-error').classList.contains('hidden'), true);
  } finally {
    dom.cleanup();
  }
});

test('"Allow for good…" opens the rule form in its row, prefilled; Cancel and Escape close it', async () => {
  const dom = setupRendererDom();
  try {
    const page = await openPage(overviewWith());
    const doc = dom.document;
    // Only reading and changing can be allowed for good.
    assert.equal(openRow(doc, 'execute').querySelector('[data-rule-add="allow"]'), null);
    assert.ok(openRow(doc, 'execute').querySelector('[data-rule-add="deny"]'));

    openRow(doc, 'write').querySelector('[data-rule-add="allow"]').click();
    const form = row(doc, 'write').querySelector('#settings-rule-form');
    assert.ok(form, 'the form sits in the write row');
    assert.equal(doc.getElementById('rule-effect').value, 'allow');
    assert.equal(doc.getElementById('rule-subject-type').value, 'class');
    assert.equal(doc.getElementById('rule-class').value, 'write');
    assert.equal(doc.getElementById('rule-scope').value, 'workspace');
    assert.equal(doc.getElementById('heading-rule-form').textContent, 'New allowance: Change');
    assert.equal(doc.activeElement === doc.getElementById('rule-pattern'), true);

    doc.getElementById('btn-rule-cancel').click();
    assert.equal(row(doc, 'write').querySelector('#settings-rule-form'), null);
    assert.equal(doc.activeElement?.dataset.ruleAdd, 'allow');

    openRow(doc, 'read').querySelector('[data-rule-add="deny"]').click();
    assert.equal(doc.getElementById('rule-effect').value, 'deny');
    doc.getElementById('rule-pattern').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(row(doc, 'read').querySelector('#settings-rule-form'), null);
    assert.equal(page.calls.length, 0);
  } finally {
    dom.cleanup();
  }
});

test('a rule created in place goes to main and the form closes', async () => {
  const dom = setupRendererDom();
  try {
    const page = await openPage(overviewWith());
    const doc = dom.document;
    openRow(doc, 'write').querySelector('[data-rule-add="deny"]').click();
    doc.getElementById('rule-pattern').value = 'secrets/**';
    doc.getElementById('settings-rule-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    const [kind, rule] = page.calls[0];
    assert.equal(kind, 'addRule');
    assert.deepEqual([rule.effect, rule.riskClass, rule.pathPattern, rule.scope], ['deny', 'write', 'secrets/**', 'workspace']);
    assert.equal(row(doc, 'write').querySelector('#settings-rule-form'), null);
  } finally {
    dom.cleanup();
  }
});

test('a slot keeps what was typed and the focus when a live update redraws the rows', async () => {
  const dom = setupRendererDom();
  try {
    const page = await openPage(overviewWith());
    const doc = dom.document;
    openRow(doc, 'read-sensitive');
    const input = doc.getElementById('input-sensitive-pattern');
    assert.ok(row(doc, 'read-sensitive').contains(input));
    input.value = 'personal/**';
    input.focus();
    page.setOverview(overviewWith({ sensitivePathPatterns: ['vault/**'] }));
    page.toolPermissions.emit();
    await settle();
    assert.equal(row(doc, 'read-sensitive').contains(input), true, 'the same element, moved into the new row');
    assert.equal(input.value, 'personal/**');
    assert.equal(doc.activeElement === input, true);
  } finally {
    dom.cleanup();
  }
});

test('the card\'s "Sandbox setting" opens the execute row on the switch', async () => {
  const dom = setupRendererDom();
  try {
    const page = await openPage(overviewWith());
    const doc = dom.document;
    assert.equal(await page.panel.reveal('sandbox'), true);
    assert.equal(row(doc, 'execute').querySelector('.settings-security-row__toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(doc.activeElement === doc.getElementById('input-workspace-sandbox'), true);
    assert.equal(await page.panel.reveal('allowances'), true);
    assert.equal(doc.activeElement === doc.getElementById('btn-add-program-allowance'), true);
  } finally {
    dom.cleanup();
  }
});
