// Settings › Tools › Security in the real app (#1119): the shield next to the
// folder name leads there with the open workspace chosen and its switch
// focused; with encrypted storage, a workspace that is not open is switched
// off through the system dialog, which names it — without it (the Linux
// runner has no keyring), every loosening is refused; on Windows, which has no
// sandbox, the page says so and offers nothing to switch; and the page, the list,
// All workspaces and the program dialog pass axe in both themes. The page's
// own logic is tested on the markup in test/tool-security-panel-dom.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';
import { axeViolations, describeViolations } from './helpers/axe.mjs';

/** Sets the theme as ThemeManager.js does and ends its colour transitions (#1118). */
function useTheme(page, theme) {
  return page.evaluate((value) => {
    if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    void document.body.offsetHeight;
    for (const animation of document.getAnimations()) animation.finish();
  }, theme);
}

async function checkScreen(page, name, findings, context) {
  for (const theme of ['light', 'dark']) {
    await useTheme(page, theme);
    for (const violation of await axeViolations(page, { context })) findings.push({ screen: `${name} (${theme})`, ...violation });
  }
  await useTheme(page, 'light');
}

test('Tools › Security: reached from the shield, changes a workspace that is not open, passes axe', { timeout: 240000 }, async (t) => {
  const model = await startFakeModel();
  t.after(() => model.close?.());
  const base = await makeTempDir('snotra-e2e-toolsec-');
  const open = path.join(base, 'garden-planner');
  const other = path.join(base, 'invoice-tool');
  for (const dir of [open, other]) {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'README.md'), '# Example\n', 'utf8');
  }
  const userDataDir = await makeTempDir('snotra-e2e-toolsec-userdata-');
  await prepareUserData(userDataDir, { workspace: other, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'folder-history.json'), JSON.stringify({ paths: [other, open] }), 'utf8');
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en', shellExecutionEnabled: true }), 'utf8');
  const { app, page } = await launchApp({ userDataDir });
  t.after(() => app.close().catch(() => {}));

  // The native dialogs answer "yes" and keep what they said.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push(options || win);
      return { response: 0 };
    };
  });
  const api = (name, ...args) => page.evaluate(([n, a]) => window.electronAPI[n](...a), [name, args]);

  // invoice-tool gets a host of its own, so it is listed while another folder is open.
  // By name: on Windows the root may come back in another spelling of the same path.
  const openNow = async () => path.basename((await api('getSandboxOverview')).activeRoot || '');
  await poll(async () => (await openNow()) === 'invoice-tool', { what: 'invoice-tool open', timeoutMs: 30000 });
  const windows = process.platform === 'win32';
  const encrypted = !windows && (await api('getSandboxOverview')).encryptionAvailable === true;
  const kept = windows ? null : await api('addSandboxHosts', { hosts: ['pypi.org:443'], scope: 'workspace' });
  if (windows) {
    t.diagnostic('Windows has no sandbox: the page is checked without a switch or allowances');
  } else if (encrypted) {
    assert.equal(kept.ok, true, JSON.stringify(kept));
  } else {
    // Without encrypted storage nothing that loosens can be kept — and none is asked about.
    assert.deepEqual(kept.error, { key: 'permissions.workspaceHosts.error.needsEncryption' });
    assert.equal((await app.evaluate(() => globalThis.__dialogs.length)), 0);
    t.diagnostic('no encrypted storage here: the page is checked without allowances');
  }
  await api('activateFolder', open);
  await poll(async () => (await openNow()) === 'garden-planner', { what: 'garden-planner open' });
  if (encrypted) {
    assert.equal((await api('addSandboxHosts', { hosts: ['gitlab.example.com:22'], scope: 'global' })).ok, true);
    const root = (await api('getSandboxOverview')).activeRoot;
    assert.equal((await api('setProgramAllowance', { program: 'git', domains: ['github.com'], writePaths: [], trustd: false, scope: 'workspace', root })).ok, true);
  }

  // The shield next to the folder name: the page, the open workspace, its
  // switch — on Windows, where there is none, the workspace's heading.
  await poll(() => page.evaluate(() => !document.getElementById('btn-tree-sandbox').hidden), { what: 'the folder shield', timeoutMs: 30000 });
  await page.click('#btn-tree-sandbox');
  await poll(() => page.evaluate((win) => (win
    ? document.activeElement?.id === 'settings-sandbox-detail-title'
    : document.activeElement?.dataset?.focus?.startsWith('sandbox:')), windows), { what: 'the open workspace focused' });
  const landed = await page.evaluate(() => ({
    heading: document.getElementById('settings-panel-heading').textContent,
    chosen: document.querySelector('.settings-sandbox-ws[aria-current="true"] .settings-sandbox-ws__label').textContent,
    list: [...document.querySelectorAll('.settings-sandbox-ws .settings-sandbox-ws__label')].map((node) => node.textContent),
  }));
  assert.deepEqual(landed, {
    heading: 'Tools › Security',
    chosen: 'garden-planner',
    list: encrypted ? ['All workspaces', 'garden-planner', 'invoice-tool'] : ['All workspaces', 'garden-planner'],
  });

  const findings = [];
  await checkScreen(page, 'Tools › Security, open workspace', findings, '#modal-settings');
  if (windows) {
    const detail = await page.evaluate(() => document.getElementById('settings-sandbox-detail').textContent);
    assert.match(detail, /No sandbox on Windows/);
    assert.match(detail, /Nothing to set up on Windows yet/);
    assert.equal(await page.evaluate(() => document.querySelector('#settings-sandbox-detail input[data-action="sandbox"]')), null);
  } else if (!encrypted) {
    // The switch is on and does not offer "off"; the tile says why.
    assert.match(await page.evaluate(() => document.querySelector('#settings-sandbox-detail .settings-sandbox-tile__note').textContent),
      /no encrypted storage/);
  }

  if (encrypted) {
    // invoice-tool is not open: switched off from here, confirmed for that folder.
    await page.evaluate(() => [...document.querySelectorAll('.settings-sandbox-ws')]
      .find((node) => node.textContent.includes('invoice-tool')).click());
    await poll(() => page.evaluate(() => /Not open right now/.test(document.getElementById('settings-sandbox-detail').textContent)), { what: 'invoice-tool chosen' });
    await page.evaluate(() => document.querySelector('#settings-sandbox-detail input[data-action="sandbox"]').click());
    await poll(() => page.evaluate(() => document.querySelector('.settings-sandbox-ws[aria-current="true"] .settings-sandbox-ws__meta')?.textContent === 'Sandbox off'), { what: 'invoice-tool off' });
    const dialog = await app.evaluate(() => globalThis.__dialogs.at(-1));
    assert.equal(dialog.message, 'Run without sandbox in this workspace?');
    assert.match(dialog.detail, /invoice-tool, shell_execute and run_python/, 'the dialog names the folder that is not open');
    const overview = await api('getSandboxOverview');
    const byName = (name) => overview.workspaces.find((ws) => path.basename(ws.root) === name);
    assert.equal(byName('invoice-tool').sandboxOff, true);
    assert.equal(byName('garden-planner').sandboxOff, false, 'the open one is untouched');
    await checkScreen(page, 'Tools › Security, sandbox off', findings, '#modal-settings');
  }

  // All workspaces, and the program dialog with "Applies to".
  await page.evaluate(() => document.querySelector('.settings-sandbox-ws[data-key="*"]').click());
  await poll(() => page.evaluate(() => document.getElementById('settings-sandbox-detail-title')?.textContent === 'All workspaces'), { what: 'All workspaces' });
  await checkScreen(page, 'Tools › Security, all workspaces', findings, '#modal-settings');
  if (windows) {
    assert.equal(findings.length, 0, describeViolations(findings));
    return;
  }
  await page.evaluate(() => document.querySelector('#settings-sandbox-detail [data-action="add-program"]').click());
  await poll(() => page.evaluate(() => !document.getElementById('program-allowance-overlay').classList.contains('hidden')), { what: 'the program dialog' });
  assert.equal(await page.evaluate(() => document.getElementById('allowance-scope-global').checked), true, 'from All workspaces, All workspaces is preselected');
  await checkScreen(page, 'the program dialog', findings, '#dialog-program-allowance');

  assert.equal(findings.length, 0, describeViolations(findings));
});
