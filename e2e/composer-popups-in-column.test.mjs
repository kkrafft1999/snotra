// The two popups in the composer bar stay inside the chat column (#812). The
// column cuts off whatever reaches past it, and at its default width of 320 px
// the mode menu — 340 px wide from the pill's left edge — lost its right part:
// descriptions cut mid-word, the settings link out of reach.
//
// Both menus are opened at the default, the narrowest and the widest column
// the chat divider allows, moved there by keyboard as a user would. Each
// has to fit inside the column with its contents inside itself; where there is
// room it opens flush with its pill. The model menu gets an entry with a long
// name, the case the issue asked to check as well.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const LONG_NAME = 'qwen3-coder-480b-a35b-instruct-mlx-community-8bit-with-a-much-longer-name';

const MENUS = [
  { name: 'mode menu', button: 'btn-chat-tool-mode', menu: 'chat-tool-mode-menu', wrap: 'chat-tool-mode-wrap' },
  { name: 'model menu', button: 'btn-chat-model-picker', menu: 'chat-model-menu', wrap: 'chat-model-picker-wrap' },
];

// The chat lies right of its divider: End takes it to its minimum, Home to its
// maximum.
const LAYOUTS = [
  { name: 'default', key: null },
  { name: 'narrowest', key: 'End' },
  { name: 'widest', key: 'Home' },
];

async function moveChatDivider(page, key) {
  await page.evaluate(async (key) => {
    document.getElementById('chat-divider').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, key);
}

/** Opens one menu and measures it against the chat column. */
function measure(page, { button, menu, wrap }) {
  return page.evaluate(async ({ button, menu, wrap }) => {
    const panel = document.getElementById('chat-panel');
    const popup = document.getElementById(menu);
    if (!popup.classList.contains('hidden')) document.getElementById(button).click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.getElementById(button).click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const column = panel.getBoundingClientRect();
    const box = popup.getBoundingClientRect();
    const anchor = (document.getElementById(wrap) || popup.parentElement).getBoundingClientRect();
    // Every visible element inside the popup, measured against the popup.
    const spill = [...popup.querySelectorAll('*')]
      .filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.left < box.left - 0.5 || r.right > box.right + 0.5))
      .map(({ el, r }) => `${el.className || el.nodeName} ${Math.round(r.left)}–${Math.round(r.right)}`);
    const open = !popup.classList.contains('hidden');
    document.getElementById(button).click();
    return {
      open,
      column: { left: column.left, right: column.right, width: column.width },
      box: { left: box.left, right: box.right, width: box.width },
      anchorLeft: anchor.left,
      spill,
    };
  }, { button, menu, wrap });
}

test('both composer popups stay inside the chat column at every width', { timeout: 120000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-popups-');
  const userDataDir = await makeTempDir('snotra-popups-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  const configPath = path.join(userDataDir, 'llm-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.presets.push({
    ...config.presets[0],
    id: randomUUID(),
    model: LONG_NAME,
    connection: { ...config.presets[0].connection, displayName: LONG_NAME },
  });
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page, app } = snotra;
  // The window the issue was measured in. The chat column follows the window
  // by half its change (#637), so a resize that lands after the layout started
  // would move it off its default; a reload starts the layout at this size.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
  await poll(() => page.evaluate(() => window.innerWidth === 1280), { what: 'window at 1280 px' });
  await page.reload();
  await poll(async () => (await page.evaluate(() => window.electronAPI.getToolPermissionState()))?.workspaceRoot,
    { what: 'permission state with a workspace' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-chat-model-picker').classList.contains('hidden')),
    { what: 'model pill' });
  await poll(() => page.evaluate(() => Math.round(document.getElementById('chat-panel').getBoundingClientRect().width) === 320),
    {
      what: 'chat column at its default width',
      explain: () => page.evaluate(() => ({
        window: [window.innerWidth, window.innerHeight],
        chat: document.getElementById('chat-panel').getBoundingClientRect().width,
      })),
    });

  const widths = [];
  for (const layout of LAYOUTS) {
    if (layout.key) await moveChatDivider(page, layout.key);
    for (const spec of MENUS) {
      const m = await measure(page, spec);
      widths.push(Math.round(m.column.width));
      const at = `${spec.name} in the ${layout.name} column: ${JSON.stringify(m)}`;
      assert.equal(m.open, true, `${at} — opens`);
      assert.ok(m.box.left >= m.column.left - 0.5, `${at} — left edge inside the column`);
      assert.ok(m.box.right <= m.column.right + 0.5, `${at} — right edge inside the column`);
      assert.deepEqual(m.spill, [], `${at} — nothing reaches out of the menu`);
      if (layout.name === 'widest' && spec.name === 'mode menu') {
        assert.ok(Math.abs(m.box.left - m.anchorLeft) < 1, `${at} — flush with its pill where there is room`);
      }
    }
  }
  // The column narrows under the open mode menu (the window is resized, say):
  // the menu follows. The divider is the widest here, from the last layout.
  const followed = await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.getElementById('btn-chat-tool-mode').click();
    await frame();
    document.getElementById('chat-divider').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await frame();
    await frame();
    const column = document.getElementById('chat-panel').getBoundingClientRect();
    const popup = document.getElementById('chat-tool-mode-menu');
    const box = popup.getBoundingClientRect();
    const open = !popup.classList.contains('hidden');
    document.getElementById('btn-chat-tool-mode').click();
    return { open, column: [column.left, column.right], box: [box.left, box.right] };
  });
  assert.equal(followed.open, true, `menu still open: ${JSON.stringify(followed)}`);
  assert.ok(followed.box[0] >= followed.column[0] - 0.5 && followed.box[1] <= followed.column[1] + 0.5,
    `menu follows a column that narrows while it is open: ${JSON.stringify(followed)}`);

  // The three layouts really differ: default, minimum, and room for the menu.
  assert.equal(widths[0], 320, `default column: ${widths}`);
  assert.equal(widths[2], 260, `narrowest column: ${widths}`);
  assert.ok(widths[4] > 360, `widest column: ${widths}`);
});
