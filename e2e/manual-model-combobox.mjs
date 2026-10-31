// Look instead of trust: starts the real app, points "Add model" for an
// OpenAI-compatible server at a fake one with many models, and photographs the
// model name list (#1325) — opened by its toggle with a name already in the
// field, and filtered by typing — light and dark, at the window's minimum
// width. Not a test — a look.
//
//   node e2e/manual-model-combobox.mjs
//
// Result: out/mockup/model-combobox-<state>-<theme>.png

import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const MODELS = [
  'apertus-70b', 'deepseek-r1', 'deepseek-v3.1', 'gemma-3-27b', 'glm-4.6',
  'gpt-oss-120b', 'gpt-oss-20b', 'kimi-k2-instruct', 'llama-3.3-70b',
  'llama-4-maverick', 'mistral-small-3.2', 'qwen3-235b-a22b', 'qwen3-coder-480b',
];

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;

const workspace = await makeTempDir('snotra-model-combobox-');
const userDataDir = await makeTempDir('snotra-model-combobox-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: baseUrl });

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

const shoot = async (name) => {
  const box = await page.evaluate(() => {
    const r = document.getElementById('dialog-add-model').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const file = path.join(SHOTS, `model-combobox-${name}.png`);
  await page.screenshot({ path: file, clip: box });
  console.log(`${name}: ${Math.round(box.width)}×${Math.round(box.height)}`);
};

const listState = () => page.evaluate(() => {
  const list = document.getElementById('model-name-options');
  const body = document.querySelector('#dialog-add-model .add-model-dialog__body').getBoundingClientRect();
  const r = list.getBoundingClientRect();
  return {
    open: !list.classList.contains('hidden'),
    options: list.querySelectorAll('[role="option"]').length,
    current: list.querySelector('.model-combobox__option--current')?.dataset.value ?? null,
    // Whether the body clips the list (it scrolls instead).
    listBottom: Math.round(r.bottom),
    bodyBottom: Math.round(body.bottom),
  };
});

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 860));
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
  { what: 'open settings dialog' });
  await page.evaluate(() => document.getElementById('btn-open-add-model').click());
  await poll(() => page.evaluate(() =>
    !document.getElementById('add-model-overlay').classList.contains('hidden')),
  { what: 'open add-model dialog' });

  await page.selectOption('#select-provider', 'openai-compatible');
  await page.fill('#input-base-url', baseUrl);
  await page.fill('#input-model', 'apertus-70b');
  await page.click('#btn-load-models');
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-model-options').classList.contains('hidden')),
  { what: 'loaded models' });
  console.log('status:', await page.textContent('#model-status'));

  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.fill('#input-model', 'apertus-70b');
    await page.keyboard.press('Escape');
    await page.click('#btn-model-options');
    await page.hover('#model-name-options [data-value="gemma-3-27b"]');
    await page.waitForTimeout(150);
    console.log(theme, 'toggle:', await listState());
    await shoot(`all-${theme}`);

    await page.fill('#input-model', '');
    await page.keyboard.type('70b');
    await page.mouse.move(0, 0);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
    console.log(theme, 'typed:', await listState());
    await shoot(`filtered-${theme}`);
    await page.keyboard.press('Escape');
  }

  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  server.close();
}
