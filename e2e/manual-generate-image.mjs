// Look instead of trust (#85): starts the real app with an OpenAI key, lets
// the fake model call generate_image — the Images API answered inside the
// app, nothing leaves the machine — and photographs the answer with its image
// and the image card under Settings › Tools, light and dark. Not a test — a
// look.
//
//   node e2e/manual-generate-image.mjs [en|de]
//
// Result: out/mockup/generate-image-<locale>-<state>-{light,dark}.png

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';
import { routeOpenAiImages } from './helpers/fake-images.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-image-look-');
const userDataDir = await makeTempDir('snotra-image-look-userdata-');
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Landing page\n\nA page for the autumn campaign.\n');

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
const configPath = path.join(userDataDir, 'llm-config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
// An OpenAI key is stored with an OpenAI entry; the fake model stays active.
config.presets.push({ id: 'gpt5', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true });
await writeFile(configPath, JSON.stringify(config), 'utf8');
const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForApp() {
  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
}

async function shootClip(state, clipFn) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    const clip = await page.evaluate(clipFn);
    await page.screenshot({ path: path.join(SHOTS, `generate-image-${locale}-${state}-${theme}.png`), clip });
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
}

const openSettings = async () => {
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('modal-settings').classList.contains('hidden')),
  { what: 'open settings dialog' });
};

try {
  await waitForApp();
  const { encryptionAvailable } = await page.evaluate(() => window.electronAPI.getLLMState());
  if (!encryptionAvailable) throw new Error('No encrypted storage here — the OpenAI key cannot be stored.');
  const saved = await page.evaluate(({ rows, active }) => window.electronAPI.commitSettings({
    presets: rows,
    activePresetId: active,
    providerPatches: { openai: { apiKey: 'sk-look-never-sent' } },
  }), { rows: config.presets, active: config.presets[0].id });
  if (!saved?.ok) throw new Error(`settings not saved: ${JSON.stringify(saved)}`);
  await page.reload();
  await waitForApp();
  const images = await routeOpenAiImages(app);

  // ── The card under Settings › Tools ──────────────────────────────────────
  await openSettings();
  await page.evaluate(() => document.querySelector('[data-settings-panel="tools"]').click());
  await poll(() => page.evaluate(() =>
    document.getElementById('select-image-model').options.length > 2), { what: 'listed image models' });
  await page.evaluate(() => document.getElementById('settings-image-generation-card').scrollIntoView({ block: 'center' }));
  await shootClip('settings', () => {
    const box = document.getElementById('settings-image-generation-card').getBoundingClientRect();
    return { x: box.x - 16, y: box.y - 16, width: box.width + 32, height: box.height + 32 };
  });
  console.log('options', await page.evaluate(() =>
    [...document.getElementById('select-image-model').options].map((o) => o.textContent)));
  await page.keyboard.press('Escape');
  await pause(300);

  // ── A run that draws ─────────────────────────────────────────────────────
  model.queueAnswer({
    match: 'header image',
    toolCalls: [{
      name: 'generate_image',
      arguments: {
        prompt: 'A flat, calm landscape at dusk: two layers of green hills, an orange sun, warm sky. No text.',
        relative_path: 'assets/header.png',
        size: '1536x1024',
        quality: 'medium',
      },
    }],
  });
  model.queueAnswer({ text: locale === 'de'
    ? 'Das Headerbild liegt unter `assets/header.png` — eine ruhige Landschaft in der Abenddämmerung.'
    : 'The header image is at `assets/header.png` — a calm landscape at dusk.' });
  await page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, locale === 'de' ? 'Mach ein header image für die Landingpage.' : 'Make a header image for the landing page.');

  // The approval card, as it asks.
  await poll(() => page.evaluate(() => !!document.querySelector('.chat-approval-card')), { what: 'approval card' });
  await pause(300);
  await shootClip('approval', () => {
    const box = document.querySelector('.chat-approval-card').getBoundingClientRect();
    return { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 };
  });
  await poll(async () => {
    await page.evaluate(() => {
      document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])')?.click();
    });
    return page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop'));
  }, { what: 'run through', timeoutMs: 45000 });
  await page.mouse.move(0, 0);
  await pause(800);
  console.log('requests', JSON.stringify((await images.requests()).map((r) => r.body)));
  await poll(() => page.evaluate(() => !!document.querySelector('.chat-images img.chat-md-image-img')),
    { what: 'generated image in the chat' });
  console.log('caption', await page.evaluate(() => document.querySelector('.chat-image-caption').textContent));
  // Without the approval card, as in Auto mode: the image right under the line.
  await page.evaluate(() => document.querySelectorAll('.chat-approval-cards').forEach((el) => { el.style.display = 'none'; }));
  await shootClip('chat-auto', () => {
    const li = document.querySelector('.chat-images').closest('li');
    const user = li.previousElementSibling;
    (user || li).scrollIntoView({ block: 'center' });
    const first = (user || li).getBoundingClientRect();
    const box = li.getBoundingClientRect();
    return { x: box.x - 12, y: first.y - 12, width: box.width + 24, height: box.bottom - first.y + 24 };
  });
  await page.evaluate(() => document.querySelectorAll('.chat-approval-cards').forEach((el) => { el.style.display = ''; }));
  for (const theme of ['light', 'dark']) {
    await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
    await pause(300);
    await page.screenshot({ path: path.join(SHOTS, `generate-image-${locale}-window-${theme}.png`) });
  }

} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
