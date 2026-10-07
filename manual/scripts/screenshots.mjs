// Generates the manual's screenshots from the real app (#779).
//
//   npm run screenshots                 every motif
//   npm run screenshots -- overview     only the motifs named
//
// Every motif is shot in English and German, light and dark, and saved as
// public/screenshots/<motif>.<lang>.<theme>.webp. The app starts fresh for each
// motif and language, on a copy of demo-workspace/<lang>/ and against the fake
// model from e2e/helpers — no real model, no real folder, no network. The
// pages reference a motif as plain Markdown, `![Alt](screenshots/<motif>.webp)`,
// and src/plugins/remark-screenshots.mjs picks the variant.
//
// Needs the app's own dependencies: `npm ci` at the repository root.

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { startFakeModel } from '../../e2e/helpers/fake-model.mjs';
import { launchApp, makeTempDir, poll, prepareUserData } from '../../e2e/helpers/app.mjs';

const MANUAL_DIR = fileURLToPath(new URL('..', import.meta.url));
const REPO_DIR = path.resolve(MANUAL_DIR, '..');
const OUT_DIR = path.join(MANUAL_DIR, 'public', 'screenshots');

const LOCALES = ['en', 'de'];
const THEMES = ['light', 'dark'];

/**
 * The window every motif is shot in, in CSS pixels, at a fixed scale factor:
 * the same image on every machine, sharp on a high-density screen.
 */
const WINDOW = { width: 1280, height: 800, scale: 2 };

/** WebP quality for app screenshots: text stays crisp, files stay small. */
const WEBP = { quality: 86, effort: 6 };

/**
 * The model as the screenshots show it. The composer shows the model id, and
 * "fake-model" would only puzzle a reader; every answer still comes from the
 * fake model.
 */
const MODEL = { id: 'gpt-5', name: 'OpenAI' };

/**
 * Where the demo project lies while it is shot. The app shows the folder's
 * full path under its name, so it is a short, fixed one rather than a random
 * temporary folder. Emptied before every start.
 */
