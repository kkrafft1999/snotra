// Settings › Security (#448) in the real markup: the header, the summary, the
// six disclosure rows with their three questions, the links to where a
// setting is changed today, and the states the issue names — nothing
// configured, many rules, all tools off, sandbox off, Windows without a
// sandbox, no safeStorage, no folder. The overviews are built by main's own
// builder, so the page is tested against what main would really send.

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
  tool('find_files', ['read']),
  tool('write_file_text', ['write'], { mayOverwrite: true }),
  tool('edit_file', ['write']),
  tool('shell_execute', ['execute']),
  tool('run_python', ['execute'], { available: false }),
  tool('web_search', ['external'], { available: false }),
  tool('fetch_url', ['external']),
  tool('mcp__gh__issues', ['execute', 'external'], { mcpServer: 'GitHub' }),
];

const SANDBOX = { status: 'isolated', isolated: true, reason: '', platform: 'darwin' };

function overviewWith(patch = {}) {
  return describeSecurityOverview({
    root: ROOT,
    mode: 'smart',
    tools: TOOLS,
    execution: { sandbox: SANDBOX, programAllowances: [] },
    ...patch,
  });
}

function permissionsState(patch = {}) {
  return { mode: 'smart', workspaceRoot: ROOT, workspaceMode: 'smart', encryptionAvailable: true, homeDir: '/Users/u', ...patch };
}

/** The renderer's permission state, reduced to what the page uses. */
function fakePermissions(state = permissionsState()) {
  const listeners = new Set();
  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener(state);
    },
    async setWorkspaceMode() {
      return { ok: true };
    },
  };
}

async function openPage(overview, { state, onNavigate } = {}) {
  const { initSecurityPanel } = await importRenderer('components', 'SecurityPanel.js');
  let current = overview;
  const api = {
    calls: 0,
    async getSecurityOverview() {
      api.calls += 1;
      return current;
    },
  };
  const toolPermissions = fakePermissions(state);
  const navigations = [];
  const panel = initSecurityPanel({
    api,
    toolPermissions,
    onNavigate: onNavigate || ((...args) => navigations.push(args)),
  });
  await panel.open();
  return {
    api,
    panel,
    toolPermissions,
    navigations,
    setOverview(next) {
      current = next;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function row(doc, riskClass) {
  return doc.querySelector(`.settings-security-row[data-risk-class="${riskClass}"]`);
}

function pill(doc, riskClass) {
  return [...row(doc, riskClass).querySelectorAll('.settings-security-pill')].map((el) => el.textContent);
}

test('the header names the folder and sums the page up in one sentence', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith({ chats: [{ id: 'a', title: 'Check dependencies', mode: 'ask-all' }] }));
    const doc = dom.document;
    assert.equal(doc.getElementById('settings-security-workspace-name').textContent, 'snotra');
    assert.equal(doc.getElementById('settings-security-workspace-name').title, ROOT);
    assert.equal(doc.getElementById('settings-security-mode-row').hidden, false);
    assert.match(doc.getElementById('settings-security-other-chats').textContent, /“Check dependencies” runs on Always ask/);
    assert.equal(
      doc.getElementById('settings-security-summary').textContent,
      'In this workspace Snotra reads without asking, asks before changing a file, asks before every command (in the sandbox), and asks before using the web or MCP.'
    );
    const checked = doc.querySelector('#settings-security-mode-options input:checked');
    assert.equal(checked?.value, 'smart');
  } finally {
    dom.cleanup();
  }
});

