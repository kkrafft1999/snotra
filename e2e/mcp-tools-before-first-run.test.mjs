// #464 in the running app: before any chat run the Security page lists the
// MCP tools a server reported last time, a tool switched off there is not
// offered in the first run, and after the run the real definition takes the
// remembered one's place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const FAKE_SERVER = path.resolve('test/helpers/fake-mcp-server.js');
const GROUP = '.settings-security-row[data-risk-class="external"] .settings-security-server[data-mcp-server="github"]';

async function openSecurityPage(app, page) {
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
}

const groupText = (page) => page.evaluate((selector) => document.querySelector(selector)?.innerText ?? '', GROUP);

test('an MCP tool switched off before the first run is not offered in it', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-mcp-first-run-'));
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-mcp-first-run-userdata-'));
  await writeFile(path.join(workspace, 'README.md'), 'one\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  // Connected in an earlier session: the server remembers what it reported.
  await writeFile(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify({
    servers: [{
      id: 'github', label: 'GitHub', command: process.execPath, args: [FAKE_SERVER, 'ok'],
      enabled: true, knownTools: ['echo', 'add'],
    }],
  }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(userDataDir, { recursive: true, force: true });
  });
  const { app, page } = snotra;
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  // Before any run: not connected, and both tools listed with their switches.
  await openSecurityPage(app, page);
  await page.locator('.settings-security-row__toggle[data-risk-class="external"]').click();
  await poll(async () => /not connected yet/.test(await groupText(page)), { what: 'server not connected yet' });
  const before = await groupText(page);
  assert.match(before, /mcp__github__echo/);
  assert.match(before, /mcp__github__add/);
  assert.match(before, /Known from the last connection to “GitHub”/);

  // Switched off here, it applies at once — no run needed.
  await page.locator(`${GROUP} input[data-tool-switch="mcp__github__echo"]`).click();
  await poll(() => page.evaluate(async () =>
    (await window.electronAPI.getUIPrefs()).disabledTools?.includes('mcp__github__echo') === true),
  { what: 'switch saved' });
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings closed' });

  // The first run offers the tool that stayed on, not the one switched off.
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });
  await poll(() => model.requests.some((r) => !r.isTitleRequest && Array.isArray(r.body.tools)),
    { what: 'model asked', timeoutMs: 60_000 });
  const offered = model.requests.find((r) => !r.isTitleRequest && Array.isArray(r.body.tools))
    .body.tools.map((tool) => tool.function?.name);
  assert.ok(offered.includes('mcp__github__add'), `offered: ${offered.join(', ')}`);
  assert.ok(!offered.includes('mcp__github__echo'), `offered: ${offered.join(', ')}`);
  await poll(() => page.evaluate(() => !!document.querySelector('#chat-messages .chat-msg.assistant')
    && !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
  { what: 'run finished', timeoutMs: 60_000 });

  // After the run the server is connected and the real definitions are shown.
  await openSecurityPage(app, page);
  await poll(async () => /connected · 2 tools/.test(await groupText(page)), { what: 'server connected' });
  const after = await groupText(page);
  assert.doesNotMatch(after, /Known from the last connection/);
  assert.match(after, /mcp__github__echo/);
  assert.equal(await page.locator(`${GROUP} input[data-tool-switch="mcp__github__echo"]`).isChecked(), false);
});
