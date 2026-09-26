// Look instead of trust (#408): starts the real app with shell_execute on and
//  1. adds a program allowance through Settings › Tools — the dialog, the
//     native confirmation (answered by a stub in main, its text printed), the
//     list — and photographs the empty card, the dialog and the list,
//  2. photographs the approval card with the allowance applied, follows its
//     link and reports where the focus landed,
//  3. approves the run and reports what the model was told: whether the
//     program got through the sandbox with the allowance, and whether its
//     token cache was written,
//  4. photographs the card of a piped command, where the allowance stays off.
// Not a test — a look. It runs a real program with a real login, so it needs
// both; by default `ms-todo-cli` and its cache folder. Run it outside the
// Claude Code sandbox, or the app's own sandbox cannot start (macOS does not
// nest them).
//
//   node e2e/manual-program-allowances.mjs [en|de] [program] [cache folder] [domains]
//
// Result: out/mockup/allowances-<locale>-*.png

import { mkdtemp, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const program = process.argv[3] || 'ms-todo-cli';
const cacheFolder = process.argv[4] || path.join(homedir(), '.ai-workplace', 'config', 'ms-todo-cli');
const domains = (process.argv[5] || 'login.microsoftonline.com graph.microsoft.com').split(/[\s,]+/).filter(Boolean);
const SHOTS = path.resolve('out/mockup');
const RUN = 'Show my to-do lists please.';
const PIPED = 'Only the first list please.';

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-allowance-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-allowance-userdata-'));
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
const shot = (name) => path.join(SHOTS, `allowances-${locale}-${name}.png`);
const pause = (ms = 350) => new Promise((r) => setTimeout(r, ms));
const mtime = async (file) => stat(file).then((s) => s.mtime.toISOString(), () => 'missing');

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
  { what: 'run finished', timeoutMs: 90_000 });
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