test('six rows, each a closed disclosure button with its status in words', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith());
    const doc = dom.document;
    const toggles = [...doc.querySelectorAll('.settings-security-row__toggle')];
    assert.deepEqual(toggles.map((b) => b.dataset.riskClass), ['read', 'read-sensitive', 'write', 'delete', 'execute', 'external']);
    for (const toggle of toggles) {
      assert.equal(toggle.tagName, 'BUTTON');
      assert.equal(toggle.getAttribute('aria-expanded'), 'false');
      assert.equal(doc.getElementById(toggle.getAttribute('aria-controls')).hidden, true);
    }
    assert.deepEqual(pill(doc, 'read'), ['Runs']);
    assert.deepEqual(pill(doc, 'write'), ['Asks']);
    assert.match(row(doc, 'read').textContent, /2 tools on/);
    assert.match(row(doc, 'execute').textContent, /1 tool on/);

    toggles[4].click();
    assert.equal(toggles[4].getAttribute('aria-expanded'), 'true');
    const body = doc.getElementById(toggles[4].getAttribute('aria-controls'));
    assert.equal(body.hidden, false);
    const questions = [...body.querySelectorAll('.settings-security-q__text')].map((el) => el.textContent);
    assert.deepEqual(questions, ['May Snotra run commands?', 'Does Snotra ask first?', 'What can a command reach?']);
    assert.match(body.textContent, /Commands run in the sandbox/);
    // The execution switches, the sandbox and the allowances sit in the row (#449).
    assert.ok(body.querySelector('#input-shell-enabled'));
    assert.ok(body.querySelector('#input-python-enabled'));
    assert.ok(body.querySelector('#input-workspace-sandbox'));
    assert.ok(body.querySelector('#btn-add-program-allowance'));
    toggles[4].click();
    assert.equal(body.hidden, true);
  } finally {
    dom.cleanup();
  }
});

test('what is set up elsewhere is linked: the interpreter, the search key, MCP servers', async () => {
  const dom = setupRendererDom();
  try {
    const { navigations } = await openPage(overviewWith());
    const doc = dom.document;
    row(doc, 'external').querySelector('.settings-security-row__toggle').click();
    const labels = [...row(doc, 'external').querySelectorAll('[data-security-link]')].map((b) => b.textContent);
    assert.deepEqual(labels, ['Set up the search key under Tools', 'Set up MCP servers under MCP']);
    row(doc, 'external').querySelector('[data-security-link="mcp"]').click();
    assert.deepEqual(navigations.at(-1), ['mcp', 'heading-mcp-servers', null]);
    row(doc, 'execute').querySelector('.settings-security-row__toggle').click();
    row(doc, 'execute').querySelector('[data-security-link="python"]').click();
    assert.deepEqual(navigations.at(-1), ['tools', 'heading-python', null]);
    // Nothing links to a page that no longer has a security control.
    assert.equal(doc.querySelector('[data-security-link="rules"], [data-security-link="sandbox"]'), null);
    // Every link target exists in the markup.
    const { SECURITY_LINK_TARGETS } = await importRenderer('utils', 'security-overview-view.js');
    for (const [key, target] of Object.entries(SECURITY_LINK_TARGETS)) {
      assert.ok(doc.getElementById(target.target), `${key} → #${target.target}`);
      assert.ok(doc.getElementById(`tab-settings-${target.panel}`), `${key} → section ${target.panel}`);
    }
  } finally {
    dom.cleanup();
  }
});

test('nothing configured: allowances and blocks are absent, the patterns built in are shown', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith());
    const doc = dom.document;
    assert.equal(doc.querySelectorAll('.settings-security-row__exceptions').length, 0);
    row(doc, 'read-sensitive').querySelector('.settings-security-row__toggle').click();
    const body = row(doc, 'read-sensitive');
    assert.ok([...body.querySelectorAll('.settings-security-chip')].some((el) => el.textContent === '.env*'));
    assert.match(body.textContent, /No patterns of your own/);
  } finally {
    dom.cleanup();
  }
});

test('many rules: the closed row counts, the open row lists each with its scope', async () => {
  const dom = setupRendererDom();
  try {
    const allow = (id, pathPattern, scope = 'global') => ({ id, effect: 'allow', scope, root: scope === 'workspace' ? ROOT : null, tool: null, riskClass: 'write', pathPattern });
    await openPage(overviewWith({
      globalRules: [allow('a', 'docs/**'), allow('b', '*.md'), { id: 'd', effect: 'deny', scope: 'global', root: null, tool: null, riskClass: 'write', pathPattern: '.git/**' }],
      workspaceRules: [
        allow('c', 'notes/**', 'workspace'),
        { id: 'cmd', effect: 'allow', scope: 'workspace', root: ROOT, tool: 'shell_execute', riskClass: null, pathPattern: '**', command: 'npm test', cwd: '.' },
      ],
    }));
    const doc = dom.document;
    assert.equal(row(doc, 'write').querySelector('.settings-security-row__exceptions').textContent, '3 allowances · blocked on .git/**');
    assert.equal(row(doc, 'execute').querySelector('.settings-security-row__exceptions').textContent, '1 remembered command');
    row(doc, 'write').querySelector('.settings-security-row__toggle').click();
    const text = row(doc, 'write').textContent;
    assert.match(text, /Except these, which you allowed for good/);
    assert.match(text, /notes\/\*\*/);
    assert.match(text, /only this workspace/);
    assert.match(text, /Blocked, in every mode/);
  } finally {
    dom.cleanup();
  }
});

