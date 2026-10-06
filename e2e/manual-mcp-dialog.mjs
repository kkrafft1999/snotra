// Look instead of trust: starts the real app, opens the MCP server dialog for
// an existing server and the MCP import dialog, and photographs both in German
// and English, light and dark (#459 — the button row used to sit on the edge).
// Not a test — a look.
//
//   node e2e/manual-mcp-dialog.mjs
//
// Result: out/mockup/mcp-<dialog>-<locale>-<theme>.png

import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-mcp-dialog-');
const userDataDir = await makeTempDir('snotra-mcp-dialog-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
// The command does not exist; the dialog is drawn all the same.
await writeFile(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify({
  servers: [{
    id: 'mcp-heimat', label: 'mcp-heimat', command: 'docker',
    args: ['run', '-i', '--rm', 'example.org/mcp-server/mcp-heimat:latest'], enabled: false,
  }],
}), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

const shoot = async (id, name) => {
  const box = await page.evaluate((id) => {
    const r = document.getElementById(id).getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, id);
  await page.screenshot({ path: path.join(SHOTS, `mcp-${name}.png`), clip: box });
  const footer = await page.evaluate((id) => {
    const dialog = document.getElementById(id).getBoundingClientRect();
    const buttons = [...document.querySelectorAll(`#${id} footer button:not(.hidden)`)]
      .map((b) => b.getBoundingClientRect());
    return {
      rows: new Set(buttons.map((b) => Math.round(b.top))).size,
      title: document.querySelector(`#${id} h2`).textContent,
      left: Math.round(Math.min(...buttons.map((b) => b.left)) - dialog.left),
      right: Math.round(dialog.right - Math.max(...buttons.map((b) => b.right))),
      bottom: Math.round(dialog.bottom - Math.max(...buttons.map((b) => b.bottom))),
    };
  }, id);
  console.log(name, JSON.stringify(footer));
};

const visible = (id) => page.evaluate((id) =>
  !document.getElementById(id).classList.contains('hidden'), id);

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });

  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => visible('modal-settings'), { what: 'open settings dialog' });

  for (const locale of ['de', 'en']) {
    await page.evaluate((value) => {
      document.querySelector('.settings-nav-item[data-settings-panel="general"]').click();
      const input = document.querySelector(`#choice-app-locale input[value="${value}"]`);
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.settings-nav-item[data-settings-panel="tools"]').click();
    }, locale);
    await poll(() => page.evaluate(() =>
      document.querySelectorAll('#settings-mcp-list .mcp-row').length > 0),
    { what: 'MCP server row' });

    for (const theme of ['light', 'dark']) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);

      await page.evaluate(() => document.querySelector('#settings-mcp-list .mcp-row .btn-compact').click());
      await poll(() => visible('mcp-server-overlay'), { what: 'open server dialog' });
      await page.waitForTimeout(200);
      await shoot('dialog-mcp-server', `server-${locale}-${theme}`);
      await page.evaluate(() => document.getElementById('btn-mcp-server-cancel').click());

      await page.evaluate(() => document.getElementById('btn-import-mcp-servers').click());
      await poll(() => visible('mcp-import-overlay'), { what: 'open import dialog' });
      await page.waitForTimeout(200);
      await shoot('dialog-mcp-import', `import-${locale}-${theme}`);
      await page.evaluate(() => document.getElementById('btn-mcp-import-cancel').click());
    }
  }
  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
