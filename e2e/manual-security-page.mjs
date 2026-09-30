// Look instead of trust (#448): starts the real app with shell commands on,
// a session approval from a card and an allowance, opens Settings › Security
// and photographs it — closed, with the rows opened, light and dark, and with
// "Always ask" as the workspace default. `none` starts without a folder.
// Not a test — a look.
//
//   node e2e/manual-security-page.mjs [en|de] [none] [narrow]
//
// Result: out/mockup/security-<locale>-<state>.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const withoutFolder = process.argv.includes('none');
const narrow = process.argv.includes('narrow');
const SHOTS = path.resolve('out/mockup');
const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-security-look-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-security-look-userdata-'));
await mkdir(SHOTS, { recursive: true });
await mkdir(path.join(workspace, 'docs'), { recursive: true });
await writeFile(path.join(workspace, 'docs', 'release-notes.md'), 'draft\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
if (withoutFolder) {
  await writeFile(path.join(userDataDir, 'last-folder.json'), JSON.stringify({ path: null }), 'utf8');
}
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({
  appLocale: locale,
  shellExecutionEnabled: true,
  disabledTools: ['fetch_url'],
}), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
const prefix = `security-${locale}${withoutFolder ? '-none' : ''}${narrow ? '-narrow' : ''}`;

function ask(text) {
  return page.evaluate((value) => {
    const input = document.getElementById('chat-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, text);
}

// The panel scrolls inside the dialog; a shot of the element would cut it
// up. Scroll the anchor to the top and take the dialog as it is on screen.
async function shoot(name, anchor = '#panel-settings-security') {
  await page.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: 'start' }), anchor);
  await new Promise((r) => setTimeout(r, 400));
  const file = path.join(SHOTS, `${prefix}-${name}.png`);
  await page.locator('#modal-settings .settings-dialog').screenshot({ path: file });
  console.log('shot', file);
}

try {
  await app.evaluate(({ BrowserWindow }, width) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(width, 1500);
  }, narrow ? 720 : 1180);
  if (!withoutFolder) {
    await poll(async () =>
      (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'drawn tree' });
    model.queueAnswer({ match: 'release notes', toolCalls: [{ name: 'edit_file', arguments: { relative_path: 'docs/release-notes.md', old_string: 'draft', new_string: 'Release notes v1.13' } }] });
    await ask('Update the release notes please.');
    await poll(() => page.evaluate((selector) => {
      const button = [...document.querySelectorAll(selector)].at(-1)?.querySelector('button[data-response="allow-session"]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    }, PENDING), { what: 'card with "allow for this session"', timeoutMs: 30_000 });
    await poll(() => page.evaluate(() =>
      !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'run finished', timeoutMs: 60_000 });
  }

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-security').click());
  await poll(() => page.evaluate(() => document.querySelectorAll('#settings-security-rows .settings-security-row').length === 6),
    { what: 'six rows' });
  // The shell is found by a login shell after the start; the page follows
  // once main says so.
  if (!withoutFolder) {
    await poll(() => page.evaluate(() => !!document.querySelector('.settings-security-row[data-risk-class="execute"] .settings-security-pill--asks')),
      { what: 'shell detected', timeoutMs: 30_000 });
  }
  console.log('summary:', await page.evaluate(() => document.getElementById('settings-security-summary').textContent));
  console.log('rows:\n' + await page.evaluate(() =>
    [...document.querySelectorAll('.settings-security-row__toggle')].map((b) => b.innerText.replace(/\s+/g, ' ')).join('\n')));

  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await shoot(`closed-${theme}`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  for (const riskClass of ['write', 'execute']) {
    await page.locator(`.settings-security-row__toggle[data-risk-class="${riskClass}"]`).click();
  }
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await shoot(`open-write-${theme}`, '.settings-security-row[data-risk-class="write"]');
    await shoot(`open-execute-${theme}`, '.settings-security-row[data-risk-class="execute"]');
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  if (!withoutFolder) {
    await page.evaluate(() => document.querySelector('#settings-security-mode-options input[value="ask-all"]').click());
    await poll(() => page.evaluate(() => /Always ask|Immer fragen/.test(document.getElementById('settings-security-summary').textContent)
      || document.querySelector('.settings-security-row[data-risk-class="read"] .settings-security-pill--asks') !== null),
    { what: 'page follows the new default' });
    await shoot('askall');
  }

  // Keyboard: the link of an open row lands on the card it names.
  const link = page.locator('.settings-security-row[data-risk-class="execute"] [data-security-link]').first();
  await link.focus();
  await page.keyboard.press('Enter');
  console.log('after link:', await page.evaluate(() => ({
    tab: document.querySelector('.settings-nav-item[aria-selected="true"]')?.dataset.settingsPanel,
    focus: document.activeElement?.id,
  })));
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