const DEMO_PARENT = process.platform === 'win32' ? path.join(os.tmpdir(), 'demo') : '/tmp/demo';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Types a message into the composer and sends it. */
async function send(page, text) {
  await page.evaluate((value) => {
    const input = document.getElementById('chat-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, text);
}

/** Waits until the run is over: the send button is no longer a stop button. */
async function waitForRunEnd(page) {
  await poll(() => page.evaluate(() => {
    const button = document.getElementById('btn-chat-send');
    return button && !button.classList.contains('chat-send--stop');
  }), { timeoutMs: 30000, what: 'end of the run' });
}

/**
 * The motifs. Each one brings the app into the state it shows and returns the
 * area to shoot (`null` for the whole window). Texts come per language from
 * `text[locale]`, so the German shot shows a German conversation.
 */
const MOTIFS = {
  /** The main window: tree, README in the preview, a short answer in the chat. */
  overview: {
    text: {
      en: {
        title: 'Garden Planner overview',
        question: 'What does this project do, and what is still open?',
        answer: [
          'The **Garden Planner** works out which vegetables go into which bed and when to sow them.',
          '',
          '- `beds.json` holds the three beds with size and hours of sun.',
          '- `plants.csv` has spacing and sowing window per plant.',
          '- `src/calendar.js` builds the sowing calendar from both.',
          '',
          'Still open, according to the README: **summer sowings** and **crop rotation**.',
        ].join('\n'),
      },
      de: {
        title: 'Überblick Gartenplaner',
        question: 'Was macht dieses Projekt, und was ist noch offen?',
        answer: [
          'Der **Gartenplaner** legt fest, welches Gemüse in welches Beet kommt und wann es gesät wird.',
          '',
          '- `beete.json` enthält die drei Beete mit Größe und Sonnenstunden.',
          '- `pflanzen.csv` hat Abstand und Saatzeitraum pro Pflanze.',
          '- `src/kalender.js` erstellt daraus den Aussaatkalender.',
          '',
          'Laut README noch offen: **Sommeraussaat** und **Fruchtfolge**.',
        ].join('\n'),
      },
    },
    async setUp({ page, model, text }) {
      // The README of the folder opens in the middle column on its own (#351).
      await poll(() => page.evaluate(() => /README\.md/.test(document.getElementById('preview-filename')?.textContent ?? '')),
        { what: 'README in the preview' });
      model.queueAnswer({
        match: text.question,
        toolCalls: [{ name: 'read_file_text', arguments: { relative_path: 'README.md' } }],
      });
      model.queueAnswer({ text: text.answer });
      await send(page, text.question);
      await waitForRunEnd(page);
      return null;
    },
  },
};

/** A fresh copy of the demo project at DEMO_PARENT, under its real name. */
async function demoWorkspace(locale) {
  await rm(DEMO_PARENT, { recursive: true, force: true });
  await mkdir(DEMO_PARENT, { recursive: true });
  const folder = path.join(await realpath(DEMO_PARENT), locale === 'de' ? 'gartenplaner' : 'garden-planner');
  await cp(path.join(MANUAL_DIR, 'demo-workspace', locale), folder, { recursive: true });
  return folder;
}

async function shootMotif(name, motif, locale, model) {
  const workspace = await demoWorkspace(locale);
  const userDataDir = await makeTempDir('snotra-manual-userdata-');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: locale }), 'utf8');
  const configPath = path.join(userDataDir, 'llm-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.presets[0].model = MODEL.id;
  config.presets[0].connection.displayName = MODEL.name;
  await writeFile(configPath, JSON.stringify(config), 'utf8');

  const snotra = await launchApp({
    userDataDir,
    args: [`--force-device-scale-factor=${WINDOW.scale}`],
  });
  const { app, page } = snotra;
  try {
    await app.evaluate(({ BrowserWindow }, { width, height }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.unmaximize();
      window.setContentSize(width, height);
    }, WINDOW);
    await poll(() => page.evaluate(({ width, height }) => window.innerWidth === width && window.innerHeight === height, WINDOW),
      { what: `window at ${WINDOW.width}×${WINDOW.height}` });
    await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
      { what: 'drawn tree' });

    const text = motif.text?.[locale] ?? {};
    if (text.title) model.setTitle(text.title);
    const clip = await motif.setUp({ page, model, text, locale });

    for (const theme of THEMES) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      // Two frames for the theme's transitions to settle before the shot.
      await pause(400);
      const png = await page.screenshot(clip ? { clip } : {});
      const target = path.join(OUT_DIR, `${name}.${locale}.${theme}.webp`);
      const { width, height, size } = await sharp(png).webp(WEBP).toFile(target);
      console.log(`  ${path.relative(MANUAL_DIR, target)}  ${width}×${height}  ${Math.round(size / 1024)} KB`);
    }
  } finally {
    await snotra.stop().catch(() => {});
    await rm(DEMO_PARENT, { recursive: true, force: true });
  }
}

const requested = process.argv.slice(2);
const unknown = requested.filter((name) => !MOTIFS[name]);
if (unknown.length > 0) {
  console.error(`Unknown motif(s): ${unknown.join(', ')}. Known: ${Object.keys(MOTIFS).join(', ')}`);
  process.exit(1);
}
const names = requested.length > 0 ? requested : Object.keys(MOTIFS);

// The renderer's vendor bundles are generated, not committed; without them the
// app starts with an empty window.
execFileSync(process.execPath, [path.join(REPO_DIR, 'scripts', 'sync-renderer-vendor.js')], { cwd: REPO_DIR, stdio: 'inherit' });

await mkdir(OUT_DIR, { recursive: true });
const model = await startFakeModel();
try {
  for (const name of names) {
    console.log(name);
    for (const locale of LOCALES) await shootMotif(name, MOTIFS[name], locale, model);
  }
} finally {
  await model.close();
}
