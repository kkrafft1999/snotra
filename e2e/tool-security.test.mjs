// Settings › Tools › Security in the real app (#1119): the shield next to the
// folder name leads there with the open workspace chosen and its switch
// focused; a workspace that is not open is switched off through the system
// dialog, which names it; and the page, the list, All workspaces and the
// program dialog pass axe in both themes. The page's own logic is tested on
// the markup in test/tool-security-panel-dom.test.js.

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
  await poll(async () => (await api('getSandboxOverview')).activeRoot === other, { what: 'invoice-tool open', timeoutMs: 30000 });
  const kept = await api('addSandboxHosts', { hosts: ['pypi.org:443'], scope: 'workspace' });
  assert.equal(kept.ok, true, JSON.stringify(kept));
  await api('activateFolder', open);
  await poll(async () => (await api('getSandboxOverview')).activeRoot === open, { what: 'garden-planner open' });
  assert.equal((await api('addSandboxHosts', { hosts: ['gitlab.example.com:22'], scope: 'global' })).ok, true);
  assert.equal((await api('setProgramAllowance', { program: 'git', domains: ['github.com'], writePaths: [], trustd: false, scope: 'workspace', root: open })).ok, true);

  // The shield next to the folder name: the page, the open workspace, its switch.
  await poll(() => page.evaluate(() => !document.getElementById('btn-tree-sandbox').hidden), { what: 'the folder shield', timeoutMs: 30000 });
  await page.click('#btn-tree-sandbox');
  await poll(() => page.evaluate(() => document.activeElement?.dataset?.focus?.startsWith('sandbox:')), { what: 'the switch of the open workspace focused' });
  const landed = await page.evaluate(() => ({
    heading: document.getElementById('settings-panel-heading').textContent,
    chosen: document.querySelector('.settings-sandbox-ws[aria-current="true"] .settings-sandbox-ws__label').textContent,
    list: [...document.querySelectorAll('.settings-sandbox-ws .settings-sandbox-ws__label')].map((node) => node.textContent),
  }));
  assert.deepEqual(landed, { heading: 'Tools › Security', chosen: 'garden-planner', list: ['All workspaces', 'garden-planner', 'invoice-tool'] });

  const findings = [];
  await checkScreen(page, 'Tools › Security, open workspace', findings, '#modal-settings');

  // invoice-tool is not open: switched off from here, confirmed for that folder.
  await page.evaluate(() => [...document.querySelectorAll('.settings-sandbox-ws')]
    .find((node) => node.textContent.includes('invoice-tool')).click());
  await poll(() => page.evaluate(() => /Not open right now/.test(document.getElementById('settings-sandbox-detail').textContent)), { what: 'invoice-tool chosen' });
  await page.evaluate(() => document.querySelector('#settings-sandbox-detail input[data-action="sandbox"]').click());
  await poll(() => page.evaluate(() => document.querySelector('.settings-sandbox-ws[aria-current="true"] .settings-sandbox-ws__meta')?.textContent === 'Sandbox off'), { what: 'invoice-tool off' });
  const dialog = await app.evaluate(() => globalThis.__dialogs.at(-1));
  assert.equal(dialog.message, 'Run without sandbox in this workspace?');
  assert.ok(dialog.detail.includes(other), 'the dialog names the folder that is not open');
  const overview = await api('getSandboxOverview');
  assert.equal(overview.workspaces.find((ws) => ws.root === other).sandboxOff, true);
  assert.equal(overview.workspaces.find((ws) => ws.root === open).sandboxOff, false, 'the open one is untouched');
  await checkScreen(page, 'Tools › Security, sandbox off', findings, '#modal-settings');

  // All workspaces, and the program dialog with "Applies to".
  await page.evaluate(() => document.querySelector('.settings-sandbox-ws[data-key="*"]').click());
  await poll(() => page.evaluate(() => document.getElementById('settings-sandbox-detail-title')?.textContent === 'All workspaces'), { what: 'All workspaces' });
  await checkScreen(page, 'Tools › Security, all workspaces', findings, '#modal-settings');
  await page.evaluate(() => document.querySelector('#settings-sandbox-detail [data-action="add-program"]').click());
  await poll(() => page.evaluate(() => !document.getElementById('program-allowance-overlay').classList.contains('hidden')), { what: 'the program dialog' });
  assert.equal(await page.evaluate(() => document.getElementById('allowance-scope-global').checked), true, 'from All workspaces, All workspaces is preselected');
  await checkScreen(page, 'the program dialog', findings, '#dialog-program-allowance');

  assert.equal(findings.length, 0, describeViolations(findings));
});
