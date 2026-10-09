// Look instead of trust: ‹ › in the preview header (#822), in the real app,
// light and dark. Not a test — e2e/preview-history.test.mjs checks what must
// hold; this one produces the pictures for the pull request.
//
//   node e2e/manual-preview-history.mjs [label]
//
// Result: out/mockup/preview-history-<label>-<state>-<theme>.png, label
// defaults to "current". States: start (nothing to go back to), middle (both
// ways open), hover (pointer on ‹), focus (keyboard on ›), narrow (a narrow
// column with a long name), card (the info card of a file without a view).
// The `-header` shots are the header alone, at twice the size.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');

const README = `# Gartenplaner

Ein kleines Werkzeug, das aus einer Pflanzenliste einen Aussaatkalender macht.

## Loslegen

Wie du das Projekt einrichtest, steht in [docs/setup.md](docs/setup.md). Den
Aufbau beschreibt [docs/architecture.md](docs/architecture.md).
`;
const SETUP = `# Einrichten

Lege eine [config.json](../config.json) an und trage deine Region ein. Danach
weiter mit [architecture.md](architecture.md).
`;

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-preview-history-');
await mkdir(SHOTS, { recursive: true });
const files = {
  'README.md': README,
  'docs/setup.md': SETUP,
  'docs/architecture.md': '# Aufbau\n',
  'docs/aussaatkalender-fuer-die-region-bodensee-und-umgebung.md': '# Lang\n\n[Zurück](../README.md)\n',
  'config.json': '{ "region": "Bodensee" }\n',
  'fotos.zip': 'PK\u0003\u0004',
};
for (const [file, content] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
  await writeFile(path.join(workspace, file), content);
}

async function shoot(page, state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(SHOTS, `preview-history-${label}-${state}-${theme}.png`) });
    const header = await page.evaluate(() => {
      const el = document.getElementById('file-preview').classList.contains('hidden')
        ? document.getElementById('file-info')
        : document.getElementById('preview-header');
      const box = el.getBoundingClientRect();
      return { x: box.left, y: box.top, width: box.width, height: Math.min(box.height, 120) };
    });
    await page.screenshot({ path: path.join(SHOTS, `preview-history-${label}-${state}-header-${theme}.png`), clip: header, scale: 'device' });
  }
}

const shown = (page) => page.evaluate(() => (document.getElementById('file-preview').classList.contains('hidden')
  ? document.getElementById('info-filename').textContent
  : document.getElementById('preview-filename').textContent));
const waitFile = (page, name) => poll(async () => (await shown(page)) === name, { what: name });
const follow = (page, text) => page.evaluate((t) => {
  [...document.querySelectorAll('.md-doc a[data-link-kind="file"]')].find((a) => a.textContent === t).click();
}, text);
const openInTree = (page, rel) => page.evaluate((p) => {
  document.querySelector(`#tree-container .tree-item[data-path="${CSS.escape(p)}"]`).click();
}, path.join(workspace, rel));

const userDataDir = await makeTempDir('snotra-preview-history-userdata-');
await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
try {
  const { page } = snotra;
  await page.setViewportSize?.({ width: 1440, height: 900 });
  await waitFile(page, 'README.md');
  await new Promise((r) => setTimeout(r, 300));
  await shoot(page, 'start');

  await follow(page, 'docs/setup.md');
  await waitFile(page, 'setup.md');
  await follow(page, 'config.json');
  await waitFile(page, 'config.json');
  await page.evaluate(() => document.querySelector('.preview-history__button[data-direction="back"]').click());
  await waitFile(page, 'setup.md');
  await new Promise((r) => setTimeout(r, 300));
  await shoot(page, 'middle');

  await page.hover('.preview-history__button[data-direction="back"]');
  await new Promise((r) => setTimeout(r, 300));
  console.log('hover:', await page.evaluate(() => {
    const button = document.querySelector('.preview-history__button[data-direction="back"]');
    return { hovered: button.matches(':hover'), background: getComputedStyle(button).backgroundColor };
  }));
  await shoot(page, 'hover');
  await page.mouse.move(0, 0);

  // A key first, so that Chromium draws the ring for the focus that follows.
  await page.keyboard.press('Shift');
  await page.evaluate(() => document.querySelector('.preview-history__button[data-direction="forward"]').focus());
  await new Promise((r) => setTimeout(r, 300));
  await shoot(page, 'focus');
  await page.evaluate(() => document.activeElement?.blur());

  await openInTree(page, 'docs/aussaatkalender-fuer-die-region-bodensee-und-umgebung.md');
  await waitFile(page, 'aussaatkalender-fuer-die-region-bodensee-und-umgebung.md');
  await page.setViewportSize?.({ width: 980, height: 760 });
  await new Promise((r) => setTimeout(r, 400));
  console.log('content column:', await page.evaluate(() => Math.round(document.getElementById('content').getBoundingClientRect().width)));
  await shoot(page, 'narrow');
  await page.setViewportSize?.({ width: 1440, height: 900 });

  await openInTree(page, 'fotos.zip');
  await waitFile(page, 'fotos.zip');
  await new Promise((r) => setTimeout(r, 300));
  await shoot(page, 'card');
} finally {
  await snotra.stop?.().catch(() => {});
  await model.close();
}
