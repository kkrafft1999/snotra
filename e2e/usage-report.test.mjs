// The usage report in the real app (#1258): its three ways in, the periods,
// both dimensions with their rows unfolded, a chat opened from it in another
// folder, a real turn booked on today — and axe over the dialog, light and dark.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';
import { axeViolations, describeViolations } from './helpers/axe.mjs';
import { dayBefore, writeUsageHistory } from './helpers/usage-fixture.mjs';

const shown = (page) => page.evaluate(() => !document.getElementById('modal-usage').classList.contains('hidden'));
const totals = (page) => page.evaluate(() => [...document.querySelectorAll('#usage-summary .usage-dialog__total-value')].map((el) => el.textContent));
const rowNames = (page) => page.evaluate(() => [...document.querySelectorAll('#usage-table .usage-table__row .usage-table__name-main')].map((el) => el.textContent));
const pick = (page, name, value) => page.click(`input[name="${name}"][value="${value}"]`, { force: true });

/** The report as main builds it, straight over the bridge. */
const report = (page, period) => page.evaluate((p) => window.electronAPI.getUsageReport(p), period);

async function useTheme(page, theme) {
  await page.evaluate((value) => {
    if (value === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
    void document.body.offsetHeight;
    for (const animation of document.getAnimations()) {
      if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish();
    }
  }, theme);
}

test('the usage report: three ways in, periods, both dimensions, a chat opened from it, a turn of today', { timeout: 240000 }, async (t) => {
  const model = await startFakeModel();
  const parent = await realpath(await makeTempDir('snotra-usage-'));
  const folders = ['garden-planner', 'website-relaunch', 'thesis'].map((name) => path.join(parent, name));
  for (const folder of folders) await mkdir(folder, { recursive: true });
  await writeFile(path.join(folders[0], 'README.md'), '# Garden Planner\n', 'utf8');
  await writeFile(path.join(folders[1], 'README.md'), '# Website relaunch\n', 'utf8');
  const userDataDir = await makeTempDir('snotra-usage-userdata-');
  await prepareUserData(userDataDir, { workspace: folders[0], modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'folder-history.json'), JSON.stringify({ paths: folders }), 'utf8');
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  await writeFile(path.join(userDataDir, 'model-prices.json'),
    JSON.stringify({ overrides: { 'fake-model': { input: 1.25e-6, output: 10e-6 } } }), 'utf8');
  const now = Date.now();
  const { chats } = await writeUsageHistory(userDataDir, { folders, locale: 'en', now });

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { app, page } = snotra;
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0), { what: 'tree' });

  // ── Main's figures: periods by the day spent, old chats on their last save ──
  const all = await report(page, { from: null, to: null });
  assert.equal(all.totals.chats, 11, 'every chat of the history');
  const sowing = chats.find((c) => c.title === 'Sowing calendar as JSON').id;
  const week = await report(page, { from: dayBefore(now, 6), to: dayBefore(now, 0) });
  assert.equal(week.totals.chats, 5);
  assert.equal(week.chats.find((c) => c.id === sowing).rounds, 7, 'only the turn inside the week, not the one three days before');
  assert.equal(all.chats.find((c) => c.id === sowing).rounds, 10);
  const overview = all.chats.find((c) => c.title === 'Garden Planner overview');
  assert.equal(overview.lastDate, dayBefore(now, 20), 'a chat without days counts on its last save');
  assert.ok(all.totals.unpricedRounds > 0 && all.totals.usd > 0);
  assert.equal(all.workspaces.find((w) => w.workspaceRoot === null).chats, 1, 'chats without a folder are a group');

  // ── The sidebar button: focus moves in, Escape closes, focus comes back ──
  await page.focus('#btn-sidebar-usage');
  await page.keyboard.press('Enter');
  await poll(async () => (await shown(page)) && (await rowNames(page)).length > 0, { what: 'report open with rows' });
  assert.equal(await page.evaluate(() => document.activeElement?.closest('#modal-usage') !== null), true, 'focus in the dialog');
  assert.equal(await page.evaluate(() => document.activeElement.value), 'last30');
  assert.deepEqual((await totals(page)).slice(2), ['10'], '30 days: the chat of five weeks ago is out');
  assert.match((await totals(page))[0], /^~\$\d+\.\d\d\+$/, 'an estimate, partial');
  assert.deepEqual((await rowNames(page)).slice(0, 2), ['gpt-5', 'claude-sonnet-4-5']);
  const cells = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#usage-table .usage-table__row')]
    .map((row) => [row.querySelector('.usage-table__name-main').textContent, row.querySelector('.usage-table__cost').textContent])));
  assert.equal(cells['acme/reviewer-large'], '–no price', 'an unknown price is a dash, never $0.00');
  assert.equal(cells['qwen3:14b'], '$0.00local', 'a local model costs nothing and says why');
  assert.match(await page.evaluate(() => document.querySelector('.usage-dialog__estimate').textContent), /LiteLLM table of/);
  const bars = await page.evaluate(() => document.querySelectorAll('.usage-chart__slot').length);
  assert.equal(bars, 30, 'a bar per day');

  // The arrow keys walk the periods.
  await page.keyboard.press('ArrowLeft');
  await poll(async () => (await totals(page))[2] === '5', { what: '7 days by keyboard' });
  assert.match(await page.evaluate(() => document.getElementById('usage-range').textContent), /\d/);
  await pick(page, 'usage-period', 'all');
  await poll(async () => (await totals(page))[2] === '11', { what: 'all time' });
  await pick(page, 'usage-period', 'custom');
  await page.fill('#usage-from', '2020-01-01');
  await page.fill('#usage-to', '2020-01-31');
  await page.dispatchEvent('#usage-to', 'change');
  await poll(() => page.evaluate(() => /Nothing spent in this period/.test(document.getElementById('usage-state').textContent)),
    { what: 'an empty custom range' });
  assert.equal(await page.evaluate(() => document.getElementById('usage-report').hidden), true);
  await pick(page, 'usage-period', 'last30');
  await poll(async () => (await totals(page))[2] === '10', { what: 'back to 30 days' });

  await page.keyboard.press('Escape');
  await poll(async () => !(await shown(page)), { what: 'closed with Escape' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-sidebar-usage', 'focus back where it came from');

  // ── View › Usage & Cost…, the shortcut on it ──
  const accelerator = await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((entry) => entry.label === 'Usage & Cost…');
      if (item) {
        item.click();
        return item.accelerator;
      }
    }
    return null;
  });
  assert.equal(accelerator, 'CmdOrCtrl+Shift+K');
  await poll(() => shown(page), { what: 'opened from the menu' });

  // ── By workspace, a row unfolded, its chats, and axe ──
  await pick(page, 'usage-group', 'workspaces');
  await poll(async () => (await rowNames(page)).includes('Without a folder'), { what: 'workspace rows' });
  assert.deepEqual((await rowNames(page)).slice(0, 2), ['garden-planner', 'website-relaunch']);
  const website = page.locator('#usage-table .usage-table__group', { hasText: 'website-relaunch' });
  await website.locator('.usage-table__disclosure').click();
  await poll(() => website.evaluate((group) => [...group.querySelectorAll('.usage-table__child')].every((row) => !row.hidden)
    && group.querySelector('.usage-table__disclosure').getAttribute('aria-expanded') === 'true'), { what: 'models of the folder' });
  assert.deepEqual(await website.evaluate((group) => [...group.querySelectorAll('.usage-table__child .usage-table__name-main')].map((el) => el.textContent)),
    ['claude-sonnet-4-5', 'gpt-5', 'gpt-5-mini', 'acme/reviewer-large']);
  await website.locator('.usage-table__chats').click();
  await poll(() => website.evaluate((group) => group.querySelectorAll('.usage-chats__item').length === 3), { what: 'the folder\'s chats' });
  assert.equal(await page.evaluate(() => document.activeElement.classList.contains('usage-table__chats')), true, 'the focus stays on the button');
  await page.click('.usage-chart__toggle');
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.usage-chart__table'))), { what: 'the chart as a table' });

  const findings = [];
  for (const theme of ['light', 'dark']) {
    await useTheme(page, theme);
    for (const violation of await axeViolations(page, { context: '#modal-usage' })) findings.push({ theme, ...violation });
  }
  await useTheme(page, 'light');
  assert.equal(findings.length, 0, describeViolations(findings));

  // ── Open a chat of another folder: the folder switches, the chat shows ──
  const target = chats.find((c) => c.title === 'Navigation for the new site');
  await website.locator('.usage-chats__item', { hasText: target.title }).locator('.usage-chats__open').click();
  await poll(async () => !(await shown(page)), { what: 'the report closes' });
  await poll(() => page.evaluate((name) => document.getElementById('workspace-header')?.textContent.includes(name)
    || document.getElementById('btn-workspace')?.textContent.includes(name), 'website-relaunch'), { what: 'the folder switched' });
  await poll(() => page.evaluate((title) => document.getElementById('chat-messages').textContent.includes(title), target.title),
    { what: 'the chat on screen' });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'chat-input');

  // ── A real turn counts on today ──
  // The history column is closed; the button does what File › New Chat does.
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await poll(() => page.evaluate(() => !document.getElementById('chat-messages').textContent.includes('Navigation for the new site')),
    { what: 'a new chat' });
  model.queueAnswer({ match: 'USAGE-1', text: 'Done.' });
  await sendChat(page, 'USAGE-1 Count me in.', { t });
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')),
    { what: 'run finished' });
  await poll(async () => (await report(page, { from: dayBefore(Date.now(), 0), to: dayBefore(Date.now(), 0) })).chats
    .some((c) => c.models.some((m) => m.model === 'fake-model')), { what: 'today\'s turn in the report' });
  const today = await report(page, { from: dayBefore(Date.now(), 0), to: dayBefore(Date.now(), 0) });
  const turn = today.chats.find((c) => c.models.some((m) => m.model === 'fake-model'));
  assert.equal(turn.workspaceRoot, folders[1]);
  assert.equal(turn.lastDate, dayBefore(Date.now(), 0));
  assert.ok(turn.usd > 0, 'priced with the price of its own');
});
