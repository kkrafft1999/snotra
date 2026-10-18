// Look instead of trust (#1119): starts the real app with three workspaces
// and photographs Settings › Tools › Security in every state the decision
// names — the open workspace with programs and hosts, one with the sandbox
// off, a folder that is gone, All workspaces, the program dialog with
// "Applies to", the host form with a refusal, the line on Tools › Autonomy,
// the page reached from the folder shield, Windows (main's answer replaced,
// since this runs on a Mac), and with `none` the page without an open folder.
// Light and dark each. The native dialogs are answered "yes" by a stub in
// main; their text is printed. Not a test — a look. Run it outside the
// Claude Code sandbox, or the app's own sandbox cannot start.
//
//   node e2e/manual-tool-security.mjs [en|de] [none] [narrow]
//
// Result: out/mockup/tool-security-<locale>[-none][-narrow]-*.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';
import { removeDir } from '../test/helpers/temp-dir.js';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const withoutFolder = process.argv.includes('none');
const narrow = process.argv.includes('narrow');
const SHOTS = path.resolve('out/mockup');
const prefix = `tool-security-${locale}${withoutFolder ? '-none' : ''}${narrow ? '-narrow' : ''}`;
const pause = (ms = 400) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const base = await makeTempDir('snotra-toolsec-');
const garden = path.join(base, 'garden-planner');
const invoices = path.join(base, 'invoice-tool');
const gone = path.join(base, 'old-project');
for (const dir of [garden, invoices, gone]) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'README.md'), '# Example\n', 'utf8');
}
const userDataDir = await makeTempDir('snotra-toolsec-userdata-');
await mkdir(SHOTS, { recursive: true });
await prepareUserData(userDataDir, { workspace: garden, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'folder-history.json'), JSON.stringify({ paths: [garden, invoices, gone] }), 'utf8');
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }), 'utf8');
if (withoutFolder) await writeFile(path.join(userDataDir, 'last-folder.json'), JSON.stringify({ path: null }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function shoot(name, selector = '#modal-settings .settings-dialog') {
  // A scrollIntoView inside may have moved the dialog's own frame.
  await page.evaluate(() => {
    document.getElementById('modal-settings').scrollTop = 0;
    document.scrollingElement.scrollTop = 0;
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    const file = path.join(SHOTS, `${prefix}-${name}-${theme}.png`);
    await page.locator(selector).screenshot({ path: file });
    console.log('shot', file);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

async function openSettings(panel) {
  await page.evaluate(() => document.getElementById('btn-sidebar-settings')?.click());
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')), { what: 'settings dialog' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled), { what: 'settings ready' });
  await page.evaluate((key) => document.getElementById(`tab-settings-${key}`).click(), panel);
  await pause(600);
}

async function closeSettings() {
  await page.evaluate(() => document.getElementById('btn-settings-close')?.click());
  await poll(() => page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden')), { what: 'settings closed' });
}

const choose = (name) => page.evaluate((label) => {
  const item = [...document.querySelectorAll('.settings-sandbox-ws')].find((node) => node.querySelector('.settings-sandbox-ws__label').textContent === label);
  item.click();
}, name);

const describeFocus = () => page.evaluate(() => {
  const el = document.activeElement;
  return el ? `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.dataset?.focus ? ` [${el.dataset.focus}]` : ''} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60)}"` : 'none';
});

try {
  await app.evaluate(({ BrowserWindow }, width) => {
    BrowserWindow.getAllWindows()[0].setSize(width, 1100);
  }, narrow ? 720 : 1280);
  // Answer every native dialog with its first button, and keep what it said.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push(options || win);
      return { response: 0 };
    };
  });
  if (!withoutFolder) {
    await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0, { what: 'drawn tree' });
  } else {
    await pause(1500);
  }

  if (!withoutFolder) {
    // invoice-tool: the sandbox off. old-project: a host kept open, then gone.
    const api = (code, ...args) => page.evaluate(([c, a]) => window.electronAPI[c](...a), [code, args]);
    await api('activateFolder', invoices);
    await pause(500);
    console.log('sandbox off:', JSON.stringify(await api('setWorkspaceSandbox', false)));
    await api('activateFolder', gone);
    await pause(500);
    console.log('host there:', JSON.stringify(await api('addSandboxHosts', { hosts: ['pypi.org:443'], scope: 'workspace' })));
    await api('activateFolder', garden);
    await pause(500);
    await removeDir(gone);
    console.log('program here:', JSON.stringify(await api('setProgramAllowance', { program: 'git', domains: ['github.com', 'api.github.com'], writePaths: [], trustd: false, scope: 'workspace' })));
    console.log('program everywhere:', JSON.stringify(await api('setProgramAllowance', { program: 'curl', domains: ['registry.npmjs.org'], writePaths: [], trustd: true, scope: 'global' })));
    console.log('hosts here:', JSON.stringify(await api('addSandboxHosts', { hosts: ['huggingface.co:443', '*.pytorch.org'], scope: 'workspace' })));
    console.log('host everywhere:', JSON.stringify(await api('addSandboxHosts', { hosts: ['gitlab.example.com:22'], scope: 'global' })));
    const dialogs = await app.evaluate(() => globalThis.__dialogs.map((d) => ({ message: d.message, detail: d.detail })));
    for (const d of dialogs) console.log('dialog:', JSON.stringify(d));
  }

  // 1. The line on Tools › Autonomy.
  await openSettings('security');
  await page.evaluate(() => {
    const toggle = document.querySelector('.settings-security-row__toggle[data-risk-class="execute"]');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  });
  await poll(() => page.evaluate(() => !!document.querySelector('.settings-sandbox-link')), { what: 'sandbox line' });
  await page.evaluate(() => document.querySelector('.settings-sandbox-link').scrollIntoView({ block: 'center' }));
  await shoot('autonomy-line');
  console.log('line:', await page.evaluate(() => document.querySelector('.settings-sandbox-link').innerText.replace(/\s+/g, ' ')));
  // … and where it leads.
  await page.evaluate(() => document.querySelector('.settings-sandbox-link').click());
  await poll(() => page.evaluate(() => !document.getElementById('panel-settings-sandbox').hidden
    && !!document.querySelector('.settings-sandbox-ws[aria-current="true"]')), { what: 'security page' });
  await pause(500);
  console.log('heading:', await page.evaluate(() => document.getElementById('settings-panel-heading').textContent));
  console.log('focus after the line:', await describeFocus());
  await page.evaluate(() => document.querySelector('.settings-dialog__panel-wrap').scrollTo(0, 0));
  await shoot('open-workspace');
  await page.evaluate(() => document.querySelector('.settings-dialog__panel-wrap').scrollTo(0, 99999));
  await shoot('open-workspace-bottom');

  if (!withoutFolder) {
    // 2. A workspace with the sandbox off, not open.
    await choose('invoice-tool');
    await pause();
    await page.evaluate(() => document.querySelector('.settings-dialog__panel-wrap').scrollTo(0, 0));
    await shoot('sandbox-off');
    // 3. A folder that is gone.
    await choose('old-project');
    await pause();
    await shoot('missing');
    // 4. The program dialog from the open workspace, Applies to.
    await choose('garden-planner');
    await pause();
    await page.evaluate(() => document.querySelector('[data-action="add-program"]').click());
    await poll(() => page.evaluate(() => !document.getElementById('program-allowance-overlay').classList.contains('hidden')), { what: 'dialog' });
    await shoot('dialog', '#dialog-program-allowance');
    await page.evaluate(() => document.getElementById('btn-program-allowance-cancel').click());
    // 5. The host form with a refusal.
    await page.evaluate(() => {
      document.querySelectorAll('[data-action="add-host"]')[0].click();
    });
    await pause(200);
    await page.keyboard.type('*.github.io');
    await page.keyboard.press('Enter');
    await pause(600);
    console.log('focus after a refused host:', await describeFocus());
    await page.evaluate(() => {
      const wrap = document.querySelector('.settings-dialog__panel-wrap');
      wrap.scrollTop = document.querySelector('.settings-sandbox-hostform').offsetTop - 200;
    });
    await shoot('host-refused');
    await page.keyboard.press('Escape');
    await pause(200);
    console.log('focus after Escape:', await describeFocus());
  }

  // 6. All workspaces.
  await choose(locale === 'de' ? 'Alle Workspaces' : 'All workspaces');
  await pause();
  await page.evaluate(() => document.querySelector('.settings-dialog__panel-wrap').scrollTo(0, 0));
  await shoot('all');
  await page.evaluate(() => document.querySelector('.settings-dialog__panel-wrap').scrollTo(0, 99999));
  await shoot('all-bottom');
  await closeSettings();

  if (!withoutFolder) {
    // 7. From the folder shield: the switch of the open workspace.
    await page.evaluate(() => document.getElementById('btn-tree-sandbox').click());
    await poll(() => page.evaluate(() => document.activeElement?.dataset?.focus?.startsWith('sandbox:')), { what: 'focus on the switch' });
    console.log('focus after the shield:', await describeFocus());
    await closeSettings();

    // 8. Windows: main's answer replaced with what it says on Windows.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('toolPermissions:getSandboxOverview');
      ipcMain.handle('toolPermissions:getSandboxOverview', async () => ({
        integrity: 'ok', encryptionAvailable: true, platform: 'win32', homeDir: '',
        sandbox: { isolated: false, status: 'unavailable', reason: 'platform', platform: 'win32' },
        activeRoot: 'C:\\Users\\u\\garden-planner', newWorkspaceSandbox: true,
        global: { programs: [], hosts: [] },
        workspaces: [{ root: 'C:\\Users\\u\\garden-planner', open: true, missing: false, sandboxOff: false, programs: [], hosts: [] }],
        sessionGrants: [],
      }));
    });
    await openSettings('sandbox');
    await pause(600);
    await shoot('windows');
    await choose(locale === 'de' ? 'Alle Workspaces' : 'All workspaces');
    await pause();
    await shoot('windows-all');
  }
} finally {
  await app.close().catch(() => {});
  await model.close?.();
}
