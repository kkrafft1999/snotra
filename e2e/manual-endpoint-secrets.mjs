// Look instead of trust (#560): stores a key for the OpenAI-compatible entry,
// opens the entry again, changes its address and photographs what the dialog
// says about the stored key — light and dark. Then saves and checks that the
// key is gone from llm-config.json. Not a test — a look.
//
//   node e2e/manual-endpoint-secrets.mjs [de|en]
//
// Result: out/mockup/endpoint-secrets-<locale>-<state>-<theme>.png

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';

const SHOTS = path.resolve('out/mockup');
const locale = process.argv[2] === 'en' ? 'en' : 'de';

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-endpoint-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-endpoint-userdata-'));
await mkdir(SHOTS, { recursive: true });
await writeFile(path.join(workspace, 'README.md'), '# Example project\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { page, app } = snotra;

const storedConnection = async () =>
  JSON.parse(await readFile(path.join(userDataDir, 'llm-config.json'), 'utf8')).presets[0].connection;

const shoot = async (name) => {
  const box = await page.evaluate(() => {
    const r = document.getElementById('dialog-add-model').getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  await page.screenshot({ path: path.join(SHOTS, `endpoint-secrets-${locale}-${name}.png`), clip: box });
};

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

const editFirstEntry = async () => {
  await poll(() => page.evaluate(() => !!document.querySelector('.settings-icon-edit')), { what: 'entry list' });
  await page.evaluate(() => document.querySelector('.settings-icon-edit').click());
  await poll(() => page.evaluate(() =>
    !document.getElementById('add-model-overlay').classList.contains('hidden')),
  { what: 'open entry' });
};

const texts = () => page.evaluate(() => ({
  keyPlaceholder: document.getElementById('input-api-key').placeholder,
  headersPlaceholder: document.getElementById('input-extra-headers').placeholder,
  status: document.getElementById('provider-status').textContent,
}));

try {
  // Encryption the way a Mac has it, without touching the real keychain.
  await app.evaluate(({ safeStorage }) => {
    safeStorage.isEncryptionAvailable = () => true;
    safeStorage.encryptString = (plain) => Buffer.from(`enc:${plain}`, 'utf8');
    safeStorage.decryptString = (buffer) => {
      const text = buffer.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not ours');
      return text.slice(4);
    };
  });
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'drawn tree' });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 860));

  // 1. Store a key and a header for the entry.
  await openSettings();
  await editFirstEntry();
  await page.fill('#input-api-key', 'sk-gateway');
  await page.fill('#input-extra-headers', 'X-Gateway-Token: secret');
  await page.evaluate(() => document.getElementById('btn-add-preset-row').click());
  await page.evaluate(() => document.getElementById('btn-settings-save').click());
  await poll(async () => !!(await storedConnection()).apiKeyEnc, { what: 'stored key' });
  console.log('stored:', Object.keys(await storedConnection()).filter((k) => k.endsWith('Enc')));

  // 2. Open it again: same address, then a new one.
  if (await page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden'))) {
    await openSettings();
  }
  await editFirstEntry();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(100);
    await shoot(`kept-${theme}`);
  }
  console.log('same address:', await texts());

  await page.fill('#input-base-url', 'http://127.0.0.1:9/v1');
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    await page.waitForTimeout(100);
    await shoot(`changed-${theme}`);
  }
  console.log('new address:', await texts());

  // Back to the saved address: the hint goes away again.
  await page.fill('#input-base-url', `${model.baseUrl}/`);
  console.log('saved address again:', await texts());

  // 3. Save with the new address: the key and the header are gone.
  await page.fill('#input-base-url', 'http://127.0.0.1:9/v1');
  await page.evaluate(() => document.getElementById('btn-add-preset-row').click());
  await page.evaluate(() => document.getElementById('btn-settings-save').click());
  await poll(async () => (await storedConnection()).baseUrl === 'http://127.0.0.1:9/v1', { what: 'saved address' });
  const after = await storedConnection();
  console.log('after save:', { baseUrl: after.baseUrl, apiKeyEnc: after.apiKeyEnc ?? null, extraHeadersEnc: after.extraHeadersEnc ?? null });

  console.log('\nScreenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