test('all tools off: every row is off and the summary says so', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith({ tools: TOOLS.map((entry) => ({ ...entry, disabled: true })) }));
    const doc = dom.document;
    for (const riskClass of ['read', 'read-sensitive', 'write', 'delete', 'execute', 'external']) {
      assert.deepEqual(pill(doc, riskClass), ['Off'], riskClass);
    }
    assert.match(doc.getElementById('settings-security-summary').textContent, /reads nothing, changes no files, runs no commands, and uses no external service/);
    row(doc, 'execute').querySelector('.settings-security-row__toggle').click();
    // The sandbox is described even while execution is off (#448).
    assert.match(row(doc, 'execute').textContent, /Only matters while “Run Python” or “Run shell commands” is on/);
    assert.match(row(doc, 'execute').textContent, /Commands run in the sandbox/);
  } finally {
    dom.cleanup();
  }
});

test('sandbox off for the workspace: amber "No sandbox" next to the status, and the reason', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith({ execution: { sandbox: SANDBOX, workspaceSandboxDisabled: true, unisolated: true } }));
    const doc = dom.document;
    assert.deepEqual(pill(doc, 'execute'), ['No sandbox', 'Asks']);
    assert.ok(row(doc, 'execute').querySelector('.settings-security-pill--warning'));
    assert.match(doc.getElementById('settings-security-summary').textContent, /asks before every command \(without the sandbox\)/);
    row(doc, 'execute').querySelector('.settings-security-row__toggle').click();
    assert.match(row(doc, 'execute').textContent, /You switched the sandbox off for this workspace/);
  } finally {
    dom.cleanup();
  }
});

test('Windows without a sandbox: the platform reason, not the workspace switch', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith({
      execution: { sandbox: { status: 'unavailable', isolated: false, reason: 'platform', platform: 'win32' }, workspaceSandboxDisabled: true, unisolated: true },
    }));
    const doc = dom.document;
    assert.deepEqual(pill(doc, 'execute'), ['No sandbox', 'Asks']);
    row(doc, 'execute').querySelector('.settings-security-row__toggle').click();
    const text = row(doc, 'execute').textContent;
    assert.doesNotMatch(text, /You switched the sandbox off/);
    assert.ok(row(doc, 'execute').querySelector('.settings-security-answer--warning'));
  } finally {
    dom.cleanup();
  }
});

test('without safeStorage: "Auto" cannot be the default', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith({ integrity: 'unsigned', encryptionAvailable: false }), {
      state: permissionsState({ encryptionAvailable: false }),
    });
    const doc = dom.document;
    // The warning itself is ToolPermissionsPanel's, in the same header.
    assert.ok(doc.querySelector('#settings-security-header #settings-permissions-integrity'));
    assert.equal(doc.querySelector('#settings-security-mode-options input[value="auto"]').disabled, true);
    assert.equal(doc.querySelector('#settings-security-mode-options input[value="ask-all"]').disabled, false);
  } finally {
    dom.cleanup();
  }
});

test('no folder open: the page says so and has no default to set', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(overviewWith({ root: null }), { state: permissionsState({ workspaceRoot: null, workspaceMode: null }) });
    const doc = dom.document;
    assert.equal(doc.querySelector('#heading-security-workspace > span').textContent, 'No workspace open');
    assert.equal(doc.getElementById('settings-security-workspace-name').hidden, true);
    assert.equal(doc.getElementById('settings-security-mode-row').hidden, true);
    assert.equal(doc.getElementById('settings-security-mode-state').hidden, true);
    assert.match(doc.getElementById('settings-security-scope').textContent, /Open a folder to see its settings/);
    assert.match(doc.getElementById('settings-security-summary').textContent, /^Without a folder Snotra/);
    assert.match(row(doc, 'read').textContent, /folders of switched-on skills/);
  } finally {
    dom.cleanup();
  }
});

