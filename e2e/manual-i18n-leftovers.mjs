// Look rather than trust (#353): starts the real app and walks through the
// places that were still German in an English interface — in both languages.
// Not a test — a look.
//
//   node e2e/manual-i18n-leftovers.mjs
//
// Native dialogs are drawn by the operating system and cannot be captured
// without screen-recording rights, so the script intercepts what the main
// process hands to `dialog.showMessageBox` / `showOpenDialog` and prints it.
// That covers the whole chain from the language setting to the dialog text.
// The web surfaces are captured as screenshots:
//
//   out/mockup/i18n-leftovers-skills-<locale>.png     Settings › Skills
//   out/mockup/i18n-leftovers-breakdown-<locale>.png  context breakdown
//   out/mockup/i18n-leftovers-update-<locale>.png     update dialog

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-i18n-leftovers-ws-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-i18n-leftovers-userdata-'));
await mkdir(SHOTS, { recursive: true });

// Two broken folder skills, so Settings › Skills has reasons to show, and a
// project memory beyond the 8,000-character limit, so its breakdown row says
// it was shortened.
const skills = path.join(workspace, '.agents', 'skills');
await mkdir(path.join(skills, 'broken'), { recursive: true });
await writeFile(path.join(skills, 'broken', 'SKILL.md'), 'No front matter here.\n', 'utf8');
await mkdir(path.join(skills, 'wrong-name'), { recursive: true });
await writeFile(path.join(skills, 'wrong-name', 'SKILL.md'),
  '---\nname: another-name\ndescription: The name does not match the folder.\n---\nBody.\n', 'utf8');
await writeFile(path.join(workspace, '.agents', 'memory.md'),
  `# Memory · project\n\n${'- A remembered sentence that goes on and on.\n'.repeat(220)}`, 'utf8');
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function openSettings() {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'open settings dialog' });
  await wait(400);
}

async function closeSettings() {
  await page.evaluate(() => document.getElementById('btn-settings-close').click());
  await poll(() => page.evaluate(() =>
    document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'closed settings dialog' });
  await wait(300);
}

async function applyLocale(locale) {
  await openSettings();
  await page.evaluate(() =>
    document.querySelector('.settings-nav-item[data-settings-panel="general"]').click());
  await wait(200);
  await page.evaluate((value) => {
    const input = document.querySelector(`#choice-app-locale input[value="${value}"]`);
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, locale);
  await wait(400);
  await closeSettings();
}

try {
  await poll(() => page.evaluate(() =>
    document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });

  // Every native dialog answers "Cancel" and is recorded instead of shown.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push({ kind: 'messageBox', ...(options ?? win) });
      return { response: 1 };
    };
    dialog.showOpenDialog = async (win, options) => {
      globalThis.__dialogs.push({ kind: 'openDialog', ...(options ?? win) });
      return { canceled: true, filePaths: [] };
    };
  });

  // One answer for the chat run that fills the context breakdown.
  model.queueAnswer({ text: 'Done.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });
  await poll(() => page.evaluate(() => document.getElementById('chat-messages').textContent.includes('Done.')
    && document.getElementById('chat-messages').getAttribute('aria-busy') !== 'true'),
    { what: 'finished chat run' });
  await wait(600);

  for (const locale of ['en', 'de']) {
    await applyLocale(locale);

    // --- Native dialogs ----------------------------------------------------
    await app.evaluate(() => { globalThis.__dialogs = []; });
    await page.evaluate(async () => {
      const api = window.electronAPI;
      await api.setToolPermissionMode('auto');
      await api.addToolPermissionRule({ effect: 'allow', riskClass: 'read', pathPattern: 'docs/**' });
      await api.addToolPermissionRule({ effect: 'deny', tool: 'edit_file', pathPattern: '*.md' });
      const state = await api.getToolPermissionState();
      const deny = [...(state.globalRules ?? []), ...(state.workspaceRules ?? [])].find((r) => r.effect === 'deny');
      if (deny) await api.removeToolPermissionRule(deny.id);
      await api.openFolder();
    });
    const dialogs = await app.evaluate(() => globalThis.__dialogs);
    console.log(`\n=== ${locale}: native dialogs ===`);
    for (const d of dialogs) {
      console.log(`- ${d.kind}: ${d.title}`);
      if (d.detail) console.log(`    ${d.detail}`);
      if (d.message && d.message !== d.title) console.log(`    message: ${d.message}`);
      if (d.buttons) console.log(`    buttons: ${d.buttons.join(' | ')}`);
      if (d.buttonLabel) console.log(`    button: ${d.buttonLabel}`);
    }

    // --- Settings › Skills --------------------------------------------------
    await openSettings();
    await page.evaluate(() =>
      document.querySelector('.settings-nav-item[data-settings-panel="skills"]').click());
    await wait(500);
    console.log(`=== ${locale}: Settings › Skills ===`);
    console.log(JSON.stringify(await page.evaluate(() => ({
      groups: [...document.querySelectorAll('.settings-skill-group')].map((li) => li.textContent),
      reasons: [...document.querySelectorAll('.settings-tool-item__badge')].map((b) => `${b.textContent}: ${b.title}`),
    })), null, 2));
    await page.screenshot({ path: path.join(SHOTS, `i18n-leftovers-skills-${locale}.png`) });
    await closeSettings();

    // --- Context breakdown ---------------------------------------------------
    const breakdownOpen = await page.evaluate(() =>
      !document.getElementById('chat-token-breakdown')?.classList.contains('hidden'));
    if (!breakdownOpen) await page.evaluate(() => document.getElementById('chat-token-usage')?.click());
    await wait(400);
    // Unfold the system prompt group: the memory row sits inside it.
    await page.evaluate(() =>
      document.querySelector('#chat-token-breakdown [aria-expanded="false"]')?.click());
    await wait(300);
    console.log(`=== ${locale}: breakdown rows mentioning memory.md ===`);
    console.log(await page.evaluate(() =>
      [...document.querySelectorAll('#chat-token-breakdown *')]
        .filter((el) => el.children.length === 0 && /memory\.md/.test(el.textContent))
        .map((el) => el.textContent.trim())));
    const panel = await page.$('#chat-panel');
    await (panel ?? page).screenshot({ path: path.join(SHOTS, `i18n-leftovers-breakdown-${locale}.png`) });

    // --- Update dialog with a reason from main --------------------------------
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('update:available', {
        updateAvailable: true,
        manual: true,
        currentVersion: '1.8.3',
        latestVersion: '1.9.0',
        isPrerelease: false,
        releaseUrl: 'https://github.com/kkrafft1999/snotra/releases',
        notes: '- Example',
        canSelfUpdate: false,
        installKind: 'linux-package',
        selfUpdateBlockedReason: { key: 'update.reason.package' },
        asset: null,
      });
    });
    await poll(() => page.evaluate(() =>
      !document.getElementById('modal-update').classList.contains('hidden')),
      { what: 'open update dialog' });
    await wait(400);
    console.log(`=== ${locale}: update dialog hint ===`);
    console.log(await page.evaluate(() => document.getElementById('modal-update-hint').textContent));
    await page.screenshot({ path: path.join(SHOTS, `i18n-leftovers-update-${locale}.png`) });
    await page.evaluate(() => document.getElementById('modal-update-close').click());
    await wait(300);
  }

  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop();
  await model.close();
}
