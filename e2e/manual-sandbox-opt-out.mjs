// Look instead of trust (#357): starts the real app with shell_execute on and
//  1. photographs the workspace sandbox switch in Settings › Tools, on and off,
//  2. photographs the "Auto" pill red while the sandbox is off,
//  3. photographs the approval card with the reason and the way back, follows
//     the link and reports where the focus landed,
//  4. lets "Auto" run a command that writes outside the workspace and reports
//     whether it got there, and what the model was told.
// The native dialogs are answered "yes" by a stub in main; their text is
// printed. Not a test — a look. Run it outside the Claude Code sandbox, or the
// app's own sandbox cannot start (macOS does not nest them).
//
//   node e2e/manual-sandbox-opt-out.mjs [en|de]
//
// Result: out/mockup/sandbox-optout-<locale>-*.png

import { mkdtemp, mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const CARD = 'List the pull requests please.';
const AUTO = 'Write a file outside please.';
const outsideFile = path.join(homedir(), `snotra-e2e-optout-${process.pid}.txt`);

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-optout-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-optout-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(
  path.join(userDataDir, 'ui-preferences.json'),
  JSON.stringify({ appLocale: locale, shellExecutionEnabled: true }),
  'utf8',
);
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
const shot = (name) => path.join(SHOTS, `sandbox-optout-${locale}-${name}.png`);
const pause = (ms = 350) => new Promise((r) => setTimeout(r, ms));

async function themed(name, take) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause();
    await take(shot(`${name}-${theme}`));
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

function ask(question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

async function idle() {
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });
}

async function openToolsSettings() {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  // Opening finishes asynchronously and then lands on "Models": wait for it
  // (Apply is enabled again at that point), then click until the tools panel
  // is the one on screen.
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled
    && document.getElementById('settings-panel-heading').textContent.trim() !== ''),
  { what: 'settings ready' });
  await pause(800);
  await poll(() => page.evaluate(() => {
    const panel = document.getElementById('panel-settings-tools');
    if (!panel.hidden) return true;
    document.getElementById('tab-settings-tools').click();
    return false;
  }), { what: 'tools panel' });
  await pause(500);
}

