// Look instead of trust: the middle column with the folder's README (#351),
// in the real app, light and dark. Not a test — e2e/folder-readme.test.mjs
// checks what must hold; this one produces the pictures for the pull request.
//
//   node e2e/manual-folder-readme.mjs [label]
//
// Result: out/mockup/folder-readme-<label>-<state>-<theme>.png, label defaults
// to "current". States: readme (start in a folder with one), long (a README
// that scrolls), none (a folder without one), huge (one too large to show),
// no-folder (first start without a folder).

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');

const README = `# Aurora Shop

Der Webshop für die Aurora-Leuchtenserie: Katalog, Warenkorb und Checkout,
gebaut mit Node 24 und einer kleinen Express-API.

## Schnellstart

\`\`\`sh
npm install
npm run dev
\`\`\`

## Aufbau

| Ordner | Inhalt |
|---|---|
| \`src/api\` | REST-Endpunkte für Katalog und Bestellungen |
| \`src/web\` | Oberfläche, ohne Framework |
| \`docs/\` | Architektur und Betriebshandbuch |

> Preise kommen ausschließlich aus dem Backend — nie aus dem Browser.
`;

const LONG = ['# Handbuch', '', ...Array.from({ length: 40 }, (_, i) =>
  `## Abschnitt ${i + 1}\n\nAbsatz ${i + 1}, so umbrochen, wie Dokumente in einem Repository\nmeist umbrochen sind.\n`)].join('\n');

const model = await startFakeModel();
const base = await makeTempDir('snotra-folder-readme-');
await mkdir(SHOTS, { recursive: true });
const folders = {
  'aurora-shop': { 'README.md': README, 'AGENTS.md': '# Agents\n', 'package.json': '{}\n', 'src/api/orders.js': '\n', 'docs/architecture.md': '# A\n' },
  handbuch: { 'README.md': LONG },
  skripte: { 'deploy.sh': '#!/bin/sh\n', 'AGENTS.md': '# Agents\n' },
  riesig: { 'README.md': `# Riesig\n\n${'y'.repeat(1024 * 1024 + 1)}\n` },
};
const dirs = {};
for (const [name, files] of Object.entries(folders)) {
  dirs[name] = path.join(base, name);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dirs[name], file)), { recursive: true });
    await writeFile(path.join(dirs[name], file), content);
  }
}

async function shoot(page, state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 200));
    await page.screenshot({ path: path.join(SHOTS, `folder-readme-${label}-${state}-${theme}.png`) });
  }
}

const state = (page) => page.evaluate(() => ({
  open: !document.getElementById('app').classList.contains('app--no-preview'),
  root: document.getElementById('project-name')?.textContent,
  doc: Boolean(document.querySelector('.md-doc')),
}));

async function withApp({ workspace }, run) {
  const userDataDir = await makeTempDir('snotra-folder-readme-userdata-');
  await prepareUserData(userDataDir, { workspace: workspace ?? dirs['aurora-shop'], modelBaseUrl: model.baseUrl });
  if (!workspace) await writeFile(path.join(userDataDir, 'last-folder.json'), JSON.stringify({ path: null }));
  await writeFile(path.join(userDataDir, 'folder-history.json'), JSON.stringify({ paths: Object.values(dirs) }));
  const snotra = await launchApp({ userDataDir });
  try {
    await snotra.page.setViewportSize?.({ width: 1440, height: 900 });
    await run(snotra.page);
  } finally {
    await snotra.stop?.().catch(() => {});
  }
}

const switchTo = (page, name) => page.evaluate((p) => {
  document.querySelector(`#folder-history-menu [role="menuitem"][data-path="${CSS.escape(p)}"]`).click();
}, dirs[name]);

try {
  await withApp({ workspace: dirs['aurora-shop'] }, async (page) => {
    await poll(async () => { const s = await state(page); return s.open && s.doc; }, { what: 'README at the start' });
    await new Promise((r) => setTimeout(r, 300));
    await shoot(page, 'readme');
    console.log('column widths:', await page.evaluate(() => Object.fromEntries(
      ['#sidebar', '#content', '#chat-panel'].map((sel) => [sel, Math.round(document.querySelector(sel)?.getBoundingClientRect().width ?? 0)]))));

    await switchTo(page, 'handbuch');
    await poll(async () => { const s = await state(page); return s.root === 'handbuch' && s.doc; }, { what: 'long README' });
    await page.evaluate(() => { document.querySelector('.md-view').scrollTop = 900; });
    await new Promise((r) => setTimeout(r, 300));
    await shoot(page, 'long');

    await switchTo(page, 'skripte');
    await poll(async () => { const s = await state(page); return s.root === 'skripte' && !s.open; }, { what: 'no README' });
    await new Promise((r) => setTimeout(r, 300));
    await shoot(page, 'none');

    await switchTo(page, 'handbuch');
    await poll(async () => { const s = await state(page); return s.root === 'handbuch' && s.open; }, { what: 'open again' });
    await switchTo(page, 'riesig');
    await poll(async () => { const s = await state(page); return s.root === 'riesig' && !s.open; }, { what: 'huge README' });
    await new Promise((r) => setTimeout(r, 300));
    await shoot(page, 'huge');
  });

  await withApp({ workspace: null }, async (page) => {
    await poll(async () => (await state(page)).open, { what: 'start screen' });
    await new Promise((r) => setTimeout(r, 300));
    await shoot(page, 'no-folder');
  });
} finally {
  await model.close();
}
