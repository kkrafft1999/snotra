// Look instead of trust (#1110): starts the real app, opens Settings › Remote
// access and photographs it — first as this build has it (pairing closed),
// then every state main can be in, pushed into the window as main pushes
// them (pairing itself is closed, so the flow cannot be walked for real).
// Not a test — a look.
//
//   node e2e/manual-remote-access.mjs [en|de]
//
// Result: out/mockup/remote-access-<locale>-<state>-{light,dark}.png

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const locale = process.argv[2] === 'de' ? 'de' : 'en';
const SHOTS = path.resolve('out/mockup');
await mkdir(SHOTS, { recursive: true });

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-remote-look-');
const userDataDir = await makeTempDir('snotra-remote-look-userdata-');
await writeFile(path.join(workspace, 'README.md'), '# Garden Planner\n', 'utf8');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
// Developer mode on (#1213): without it the section is not in the settings.
await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale, developerMode: true }), 'utf8');

const snotra = await launchApp({ userDataDir });
const { app, page } = snotra;
await page.setViewportSize({ width: 1280, height: 860 }).catch(() => {});

/** A QR-shaped square of modules: finder patterns and a seeded pattern, 29 × 29. */
function modules() {
  const n = 29;
  let seed = 7;
  const rows = [];
  for (let y = 0; y < n; y += 1) {
    let row = '';
    for (let x = 0; x < n; x += 1) {
      const finder = [[0, 0], [n - 7, 0], [0, n - 7]].find(([fx, fy]) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7);
      if (finder) {
        const [fx, fy] = finder;
        const dx = x - fx; const dy = y - fy;
        row += (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4)) ? '1' : '0';
      } else {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        row += seed % 3 === 0 ? '1' : '0';
      }
    }
    rows.push(row);
  }
  return rows;
}

const base = { encryptionAvailable: true, phone: null, code: null, words: null, replacing: false, reason: null, locked: false };
const STATES = {
  code: { ...base, state: 'code', code: { display: '0111-EP9D-ZH4Q-PYT4-HWWF', qr: 'snotra-pair:v1/relay.snotra-ai.dev/0111EP9DZH4QPYT4HWWF', expiresAt: Date.now() + 272_000, modules: modules() } },
  confirm: { ...base, state: 'confirm', words: ['coffeecake', 'groundhog', 'maestro', 'kangaroo', 'ozone', 'oncoming'] },
  connected: { ...base, state: 'paired', phone: { pairedAt: Date.parse('2026-10-18T12:02:00Z'), connected: true } },
  // Last seen 12 minutes ago (#1233).
  offline: { ...base, state: 'paired', phone: { pairedAt: Date.parse('2026-10-18T12:02:00Z'), connected: false, lastSeen: Date.now() - 12 * 60_000 } },
  expired: { ...base, state: 'expired' },
  stopped: { ...base, state: 'stopped', reason: 'mac' },
  unreachable: { ...base, state: 'unreachable', reason: 'network' },
  denied: { ...base, state: 'denied' },
};

async function shoot(name) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => { document.documentElement.dataset.theme = th; }, theme);
    await page.waitForTimeout(250);
    await page.locator('.settings-dialog').screenshot({ path: path.join(SHOTS, `remote-access-${locale}-${name}-${theme}.png`) });
  }
}

try {
  await poll(async () =>
    (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
  { what: 'the tree' });
  await app.evaluate(({ Menu }) => {
    for (const top of Menu.getApplicationMenu().items) {
      const item = top.submenu?.items.find((i) => /^(Einstellungen|Settings)/.test(i.label ?? ''));
      if (item) { item.click(); return; }
    }
  });
  await poll(() => page.evaluate(() => !document.getElementById('modal-settings').classList.contains('hidden')), { what: 'the settings dialog' });
  await page.evaluate(() => document.getElementById('tab-settings-remote').click());
  await poll(() => page.evaluate(() => !!document.querySelector('#settings-remote-body .ra-card')), { what: 'the remote panel' });
  console.log('as built:', JSON.stringify(await page.evaluate(() => ({
    pairDisabled: document.querySelector('[data-action="pair"]')?.disabled,
    why: document.getElementById('ra-pair-why')?.textContent,
    soon: document.querySelector('.ra-soon')?.textContent,
    heading: document.getElementById('settings-panel-heading')?.textContent,
  }))));
  await shoot('locked');

  for (const [name, state] of Object.entries(STATES)) {
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('remote:state', s), state);
    await page.waitForTimeout(200);
    await shoot(name);
  }
  // The questions the panel asks itself.
  await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('remote:state', s), STATES.connected);
  await page.evaluate(() => document.querySelector('[data-action="remove"]').click());
  await shoot('remove');
  console.log('Screenshots in', SHOTS);
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
}
