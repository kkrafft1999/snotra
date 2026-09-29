// Look instead of trust (#447): starts the real app, grants two session
// approvals from cards — a change and a sensitive read — and photographs the
// list in Settings › Permissions, light and dark, then once more after one of
// them was revoked, and the empty state.
// Not a test — a look.
//
//   node e2e/manual-session-grants.mjs [en|de]
//
// Result: out/mockup/session-grants-<locale>-{light,dark,revoked,empty}.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
const PENDING = '#chat-messages .chat-approval-card[data-state="pending"]';

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-grants-look-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-grants-look-userdata-'));
await mkdir(SHOTS, { recursive: true });
await mkdir(path.join(workspace, 'docs'), { recursive: true });
await writeFile(path.join(workspace, 'docs', 'release-notes.md'), 'draft\n', 'utf8');
await writeFile(path.join(workspace, '.env'), 'TOKEN=example\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

function ask(text) {
  return page.evaluate((value) => {
    const input = document.getElementById('chat-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, text);
}

async function allowForSession() {
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

async function shoot(name) {
  await new Promise((r) => setTimeout(r, 300));
  await page.locator('#settings-grants-card').screenshot({ path: path.join(SHOTS, `session-grants-${locale}-${name}.png`) });
}

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  model.queueAnswer({ match: 'release notes', toolCalls: [{ name: 'edit_file', arguments: { relative_path: 'docs/release-notes.md', old_string: 'draft', new_string: 'Release notes v1.13' } }] });
  await ask('Update the release notes please.');
  await allowForSession();
  model.queueAnswer({ match: 'environment', toolCalls: [{ name: 'read_file_text', arguments: { relative_path: '.env' } }] });
  await ask('Check the environment file please.');
  await allowForSession();

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-permissions').click());
  await poll(() => page.evaluate(() => document.querySelectorAll('#settings-grants .settings-grant').length === 2),
    { what: 'two approvals listed' });
  await page.evaluate(() => document.getElementById('settings-grants-card').scrollIntoView({ block: 'center' }));
  console.log('list:', await page.evaluate(() => document.getElementById('settings-grants').innerText));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await shoot(theme);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });

  await page.locator('#settings-grants button[data-grant-id]').first().focus();
  await page.keyboard.press('Enter');
  await poll(() => page.evaluate(() => document.querySelectorAll('#settings-grants .settings-grant').length === 1),
    { what: 'one approval left' });
  console.log('focus after revoke:', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')));
  await shoot('revoked');

  await page.evaluate(() => document.getElementById('btn-grants-revoke-all').click());
  await poll(() => page.evaluate(() => !document.getElementById('settings-grants-empty').classList.contains('hidden')),
    { what: 'empty state' });
  await shoot('empty');
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