async function closeSettings() {
  await page.evaluate(() => document.getElementById('btn-settings-close')?.click());
  await poll(() => page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings closed' });
}

const exists = (p) => stat(p).then(() => true, () => false);

try {
  // Answer every native dialog with its first button, and keep what it said.
  await app.evaluate(({ dialog }) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push(options || win);
      return { response: 0 };
    };
  });

  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // 1. The switch, on.
  await openToolsSettings();
  await poll(() => page.evaluate(() => !document.getElementById('settings-sandbox-card').hidden),
    { what: 'sandbox card', timeoutMs: 30_000 });
  await page.evaluate(() => document.getElementById('settings-sandbox-card').scrollIntoView({ block: 'center' }));
  await pause();
  await page.locator('#settings-sandbox-card').screenshot({ path: shot('switch-on') });
  console.log('isolation line (on):', await page.evaluate(() => document.getElementById('settings-shell-sandbox').textContent));
  await closeSettings();
  // With the sandbox working, "Auto" stays blue.
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('auto'));
  await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'auto'),
    { what: 'auto pill' });
  await pause(600);
  console.log('pill red while isolated:', await page.evaluate(() =>
    document.getElementById('chat-tool-mode-wrap').dataset.unisolated === 'true'));
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('smart'));
  await openToolsSettings();
  await poll(() => page.evaluate(() => !document.getElementById('settings-sandbox-card').hidden),
    { what: 'sandbox card again' });

  // … and off, through the native dialog.
  await page.evaluate(() => document.getElementById('input-workspace-sandbox').click());
  await poll(() => page.evaluate(() => {
    const el = document.getElementById('settings-sandbox-state');
    return !el.hidden && el.classList.contains('error') ? el.textContent : null;
  }), { what: 'switched-off state' });
  const dialog = await app.evaluate(() => globalThis.__dialogs.at(-1));
  console.log('dialog:', JSON.stringify({ message: dialog.message, detail: dialog.detail, buttons: dialog.buttons }));
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('#settings-sandbox-card details')) d.open = true;
    document.getElementById('settings-shell-card').scrollIntoView();
  });
  await themed('settings-off', async (file) => {
    await page.locator('#settings-shell-card').screenshot({ path: file.replace('settings-off', 'shell-card-off') });
    await page.locator('#settings-sandbox-card').screenshot({ path: file });
  });
  console.log('isolation line:', await page.evaluate(() => document.getElementById('settings-shell-sandbox').textContent));
  console.log('switch state:', await page.evaluate(() => document.getElementById('settings-sandbox-state').textContent));
  await closeSettings();

  // 2. "Auto" while the sandbox is off: the pill turns red.
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('auto'));
  await poll(() => page.evaluate(() =>
    document.getElementById('chat-tool-mode-wrap').dataset.unisolated === 'true'), { what: 'red pill' });
  const pill = await page.evaluate(() => {
    const btn = document.getElementById('btn-chat-tool-mode');
    return { title: btn.title, label: btn.getAttribute('aria-label'), color: getComputedStyle(btn).color };
  });
  console.log('pill:', JSON.stringify(pill));
  await themed('pill-auto', (file) => page.locator('#chat-tool-mode-wrap').screenshot({ path: file }));
  const composer = page.locator('#chat-tool-mode-wrap').locator('xpath=ancestor::*[contains(@class,"chat-composer") or contains(@class,"chat-input")][1]');
  if (await composer.count()) await composer.first().screenshot({ path: shot('composer-auto') });

  // 4. In "Auto" the command runs without a card — and without sandbox.
  model.queueAnswer({ match: AUTO, toolCalls: [{ name: 'shell_execute', arguments: { command: `echo x > '${outsideFile}'; echo done` } }] });
  await ask(AUTO);
  await idle();
  const cards = await page.evaluate(() => document.querySelectorAll('#chat-messages .chat-approval-card').length);
  console.log('cards in auto:', cards);
  console.log('outside file written:', await exists(outsideFile));
  const toolResult = model.requests
    .filter((r) => !r.isTitleRequest)
    .flatMap((r) => r.body?.messages || [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .find((c) => c.includes('"sandbox"')) || '';
  console.log('tool result seen by the model:', toolResult.slice(0, 400));

  // 3. Back in "Smart": the card, and its way back.
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('smart'));
  await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'smart'),
    { what: 'smart pill' });
  model.queueAnswer({ match: CARD, toolCalls: [{ name: 'shell_execute', arguments: { command: 'gh pr list --state open' } }] });
  await ask(CARD);
  await poll(() => page.evaluate(() => {
    const el = [...document.querySelectorAll('#chat-messages .chat-approval-card[data-state="pending"]')].at(-1);
    return el?.querySelector('.chat-approval-card__warning-link') ? true : null;
  }), { what: 'card with the way back', timeoutMs: 30_000 });
  const locator = page.locator('#chat-messages .chat-approval-card[data-state="pending"]').last();
  console.log('card:', await locator.evaluate((el) => el.textContent.replace(/\s+/g, ' ').slice(0, 500)));
  await themed('card', (file) => locator.screenshot({ path: file }));
  await locator.evaluate((el) => el.querySelector('.chat-approval-card__warning-link').click());
  await poll(() => page.evaluate(() => document.activeElement?.id === 'input-workspace-sandbox'),
    { what: 'focus on the switch' });
  console.log('link focused:', await page.evaluate(() => document.activeElement.id));
  await page.screenshot({ path: shot('link-target') });
  await closeSettings();
  await page.evaluate(() =>
    document.querySelector('#chat-messages .chat-approval-card[data-state="pending"] button[data-response="deny"]').click());
  await idle();
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(outsideFile, { force: true });
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
