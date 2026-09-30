// Look instead of trust (#462): starts the real app with three MCP servers —
// one that connects, one that dies on start, one switched off — runs one chat
// turn so they start, opens
// Settings › Security, unfolds "External services" and photographs it, light
// and dark. Not a test — a look.
//
//   node e2e/manual-security-mcp.mjs [en|de] [before]
//
// `before` skips the run: the servers are not connected yet and their tools
// come from what they reported last time (#464).
//
// Result: out/mockup/security-mcp-<locale>[-before]-<theme>.png

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const beforeRun = process.argv.includes('before');
const SHOTS = path.resolve('out/mockup');
const FAKE_SERVER = path.resolve('test/helpers/fake-mcp-server.js');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-security-mcp-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-security-mcp-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
await writeFile(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify({
  servers: [
    { id: 'github', label: 'GitHub', command: process.execPath, args: [FAKE_SERVER, 'ok'], enabled: true, knownTools: ['echo', 'add'] },
    { id: 'heimat', label: 'Heimat', command: process.execPath, args: [FAKE_SERVER, 'die-on-start'], enabled: true },
    { id: 'jira', label: 'Jira', command: 'docker', args: ['run', '-i', '--rm', 'example.org/mcp-jira'], enabled: false, knownTools: ['search'] },
  ],
}), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;

async function shoot(name) {
  await page.evaluate(() => document.querySelector('.settings-security-row[data-risk-class="external"]')
    ?.scrollIntoView({ block: 'start' }));
  await new Promise((r) => setTimeout(r, 400));
  const file = path.join(SHOTS, `security-mcp-${locale}${beforeRun ? '-before' : ''}-${name}.png`);
  await page.locator('#modal-settings .settings-dialog').screenshot({ path: file });
  console.log('shot', file);
}

try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1180, 1500));
  // Servers connect lazily (#106): the first run starts them and brings
  // their tools into the catalog.
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });
  if (!beforeRun) await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });
  if (!beforeRun) await poll(() => model.requests.some((r) => !r.isTitleRequest), { what: 'model asked', timeoutMs: 60_000 });
  if (!beforeRun) await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages .chat-msg.assistant')
    && !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /Einstellungen|Settings/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-security').click());
  await poll(() => page.evaluate(() => document.querySelectorAll('.settings-security-server').length === 3),
    { what: 'three server groups' });
  await page.locator('.settings-security-row__toggle[data-risk-class="external"]').click();
  console.log('groups:\n' + await page.evaluate(() =>
    [...document.querySelectorAll('.settings-security-server')].map((g) => g.innerText.replace(/\s+/g, ' ')).join('\n')));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await shoot(theme);
  }
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