async function type(id, value) {
  await page.evaluate(({ id: target, value: text }) => {
    const input = document.getElementById(target);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, { id, value });
}

function pendingCard() {
  return page.locator('#chat-messages .chat-approval-card[data-state="pending"]').last();
}

function lastToolResult() {
  return model.requests
    .filter((r) => !r.isTitleRequest)
    .flatMap((r) => r.body?.messages || [])
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .at(-1) || '';
}

try {
  // Native dialogs: the confirmation says yes, the folder picker picks the cache.
  await app.evaluate(({ dialog }, folder) => {
    globalThis.__dialogs = [];
    dialog.showMessageBox = async (win, options) => {
      globalThis.__dialogs.push(options || win);
      return { response: 0 };
    };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, cacheFolder);

  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // 1. The card, empty; then the dialog, filled in; then the list.
  await openToolsSettings();
  await poll(() => page.evaluate(() => !document.getElementById('settings-allowances-card').hidden),
    { what: 'allowances card', timeoutMs: 30_000 });
  await page.evaluate(() => {
    for (const d of document.querySelectorAll('#settings-allowances-card details')) d.open = true;
    document.getElementById('settings-allowances-card').scrollIntoView({ block: 'center' });
  });
  await themed('card-empty', (file) => page.locator('#settings-allowances-card').screenshot({ path: file }));

  await page.evaluate(() => document.getElementById('btn-add-program-allowance').click());
  await poll(() => page.evaluate(() => !document.getElementById('program-allowance-overlay').classList.contains('hidden')),
    { what: 'allowance dialog' });
  console.log('focus in the dialog:', await page.evaluate(() => document.activeElement?.id));
  await type('allowance-field-program', program);
  const found = await poll(() => page.evaluate(() => {
    const text = document.getElementById('allowance-program-status').textContent;
    return /…|\.\.\./.test(text) ? null : text;
  }), { what: 'program looked up' });
  console.log('program field:', found);
  await type('allowance-field-domains', `${domains.join('\n')}\nnot_a_host`);
  await page.evaluate(() => document.getElementById('allowance-field-domains').dispatchEvent(new Event('blur')));
  console.log('domain complaint:', await page.evaluate(() => document.getElementById('allowance-domains-invalid').textContent));
  await themed('dialog-invalid', (file) => page.locator('#dialog-program-allowance').screenshot({ path: file }));
  await type('allowance-field-domains', domains.join('\n'));
  await page.evaluate(() => document.getElementById('btn-allowance-folder-add').click());
  await poll(() => page.evaluate(() => document.querySelectorAll('#allowance-folder-list li').length === 1),
    { what: 'folder in the list' });
  await page.evaluate(() => {
    const box = document.getElementById('allowance-field-trustd');
    if (!box.closest('[hidden]') && !box.checked) box.click();
  });
  await themed('dialog', (file) => page.locator('#dialog-program-allowance').screenshot({ path: file }));

  await page.evaluate(() => document.getElementById('btn-program-allowance-save').click());
  await poll(() => page.evaluate(() => document.getElementById('program-allowance-overlay').classList.contains('hidden')
    && document.querySelectorAll('#settings-allowance-list .allowance-row').length === 1),
  { what: 'saved allowance', timeoutMs: 20_000 });
  const confirm = await app.evaluate(() => globalThis.__dialogs.at(-1));
  console.log('native dialog:', JSON.stringify({ message: confirm?.message, detail: confirm?.detail, buttons: confirm?.buttons }));
  console.log('focus after saving:', await page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent));
  await pause(400);
  await themed('card', (file) => page.locator('#settings-allowances-card').screenshot({ path: file }));
  console.log('row:', await page.evaluate(() => document.querySelector('#settings-allowance-list .allowance-row').textContent.replace(/\s+/g, ' ')));
  await closeSettings();

  // 2. The approval card of a run the allowance applies to, and its link.
  model.queueAnswer({ match: RUN, toolCalls: [{ name: 'shell_execute', arguments: { command: `${program} lists` } }] });
  await ask(RUN);
  await poll(() => page.evaluate(() => !!document.querySelector(
    '#chat-messages .chat-approval-card[data-state="pending"] .chat-approval-card__allowance')), { what: 'card with the allowance', timeoutMs: 30_000 });
  console.log('card:', await pendingCard().evaluate((el) => el.textContent.replace(/\s+/g, ' ').slice(0, 600)));
  await themed('approval', (file) => pendingCard().screenshot({ path: file }));
  await pendingCard().evaluate((el) => el.querySelector('.chat-approval-card__allowance button').click());
  await poll(() => page.evaluate(() => !!document.activeElement?.closest?.('#settings-allowances-card')),
    { what: 'focus in the allowance list' });
  console.log('link focused:', await page.evaluate(() => document.activeElement.getAttribute('aria-label')));
  await closeSettings();

  // 3. The run itself.
  const cacheFile = path.join(cacheFolder, '.token_cache.json');
  const before = await mtime(cacheFile);
  await pendingCard().evaluate((el) => el.querySelector('button[data-response="allow-once"]').click());
  await idle();
  const result = lastToolResult();
  let parsed = null;
  try { parsed = JSON.parse(result); } catch { /* printed raw below */ }
  console.log('exit code:', parsed?.exit_code);
  console.log('stdout:', String(parsed?.stdout ?? '').trim().split('\n').slice(0, 6).join(' | '));
  console.log('stderr:', String(parsed?.stderr ?? result).trim().slice(0, 700));
  console.log('sandbox as the model read it:', JSON.stringify(parsed?.sandbox));
  console.log(`token cache: ${before} → ${await mtime(cacheFile)}`);

  // 4. A piped command: the allowance stays off, and the card says why.
  model.queueAnswer({ match: PIPED, toolCalls: [{ name: 'shell_execute', arguments: { command: `${program} lists | head -3` } }] });
  await ask(PIPED);
  await poll(() => page.evaluate(() => !!document.querySelector(
    '#chat-messages .chat-approval-card[data-state="pending"] .chat-approval-card__allowance')), { what: 'card with the skipped allowance', timeoutMs: 30_000 });
  console.log('skipped card:', await pendingCard().evaluate((el) => el.querySelector('.chat-approval-card__allowance').textContent));
  await themed('approval-skipped', (file) => pendingCard().screenshot({ path: file }));
  await pendingCard().evaluate((el) => el.querySelector('button[data-response="deny"]').click());
  await idle();
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