test('a live change redraws, keeps the open row open and the focus on its button', async () => {
  const dom = setupRendererDom();
  try {
    const page = await openPage(overviewWith());
    const doc = dom.document;
    const toggle = () => row(doc, 'write').querySelector('.settings-security-row__toggle');
    toggle().click();
    toggle().focus();
    page.setOverview(overviewWith({
      sessionGrants: [{ id: 'g', tool: 'edit_file', classes: ['write'], chatId: 'c', chatTitle: 'Release', current: true, scope: null }],
    }));
    const before = page.api.calls;
    page.toolPermissions.emit();
    await settle();
    assert.equal(page.api.calls, before + 1);
    assert.match(row(doc, 'write').querySelector('.settings-security-row__exceptions').textContent, /1 session allowance/);
    assert.equal(toggle().getAttribute('aria-expanded'), 'true');
    assert.equal(doc.activeElement, toggle());
    assert.match(row(doc, 'write').textContent, /open chat “Release”/);

    // Closed, the panel no longer listens.
    page.panel.close();
    page.toolPermissions.emit();
    await settle();
    assert.equal(page.api.calls, before + 1);
  } finally {
    dom.cleanup();
  }
});

test('an unreadable state says so instead of drawing an empty page', async () => {
  const dom = setupRendererDom();
  try {
    await openPage(null);
    const doc = dom.document;
    const error = doc.getElementById('settings-security-error');
    assert.equal(error.classList.contains('hidden'), false);
    assert.match(error.textContent, /could not be read/);
    assert.equal(doc.querySelectorAll('.settings-security-row').length, 0);
  } finally {
    dom.cleanup();
  }
});

test('German: the same page, derived and complete', async () => {
  const dom = setupRendererDom();
  try {
    const { setLocale } = await importRenderer('i18n.js');
    setLocale('de');
    try {
      await openPage(overviewWith());
      const doc = dom.document;
      assert.equal(
        doc.getElementById('settings-security-summary').textContent,
        'In diesem Workspace gilt: Snotra liest ohne Rückfrage, fragt vor jeder Dateiänderung, fragt vor jedem Befehl (in der Sandbox) und fragt, bevor sie Web oder MCP nutzt.'
      );
      assert.deepEqual(pill(doc, 'read'), ['Läuft']);
      assert.match(row(doc, 'read').textContent, /„Intelligent“ liest/);
      assert.doesNotMatch(doc.getElementById('panel-settings-security').textContent, /security\./, 'no raw key left');
    } finally {
      setLocale('en');
      // Every page opened in this file redraws on the change; let it finish
      // while there is still a document.
      await settle();
    }
  } finally {
    dom.cleanup();
  }
});

test('a press still counts when a live update replaced the row in between', async () => {
  const dom = setupRendererDom();
  try {
    const page = await openPage(overviewWith());
    const doc = dom.document;
    const stale = row(doc, 'write').querySelector('.settings-security-row__toggle');
    page.setOverview(overviewWith({ globalRules: [{ id: 'x', effect: 'deny', scope: 'global', root: null, tool: null, riskClass: 'write', pathPattern: 'x/**' }] }));
    page.toolPermissions.emit();
    await settle();
    assert.notEqual(row(doc, 'write').querySelector('.settings-security-row__toggle'), stale, 'the row was redrawn');
    stale.click();
    const fresh = row(doc, 'write').querySelector('.settings-security-row__toggle');
    assert.equal(fresh.getAttribute('aria-expanded'), 'true');
    assert.equal(doc.getElementById(fresh.getAttribute('aria-controls')).hidden, false);
  } finally {
    dom.cleanup();
  }
});

test('an update that changes nothing leaves the rows as they are', async () => {
  const dom = setupRendererDom();
  try {
    const page = await openPage(overviewWith());
    const doc = dom.document;
    const before = row(doc, 'read').querySelector('.settings-security-row__toggle');
    page.toolPermissions.emit();
    await settle();
    assert.equal(row(doc, 'read').querySelector('.settings-security-row__toggle'), before);
  } finally {
    dom.cleanup();
  }
});
