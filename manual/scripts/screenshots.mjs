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
import { routeOpenAiImages } from '../../e2e/helpers/fake-images.mjs';

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

/** Whether the element with this id is on screen (not carrying `hidden`). */
const shown = (page, id) => page.evaluate((elementId) => {
  const element = document.getElementById(elementId);
  return Boolean(element) && !element.classList.contains('hidden');
}, id);

/**
 * The area around the elements matched by `selectors`, with a margin, kept
 * inside the window: a dialog, a menu or a card at a size a page can show
 * legibly.
 */
function clipAround(page, selectors, margin = 24) {
  return page.evaluate(({ list, pad, width, height }) => {
    const boxes = list.map((selector) => document.querySelector(selector).getBoundingClientRect());
    const left = Math.max(0, Math.min(...boxes.map((b) => b.left)) - pad);
    const top = Math.max(0, Math.min(...boxes.map((b) => b.top)) - pad);
    const right = Math.min(width, Math.max(...boxes.map((b) => b.right)) + pad);
    const bottom = Math.min(height, Math.max(...boxes.map((b) => b.bottom)) + pad);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, { list: [selectors].flat(), pad: margin, width: WINDOW.width, height: WINDOW.height });
}

/**
 * The chat column for motifs that show a card or a menu in it. At the default
 * width a card is taller than the window, and the mode menu has to wrap every
 * description (#812); a reader can drag the column this wide as well.
 */
const WIDE_CHAT = 560;

const PENDING_CARD = '#chat-messages .chat-approval-card[data-state="pending"]';

/** Waits for the approval card the run is waiting on, and scrolls it into view. */
async function waitForCard(page) {
  await poll(() => page.evaluate((selector) => Boolean(document.querySelector(selector)), PENDING_CARD),
    { timeoutMs: 30000, what: 'approval card' });
  await page.evaluate((selector) => document.querySelector(selector).scrollIntoView({ block: 'end' }), PENDING_CARD);
}

/**
 * Opens the settings the way a reader does: through the application menu. Right
 * after the start the renderer may not listen yet and the click goes nowhere,
 * so it is repeated until the dialog is there.
 */
async function openSettings(app, page) {
  await poll(async () => {
    if (await shown(page, 'modal-settings')) return true;
    await app.evaluate(({ Menu }) => {
      for (const top of Menu.getApplicationMenu().items) {
        const item = top.submenu?.items.find((entry) => /^(Settings|Einstellungen)…$/.test(entry.label ?? ''));
        if (item) { item.click(); return; }
      }
    });
    await pause(500);
    return shown(page, 'modal-settings');
  }, { what: 'open settings' });
  await poll(() => page.evaluate(() => !document.getElementById('btn-settings-save').disabled), { what: 'settings loaded' });
}

/**
 * Stores a placeholder OpenAI key the way Settings › Models does. It is never
 * sent anywhere: a motif that needs it either sends nothing to OpenAI or
 * answers the request inside the app (routeOpenAiImages).
 */
async function storeOpenAiKey(page, config) {
  const saved = await page.evaluate(({ rows, active }) => window.electronAPI.commitSettings({
    presets: rows,
    activePresetId: active,
    providerPatches: { openai: { apiKey: 'sk-manual-placeholder' } },
  }), { rows: config.presets, active: config.activePresetId });
  if (!saved?.ok) throw new Error(`OpenAI key not stored: ${JSON.stringify(saved)}`);
}

/**
 * Approves every card as it asks, until the model has received the request of
 * its last turn (`lastTurn`) and the run is over.
 */
async function approveUntilDone(page, lastTurn) {
  await poll(async () => {
    await page.evaluate(() => {
      document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])')?.click();
    });
    if (!lastTurn()) return false;
    return page.evaluate(() => !document.getElementById('btn-chat-send').classList.contains('chat-send--stop'));
  }, { timeoutMs: 45000, what: 'run through' });
}

/**
 * Puts the chat on "Auto", so that a run leaves no approval cards in the
 * answer. The system dialog that confirms it is answered here; a reader
 * confirms it by hand (safety/choose-a-mode).
 */
async function switchToAuto(app, page) {
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
  await page.evaluate(() => window.electronAPI.setToolPermissionMode('auto'));
  await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'auto'),
    { what: 'chat on Auto' });
}

/** Marks the last answer in the chat, so that clipAround() can find it. */
async function markLastAnswer(page) {
  await page.evaluate(() => {
    const answers = document.querySelectorAll('#chat-messages .chat-msg.assistant');
    answers[answers.length - 1].dataset.motif = 'answer';
  });
  // Away from whatever the last click left a hover state on.
  await page.mouse.move(0, 0);
}

/**
 * The run behind three motifs: Snotra reads the calendar and the plant list,
 * changes the calendar and the notes, and answers — in "Auto", so that the
 * answer shows the tool log and the changed files rather than two cards.
 */
async function summerSowings(app, page, model, text) {
  await switchToAuto(app, page);
  model.queueAnswer({
    match: text.question,
    toolCalls: [
      { name: 'read_file_text', arguments: { relative_path: text.calendar } },
      { name: 'read_file_text', arguments: { relative_path: text.plants } },
    ],
  });
  model.queueAnswer({
    toolCalls: [
      { name: 'edit_file', arguments: { relative_path: text.calendar, old_string: text.calendarOld, new_string: text.calendarNew } },
      { name: 'edit_file', arguments: { relative_path: text.notes, old_string: text.notesOld, new_string: text.notesNew } },
    ],
  });
  model.queueAnswer({ text: text.answer });
  await send(page, text.question);
  await approveUntilDone(page, () => model.pendingAnswers().length === 0);
  await poll(() => page.evaluate(() => document.querySelectorAll('.chat-changes .chat-change-file').length === 2),
    { what: 'changed files under the answer' });
  await markLastAnswer(page);
}

/** The texts of summerSowings(), per language. */
const SUMMER = {
  en: {
    title: 'Summer sowings in the calendar',
    question: 'The sowing calendar should cover summer sowings as well. Can you change that?',
    calendar: 'src/calendar.js',
    plants: 'plants.csv',
    notes: 'notes/spring-2026.md',
    calendarOld: 'export function buildCalendar(season, today = new Date()) {',
    calendarNew: '// lastMonth counts from 0: 7 is August, so summer sowings are in.\nexport function buildCalendar(season = { lastMonth: 7 }, today = new Date()) {',
    notesOld: '- Open: plan summer sowings, decide on crop rotation for next year.',
    notesNew: '- Done: the calendar covers summer sowings up to August.\n- Open: decide on crop rotation for next year.',
    answer: 'The calendar now runs **up to the end of August** unless you pass a season, so beans, lettuce and radishes show their summer sowings too.\n\nI also ticked off the summer sowings in `notes/spring-2026.md`; crop rotation is still open.',
  },
  de: {
    title: 'Sommeraussaat im Kalender',
    question: 'Der Aussaatkalender soll auch die Sommeraussaat abdecken. Kannst du das ändern?',
    calendar: 'src/kalender.js',
    plants: 'pflanzen.csv',
    notes: 'notizen/fruehjahr-2026.md',
    calendarOld: 'export function erstelleKalender(season, today = new Date()) {',
    calendarNew: '// lastMonth zählt ab 0: 7 ist August, damit ist die Sommeraussaat dabei.\nexport function erstelleKalender(season = { lastMonth: 7 }, today = new Date()) {',
    notesOld: '- Offen: Sommeraussaat planen, Fruchtfolge fürs nächste Jahr festlegen.',
    notesNew: '- Erledigt: Der Kalender deckt die Sommeraussaat bis August ab.\n- Offen: Fruchtfolge fürs nächste Jahr festlegen.',
    answer: 'Der Kalender läuft jetzt **bis Ende August**, wenn du keine Saison übergibst, also zeigen Bohnen, Salat und Radieschen auch ihre Sommeraussaat.\n\nIn `notizen/fruehjahr-2026.md` habe ich die Sommeraussaat abgehakt; die Fruchtfolge ist noch offen.',
  },
};

/**
 * The picture the image motif "generates": a plan of the three beds, drawn
 * here instead of by an image model, so that the motif needs no network and
 * shows something that fits the demo project.
 */
function gardenPlan() {
  const plants = (x, y, w, h, color, gap) => {
    const dots = [];
    for (let row = 1; (row + 0.5) * gap <= h; row += 1) {
      for (let col = 1; (col + 0.5) * gap <= w; col += 1) {
        dots.push(`<circle cx="${x + col * gap}" cy="${y + row * gap}" r="${gap * 0.32}" fill="${color}"/>`);
      }
    }
    return dots.join('');
  };
  const ring = (count, radius, size, color) => Array.from({ length: count }, (_, k) => {
    const angle = (2 * Math.PI * k) / count;
    return `<circle cx="${1210 + radius * Math.cos(angle)}" cy="${640 + radius * Math.sin(angle)}" r="${size}" fill="${color}"/>`;
  }).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1536" height="1024" viewBox="0 0 1536 1024">
    <rect width="1536" height="1024" fill="#e9dcc3"/>
    <path d="M0 880 C 400 840, 900 920, 1536 860 L1536 1024 L0 1024 Z" fill="#d8c7a6"/>
    <circle cx="1340" cy="170" r="92" fill="#f2b84b"/>
    <rect x="120" y="300" width="330" height="560" rx="18" fill="#7a5638"/>
    ${plants(120, 300, 330, 560, '#5f8f4e', 66)}
    <rect x="560" y="220" width="420" height="640" rx="18" fill="#7a5638"/>
    ${plants(560, 220, 420, 640, '#87ad5b', 70)}
    <circle cx="1210" cy="640" r="190" fill="#7a5638"/>
    <circle cx="1210" cy="640" r="128" fill="#8a6644"/>
    <circle cx="1210" cy="640" r="64" fill="#9b7650"/>
    ${ring(8, 160, 22, '#6f9b55')}
    ${ring(5, 96, 18, '#a3c46c')}
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Clicks the row of the file tree whose name is `name`. */
async function clickTreeRow(page, name) {
  await poll(() => page.evaluate((label) => {
    const row = [...document.querySelectorAll('#tree-container .tree-item')]
      .find((item) => item.getAttribute('aria-label') === label);
    if (!row) return false;
    row.click();
    return true;
  }, name), { what: `tree row ${name}` });
}

/**
 * The middle column, down to the end of what it shows: a short file leaves no
 * empty column below it in the picture.
 */
function clipPreview(page, height = null) {
  return page.evaluate((fixed) => {
    const column = document.getElementById('file-preview').getBoundingClientRect();
    if (fixed) return { x: column.left, y: column.top, width: column.width, height: Math.min(column.height, fixed) };
    // The text and the pictures in it, not the boxes: a view fills the column.
    const body = document.getElementById('preview-body');
    let bottom = 0;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.height > 0) bottom = Math.max(bottom, box.bottom);
    }
    for (const picture of body.querySelectorAll('img, canvas, svg')) {
      bottom = Math.max(bottom, picture.getBoundingClientRect().bottom);
    }
    return { x: column.left, y: column.top, width: column.width, height: Math.min(column.bottom, bottom + 24) - column.top };
  }, height);
}

/**
 * An HTML file is shown in a view of its own, laid over the window, which a
 * screenshot of the window does not see. Its picture is taken separately and
 * put where the view sits.
 */
async function withHtmlView(app, png, clip) {
  const view = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const v = win.contentView.children.find((child) => child.webContents?.getURL().startsWith('snotra-html:'));
    if (!v || !v.getVisible()) return null;
    const image = await v.webContents.capturePage();
    return { data: image.toPNG().toString('base64'), bounds: v.getBounds() };
  });
  if (!view) throw new Error('the HTML preview is not on screen');
  const origin = clip ?? { x: 0, y: 0, width: WINDOW.width, height: WINDOW.height };
  const scale = WINDOW.scale;
  const left = Math.max(view.bounds.x, origin.x);
  const top = Math.max(view.bounds.y, origin.y);
  const right = Math.min(view.bounds.x + view.bounds.width, origin.x + origin.width);
  const bottom = Math.min(view.bounds.y + view.bounds.height, origin.y + origin.height);
  const overlay = await sharp(Buffer.from(view.data, 'base64'))
    .resize(Math.round(view.bounds.width * scale), Math.round(view.bounds.height * scale))
    .extract({
      left: Math.round((left - view.bounds.x) * scale),
      top: Math.round((top - view.bounds.y) * scale),
      width: Math.round((right - left) * scale),
      height: Math.round((bottom - top) * scale),
    })
    .png().toBuffer();
  return sharp(png).composite([{
    input: overlay,
    left: Math.round((left - origin.x) * scale),
    top: Math.round((top - origin.y) * scale),
  }]).png().toBuffer();
}

/** A small page for the HTML preview: the sowing calendar as a table. */
function sowingCalendarPage(locale) {
  const de = locale === 'de';
  const rows = de
    ? [['Möhre', 'März – Juli', 'Südbeet'], ['Salat', 'März – August', 'Nordbeet'], ['Radieschen', 'März – September', 'Nordbeet'], ['Bohne', 'Mai – Juli', 'Südbeet']]
    : [['Carrot', 'March – July', 'South bed'], ['Lettuce', 'March – August', 'North bed'], ['Radish', 'March – September', 'North bed'], ['Bean', 'May – July', 'South bed']];
  const head = de ? ['Pflanze', 'Aussaat', 'Beet'] : ['Plant', 'Sowing', 'Bed'];
  return `<!doctype html>
<html lang="${locale}">
<head>
<meta charset="utf-8">
<title>${de ? 'Aussaatkalender 2026' : 'Sowing calendar 2026'}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces">
<style>
  body { margin: 0; padding: 32px 36px; font: 15px/1.5 Georgia, serif; background: #f6efe2; color: #3b2f22; }
  h1 { margin: 0 0 4px; font-size: 26px; }
  p { margin: 0 0 20px; color: #6b5a45; }
  table { border-collapse: collapse; width: 100%; background: #fffaf0; }
  th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #e3d6bf; }
  th { background: #7a5638; color: #fffaf0; font-weight: normal; }
  tr:nth-child(even) td { background: #f9f1e3; }
</style>
</head>
<body>
<h1>${de ? 'Aussaatkalender 2026' : 'Sowing calendar 2026'}</h1>
<p>${de ? 'Erstellt aus pflanzen.csv und beete.json.' : 'Built from plants.csv and beds.json.'}</p>
<table>
<tr>${head.map((cell) => `<th>${cell}</th>`).join('')}</tr>
${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('\n')}
</table>
</body>
</html>
`;
}

/** Opens the settings on one of their sections: models, security, tools, skills, memory, general. */
async function openSettingsPanel(app, page, panel) {
  await openSettings(app, page);
  await page.click(`.settings-nav-item[data-settings-panel="${panel}"]`);
  await poll(() => page.evaluate((key) => document.querySelector(`.settings-nav-item[data-settings-panel="${key}"]`)
    ?.getAttribute('aria-selected') === 'true', panel), { what: `settings section ${panel}` });
}

/** The page of a settings section, next to the navigation. */
const SETTINGS_PANEL = '#modal-settings .settings-dialog__panel-wrap';

/** A model list for the motifs about models: two OpenAI models and a local one. */
function threeModels(config) {
  const local = config.presets[0];
  local.model = 'qwen3-coder';
  local.connection.displayName = 'LM Studio';
  config.presets.unshift(
    { id: 'gpt-5-mini', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true },
    { id: 'gpt-5', providerId: 'openai', model: 'gpt-5', menuVisible: true },
  );
  config.activePresetId = 'gpt-5-mini';
  config.activeProvider = 'openai';
}

/** A skill of the demo project, per language. */
const DEMO_SKILL = {
  en: {
    name: 'sowing-advice',
    file: `---
name: sowing-advice
description: Advice on what to sow next and in which bed, from plants.csv and beds.json. Use it when the user asks what to sow, or where a plant should go.
---

# Sowing advice

1. Read \`plants.csv\` for the sowing window and the sun a plant needs.
2. Read \`beds.json\` for the hours of sun per bed.
3. Suggest the plants whose window is open now, each with the bed that suits it.
`,
  },
  de: {
    name: 'aussaat-tipps',
    file: `---
name: aussaat-tipps
description: Rat, was als Nächstes gesät wird und in welches Beet, aus pflanzen.csv und beete.json. Nutze ihn, wenn gefragt wird, was zu säen ist oder wohin eine Pflanze gehört.
---

# Aussaat-Tipps

1. Lies \`pflanzen.csv\` für den Saatzeitraum und die Sonne, die eine Pflanze braucht.
2. Lies \`beete.json\` für die Sonnenstunden pro Beet.
3. Schlag die Pflanzen vor, deren Zeitraum gerade offen ist, jeweils mit dem passenden Beet.
`,
  },
};

/** The project memory of the demo project, per language. */
const DEMO_MEMORY = {
  en: `# Memory · project

- 2026-09-28 — The beds are measured in centimetres, not in metres.
- 2026-10-02 — Sowing dates in plants.csv are month-day, without a year.
- 2026-10-05 (remembered on its own) — Tomatoes always go into the south bed.
`,
  de: `# Gedächtnis · Projekt

- 2026-09-28 — Die Beete sind in Zentimetern gemessen, nicht in Metern.
- 2026-10-02 — Die Saattermine in pflanzen.csv sind Monat-Tag, ohne Jahr.
- 2026-10-05 (selbst gemerkt) — Tomaten kommen immer ins Südbeet.
`,
};

/**
 * What the update dialog is told when a newer version exists: the notes of a
 * release as GitHub delivers them, a hand-written highlight and the generated
 * list. They stay English in both languages — that is what GitHub holds.
 */
const UPDATE_NOTES = [
  '## Highlights',
  '',
  '- **Back and forward in the preview.** Two arrows in the preview header step through the files it showed.',
  '- **Snotra tells you when an approval waits out of sight.** A system notification names the chat and what waits.',
  '',
  "## What's Changed",
  '* Go back and forward through the files the preview showed (#822) by @kkrafft1999 in https://github.com/kkrafft1999/snotra/pull/824',
  '* Notify when an approval card waits out of sight (#792, step 5) by @kkrafft1999 in https://github.com/kkrafft1999/snotra/pull/823',
  '',
  '**Full Changelog**: https://github.com/kkrafft1999/snotra/compare/v1.17.1...v1.18.0',
].join('\n');

/** Pushes "a newer version exists" into the window, as the start check does. */
async function offerUpdate(app, page, overrides = {}) {
  await app.evaluate(({ BrowserWindow }, payload) => {
    BrowserWindow.getAllWindows()[0].webContents.send('update:available', payload);
  }, {
    updateAvailable: true,
    manual: false,
    currentVersion: '1.17.1',
    latestVersion: '1.18.0',
    isPrerelease: false,
    releaseUrl: 'https://github.com/kkrafft1999/snotra/releases/tag/v1.18.0',
    notes: UPDATE_NOTES,
    canSelfUpdate: true,
    installKind: 'macos-bundle',
    asset: { name: 'Snotra-Agent-1.18.0-mac-arm64.dmg', size: 133_800_000 },
    ...overrides,
  });
  await poll(() => shown(page, 'modal-update'), { what: 'update dialog' });
  await pause(300);
}

/**
 * The motifs. Each one brings the app into the state it shows and returns the
 * area to shoot (`null` for the whole window). Texts come per language from
 * `text[locale]`, so the German shot shows a German conversation.
 *
 * `profile: 'fresh'` starts the app the way it is after installing: no folder,
 * no model of its own, only the language set. Every other motif starts on the
 * demo project with the fake model. `prefs` go into ui-preferences.json, for a
 * motif that needs a tool switched on.
 */
const MOTIFS = {
  /** The first start: no folder, no usable model, the hint above the composer. */
  'first-run': {
    profile: 'fresh',
    async setUp({ page }) {
      await poll(() => shown(page, 'chat-hint'), { what: 'hint without a model' });
      return null;
    },
  },

  /**
   * Settings › Models on the first start: the OpenAI entry the app comes with,
   * opened with its pencil and given a key. Editing it rather than adding the
   * same model again is the path that works today (#807).
   */
  'connect-model': {
    profile: 'fresh',
    async setUp({ app, page }) {
      await openSettings(app, page);
      await page.click('[data-edit-preset-id]');
      await poll(() => shown(page, 'add-model-overlay'), { what: 'open edit-model dialog' });
      // A placeholder, shown as dots: the field is a password field.
      await page.fill('#input-api-key', 'sk-example-placeholder-key');
      // The dialog and a strip of the settings around it: the whole window
      // would shrink the dialog's text below what a page can show legibly.
      return page.evaluate(() => {
        const box = document.getElementById('dialog-add-model').getBoundingClientRect();
        const margin = 24;
        return {
          x: Math.max(0, box.left - margin),
          y: Math.max(0, box.top - margin),
          width: box.width + 2 * margin,
          height: box.height + 2 * margin,
        };
      });
    },
  },

  /** The folder switcher in the title of the sidebar, opened. */
  'switch-folder': {
    async setUp({ page }) {
      await page.click('#btn-workspace');
      await poll(() => shown(page, 'folder-history-menu'), { what: 'open folder menu' });
      // The top left of the window: the menu at a size where it can be read.
      return { x: 0, y: 0, width: 640, height: 360 };
    },
  },

  /** An approval card in "Smart": Snotra wants to change a note. */
  'approval-card': {
    prefs: { chatPanelWidth: WIDE_CHAT },
    text: {
      en: {
        title: 'Tomatoes in the spring notes',
        question: 'Note in my spring notes that the tomatoes go into the south bed in mid-May.',
        path: 'notes/spring-2026.md',
        old: '- Open: plan summer sowings',
        new: '- Tomatoes go into the south bed in mid-May.\n- Open: plan summer sowings',
      },
      de: {
        title: 'Tomaten in den Frühjahrsnotizen',
        question: 'Notier in meinen Frühjahrsnotizen, dass die Tomaten Mitte Mai ins Südbeet kommen.',
        path: 'notizen/fruehjahr-2026.md',
        old: '- Offen: Sommeraussaat planen',
        new: '- Tomaten kommen Mitte Mai ins Südbeet.\n- Offen: Sommeraussaat planen',
      },
    },
    async setUp({ page, model, text }) {
      model.queueAnswer({
        match: text.question,
        toolCalls: [{
          name: 'edit_file',
          arguments: { relative_path: text.path, old_string: text.old, new_string: text.new },
        }],
      });
      await send(page, text.question);
      await waitForCard(page);
      return clipAround(page, PENDING_CARD, 16);
    },
  },

  /** An approval card for a shell command, run in the sandbox. */
  'shell-approval': {
    prefs: { shellExecutionEnabled: true, chatPanelWidth: WIDE_CHAT },
    text: {
      en: { title: 'Sowing calendar', question: 'Show me the sowing calendar for this year.', command: 'node src/calendar.js' },
      de: { title: 'Aussaatkalender', question: 'Zeig mir den Aussaatkalender für dieses Jahr.', command: 'node src/kalender.js' },
    },
    async setUp({ page, model, text }) {
      model.queueAnswer({
        match: text.question,
        toolCalls: [{ name: 'shell_execute', arguments: { command: text.command } }],
      });
      await send(page, text.question);
      await waitForCard(page);
      return clipAround(page, PENDING_CARD, 16);
    },
  },

  /**
   * The mode menu, opened from the pill in the composer. The chat is switched
   * to "Always ask" first — no system dialog on that way — so that the menu
   * also offers it as the folder's default for new chats.
   */
  'mode-menu': {
    prefs: { chatPanelWidth: WIDE_CHAT },
    async setUp({ page }) {
      await page.click('#btn-chat-tool-mode');
      await poll(() => shown(page, 'chat-tool-mode-menu'), { what: 'open mode menu' });
      await page.click('#chat-tool-mode-list [data-mode="ask-all"]');
      await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'ask-all'),
        { what: 'chat on "Always ask"' });
      if (!(await shown(page, 'chat-tool-mode-menu'))) await page.click('#btn-chat-tool-mode');
      await poll(() => page.evaluate(() => !document.getElementById('chat-tool-mode-footer').hidden),
        { what: 'default for new chats offered' });
      return clipAround(page, ['#chat-tool-mode-menu', '#btn-chat-tool-mode'], 16);
    },
  },

  /** Settings › Tools & security for the demo project, shell commands on. */
  'tools-and-security': {
    prefs: { shellExecutionEnabled: true },
    async setUp({ app, page }) {
      await openSettings(app, page);
      await page.click('#tab-settings-security');
      await poll(() => page.evaluate(() => document.querySelectorAll('#settings-security-rows .settings-security-row').length === 6),
        { what: 'six rows' });
      // The shell is found after the start; the page follows once main says so.
      await poll(() => page.evaluate(() => Boolean(document.querySelector('.settings-security-row[data-risk-class="execute"] .settings-security-pill--asks'))),
        { what: 'shell detected', timeoutMs: 30000 });
      // The page itself, next to the navigation: the whole dialog would shrink
      // its text below what a page shows legibly.
      return clipAround(page, '#modal-settings .settings-dialog__panel-wrap', 0);
    },
  },

  /** The shield next to the folder name while shell commands are on. */
  'sandbox-shield': {
    prefs: { shellExecutionEnabled: true },
    async setUp({ page }) {
      await poll(() => page.evaluate(() => {
        const shield = document.getElementById('btn-tree-sandbox');
        return Boolean(shield) && !shield.hidden && !shield.classList.contains('hidden');
      }), { what: 'sandbox shield', timeoutMs: 30000 });
      return { x: 0, y: 0, width: 480, height: 200 };
    },
  },

  /** The @ list above the chat input, filtered by what was typed. */
  'mention-list': {
    prefs: { chatPanelWidth: WIDE_CHAT },
    text: { en: { typed: 'Which plants from @pl' }, de: { typed: 'Welche Pflanzen aus @pf' } },
    async setUp({ page, text }) {
      // The list of the folder's paths loads after the start, and a list
      // opened before that stays empty: type again until it has entries.
      await poll(async () => {
        await page.fill('#chat-input', '');
        await page.click('#chat-input');
        await page.keyboard.type(text.typed);
        await pause(300);
        return page.evaluate(() => {
          const menu = document.getElementById('chat-mention-menu');
          return !menu.classList.contains('hidden') && menu.children.length > 0;
        });
      }, { what: 'mention list with entries' });
      return clipAround(page, ['#chat-mention-menu', '#chat-input-row'], 16);
    },
  },

  /**
   * The model menu: two OpenAI models and a local one, with the reasoning
   * levels of the chosen OpenAI model below them.
   */
  'model-menu': {
    prefs: { chatPanelWidth: WIDE_CHAT },
    configure(config) {
      const local = config.presets[0];
      local.model = 'qwen3-coder';
      local.connection.displayName = 'LM Studio';
      config.presets.unshift(
        { id: 'gpt-5-mini', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true },
        { id: 'gpt-5', providerId: 'openai', model: 'gpt-5', menuVisible: true },
      );
      config.activePresetId = 'gpt-5-mini';
      config.activeProvider = 'openai';
    },
    async setUp({ page, config }) {
      await storeOpenAiKey(page, config);
      // The key went to main past the settings dialog, so the window does not
      // know yet that the OpenAI entry can chat; a reload asks again.
      await page.reload();
      await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
        { what: 'drawn tree after the reload' });
      await poll(() => page.evaluate(() => /gpt-5-mini/.test(document.getElementById('chat-model-pill-label')?.textContent ?? '')),
        { what: 'pill on gpt-5-mini' });
      await page.click('#btn-chat-model-picker');
      await poll(() => shown(page, 'chat-model-menu'), { what: 'model menu' });
      return clipAround(page, ['#chat-model-menu', '#chat-input-row'], 16);
    },
  },

  /** An answer with its tool log opened: what Snotra read and changed. */
  'tool-log': {
    prefs: { chatPanelWidth: WIDE_CHAT },
    text: SUMMER,
    async setUp({ app, page, model, text }) {
      await summerSowings(app, page, model, text);
      await page.evaluate(() => { document.querySelector('[data-motif="answer"] .chat-tool-log').open = true; });
      await page.evaluate(() => document.querySelector('[data-motif="answer"]').scrollIntoView({ block: 'end' }));
      return clipAround(page, '[data-motif="answer"]', 16);
    },
  },

  /** The same answer, closed, with the line of changed files under it. */
  'changed-files': {
    prefs: { chatPanelWidth: WIDE_CHAT },
    text: SUMMER,
    async setUp({ app, page, model, text }) {
      await summerSowings(app, page, model, text);
      await page.evaluate(() => document.querySelector('[data-motif="answer"]').scrollIntoView({ block: 'end' }));
      return clipAround(page, '[data-motif="answer"]', 16);
    },
  },

  /** The change to the calendar, opened from that line, in the middle column. */
  'changes-view': {
    text: SUMMER,
    async setUp({ app, page, model, text }) {
      await summerSowings(app, page, model, text);
      await page.evaluate((name) => {
        const chip = [...document.querySelectorAll('.chat-changes button.chat-change-file')]
          .find((button) => button.querySelector('.chat-change-name').textContent === name);
        chip.click();
      }, path.basename(text.calendar));
      await poll(() => page.evaluate(() => Boolean(document.querySelector('#preview-body .changes-view table'))),
        { what: 'diff of the calendar' });
      await page.mouse.move(0, 0);
      return page.evaluate(() => {
        const column = document.getElementById('file-preview').getBoundingClientRect();
        const view = document.querySelector('#preview-body .changes-view');
        const bottom = Math.max(...[...view.querySelectorAll('*')].map((node) => node.getBoundingClientRect().bottom));
        return { x: column.left, y: column.top, width: column.width, height: Math.min(column.bottom, bottom + 24) - column.top };
      });
    },
  },

  /** An image generated into the folder, shown as a card in the answer. */
  'image-card': {
    prefs: { chatPanelWidth: WIDE_CHAT },
    configure(config) {
      // The OpenAI key comes with an OpenAI entry; the chat stays on the fake model.
      config.presets.push({ id: 'gpt-5-mini', providerId: 'openai', model: 'gpt-5-mini', menuVisible: true });
    },
    text: {
      en: {
        title: 'Garden plan',
        question: 'Draw me a plan of the three beds for the README.',
        prompt: 'A flat, top-down plan of a vegetable garden: two long beds and a herb spiral, warm earth tones.',
        path: 'images/garden-plan.png',
        answer: 'Here is the plan: `images/garden-plan.png`, the north bed on the left, the south bed in the middle and the herb spiral on the right.',
      },
      de: {
        title: 'Gartenplan',
        question: 'Zeichne mir einen Plan der drei Beete für die README.',
        prompt: 'Ein flacher Plan eines Gemüsegartens von oben: zwei lange Beete und eine Kräuterspirale, warme Erdtöne.',
        path: 'bilder/gartenplan.png',
        answer: 'Hier ist der Plan: `bilder/gartenplan.png`, links das Nordbeet, in der Mitte das Südbeet und rechts die Kräuterspirale.',
      },
    },
    async setUp({ app, page, model, text, config }) {
      await storeOpenAiKey(page, config);
      await switchToAuto(app, page);
      await routeOpenAiImages(app, { image: await gardenPlan() });
      model.queueAnswer({
        match: text.question,
        toolCalls: [{
          name: 'generate_image',
          arguments: { prompt: text.prompt, relative_path: text.path, size: '1536x1024', quality: 'medium' },
        }],
      });
      model.queueAnswer({ match: 'bytes_written', text: text.answer });
      await send(page, text.question);
      await approveUntilDone(page, () => model.requestFor('bytes_written'));
      await markLastAnswer(page);
      await poll(() => page.evaluate(() => {
        const img = document.querySelector('[data-motif="answer"] img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }), { what: 'image in the answer' });
      await page.evaluate(() => document.querySelector('[data-motif="answer"]').scrollIntoView({ block: 'end' }));
      return clipAround(page, '[data-motif="answer"]', 16);
    },
  },

  /** The filter above the tree, with what matches the typed letters. */
  'tree-filter': {
    text: { en: { typed: 'cal' }, de: { typed: 'kal' } },
    async setUp({ app, page, text }) {
      await app.evaluate(({ Menu, BrowserWindow }) => {
        const find = (items) => {
          for (const item of items) {
            if (item.accelerator === 'CmdOrCtrl+P') return item;
            const inner = item.submenu && find(item.submenu.items);
            if (inner) return inner;
          }
          return null;
        };
        find(Menu.getApplicationMenu().items).click(undefined, BrowserWindow.getAllWindows()[0]);
      });
      await poll(() => page.evaluate(() => !document.getElementById('tree-filter').hidden), { what: 'filter field' });
      // The folder's paths load after the start: type again until it matches.
      await poll(async () => {
        await page.fill('#tree-filter-input', '');
        await page.click('#tree-filter-input');
        await page.keyboard.type(text.typed);
        await pause(400);
        return page.evaluate(() => document.querySelectorAll('.tree-filter-option').length > 0);
      }, { what: 'matches in the filter' });
      await pause(300);
      return { x: 0, y: 0, width: 640, height: 360 };
    },
  },

  /** The ⋯ menu in the header of the tree. */
  'tree-actions': {
    async setUp({ page }) {
      await page.click('#btn-tree-actions');
      await poll(() => page.evaluate(() => {
        const menu = document.getElementById('tree-actions-menu');
        return Boolean(menu) && !menu.hidden && !menu.classList.contains('hidden');
      }), { what: 'tree actions menu' });
      return { x: 0, y: 0, width: 640, height: 360 };
    },
  },

  /** A source file in the preview, with syntax highlighting. */
  'code-preview': {
    text: { en: { folder: 'src', file: 'calendar.js' }, de: { folder: 'src', file: 'kalender.js' } },
    async setUp({ page, text }) {
      await clickTreeRow(page, text.folder);
      await clickTreeRow(page, text.file);
      await poll(() => page.evaluate((name) => (document.getElementById('preview-filename')?.textContent ?? '').includes(name)
        && Boolean(document.querySelector('#preview-body .syntax-keyword')), text.file), { what: 'highlighted source' });
      await page.mouse.move(0, 0);
      return clipPreview(page);
    },
  },

  /** An image in the preview, with the zoom in its header. */
  'image-preview': {
    text: { en: { file: 'garden-plan.png' }, de: { file: 'gartenplan.png' } },
    async setUp({ page, text, workspace }) {
      await writeFile(path.join(workspace, text.file), await gardenPlan());
      await clickTreeRow(page, text.file);
      await poll(() => page.evaluate(() => {
        const img = document.querySelector('#preview-body img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      }), { what: 'image in the preview' });
      await page.mouse.move(0, 0);
      return clipPreview(page);
    },
  },

  /** An HTML page in the preview, offline, with the notice of what it blocked. */
  'html-preview': {
    htmlView: true,
    text: { en: { file: 'sowing-calendar.html' }, de: { file: 'aussaatkalender.html' } },
    async setUp({ page, text, locale, workspace }) {
      await writeFile(path.join(workspace, text.file), sowingCalendarPage(locale), 'utf8');
      await clickTreeRow(page, text.file);
      await poll(() => page.evaluate(() => /1/.test(document.querySelector('#preview-body')?.textContent ?? '')
        && Boolean(document.querySelector('#preview-body [class*="blocked"]'))), { what: 'page with its blocked request', timeoutMs: 20000 });
      await pause(800);
      await page.mouse.move(0, 0);
      // The page fills the column; the picture ends below its table.
      return clipPreview(page, 520);
    },
  },

  /** Settings › Models with three entries. */
  'models-list': {
    configure: threeModels,
    async setUp({ app, page, config }) {
      await storeOpenAiKey(page, config);
      await openSettings(app, page);
      await poll(() => page.evaluate(() => document.querySelectorAll('[data-edit-preset-id]').length === 3),
        { what: 'three entries' });
      await page.mouse.move(0, 0);
      return page.evaluate((selector) => {
        const panel = document.querySelector(selector).getBoundingClientRect();
        const rows = [...document.querySelectorAll('[data-edit-preset-id]')]
          .map((button) => (button.closest('li') ?? button.parentElement.parentElement).getBoundingClientRect().bottom);
        return { x: panel.left, y: panel.top, width: panel.width, height: Math.min(panel.bottom, Math.max(...rows) + 24) - panel.top };
      }, SETTINGS_PANEL);
    },
  },

  /** "Add model" for an OpenAI-compatible server, filled in from the LM Studio template. */
  'add-compatible': {
    async setUp({ app, page }) {
      await openSettings(app, page);
      await page.click('#btn-open-add-model');
      await poll(() => shown(page, 'add-model-overlay'), { what: 'open add-model dialog' });
      await page.selectOption('#select-provider', 'openai-compatible');
      await poll(() => page.evaluate(() => !document.getElementById('provider-template-row')?.classList.contains('hidden')),
        { what: 'template row' });
      await page.selectOption('#select-provider-template', 'lm-studio');
      await page.fill('#input-display-name', 'LM Studio');
      await page.fill('#input-model', 'qwen3-coder');
      await page.evaluate(() => {
        document.activeElement?.blur();
        for (const node of document.querySelectorAll('#dialog-add-model *')) {
          if (node.scrollHeight > node.clientHeight + 1) node.scrollTop = 0;
        }
      });
      await page.mouse.move(0, 0);
      await pause(200);
      return page.evaluate(() => {
        const box = document.getElementById('dialog-add-model').getBoundingClientRect();
        const margin = 24;
        const top = Math.max(0, box.top - margin);
        return {
          x: Math.max(0, box.left - margin),
          y: top,
          width: box.width + 2 * margin,
          height: Math.min(window.innerHeight, box.bottom + margin) - top,
        };
      });
    },
  },

  /** Settings › General. */
  'settings-general': {
    async setUp({ app, page }) {
      await openSettingsPanel(app, page, 'general');
      await page.mouse.move(0, 0);
      return clipAround(page, SETTINGS_PANEL, 0);
    },
  },

  /** Settings › Skills: the system skills and a skill of the folder, not yet ticked. */
  'skills-settings': {
    async prepare({ workspace, locale }) {
      const skill = DEMO_SKILL[locale];
      await mkdir(path.join(workspace, '.agents', 'skills', skill.name), { recursive: true });
      await writeFile(path.join(workspace, '.agents', 'skills', skill.name, 'SKILL.md'), skill.file, 'utf8');
    },
    async setUp({ app, page, locale }) {
      await openSettingsPanel(app, page, 'skills');
      await poll(() => page.evaluate((name) => document.getElementById('panel-settings-skills')?.textContent.includes(name),
        DEMO_SKILL[locale].name), { what: 'the folder skill in the list' });
      await page.evaluate(() => {
        const heading = [...document.querySelectorAll('#panel-settings-skills h3, #panel-settings-skills h4, #panel-settings-skills [class*="heading"]')]
          .find((node) => /Available skills|Verfügbare Skills/.test(node.textContent));
        heading?.scrollIntoView({ block: 'start' });
      });
      await page.mouse.move(0, 0);
      await pause(200);
      return clipAround(page, SETTINGS_PANEL, 0);
    },
  },

  /** Settings › Memory with three entries in the project memory. */
  'memory-settings': {
    async prepare({ workspace, locale }) {
      await mkdir(path.join(workspace, '.agents'), { recursive: true });
      await writeFile(path.join(workspace, '.agents', 'memory.md'), DEMO_MEMORY[locale], 'utf8');
    },
    async setUp({ app, page, locale }) {
      await openSettingsPanel(app, page, 'memory');
      await poll(() => page.evaluate((text) => document.getElementById('panel-settings-memory')?.textContent.includes(text),
        locale === 'de' ? 'Südbeet' : 'south bed'), { what: 'the entries of the project memory' });
      await page.mouse.move(0, 0);
      return clipAround(page, SETTINGS_PANEL, 0);
    },
  },

  /** The dialog of an MCP server, opened from Settings › Tool setup. */
  'mcp-server': {
    async prepare({ userDataDir }) {
      // Never started: the dialog is drawn from the configuration alone.
      await writeFile(path.join(userDataDir, 'mcp-servers.json'), JSON.stringify({
        servers: [{
          id: 'github',
          label: 'GitHub',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          enabled: false,
        }],
      }), 'utf8');
    },
    async setUp({ app, page }) {
      await openSettingsPanel(app, page, 'tools');
      await poll(() => page.evaluate(() => document.querySelectorAll('#settings-mcp-list .mcp-row').length > 0),
        { what: 'MCP server row' });
      await page.evaluate(() => document.querySelector('#settings-mcp-list .mcp-row .btn-compact').click());
      await poll(() => shown(page, 'mcp-server-overlay'), { what: 'MCP server dialog' });
      await pause(200);
      await page.mouse.move(0, 0);
      return clipAround(page, '#dialog-mcp-server', 24);
    },
  },

  /** The settings with the version at the foot of the list and the button that checks for updates. */
  'update-check': {
    async setUp({ app, page }) {
      await openSettingsPanel(app, page, 'general');
      await poll(() => page.evaluate(() => /\d+\.\d+\.\d+/.test(document.getElementById('settings-version-label')?.textContent ?? '')),
        { what: 'the version in the settings' });
      await page.mouse.move(0, 0);
      return clipAround(page, '#modal-settings .settings-dialog', 0);
    },
  },

  /** The update dialog at the first step: the new version, the notes opened, three ways on. */
  'update-found': {
    async setUp({ app, page }) {
      await offerUpdate(app, page);
      await page.evaluate(() => { document.getElementById('modal-update-notes').open = true; });
      await pause(300);
      await page.mouse.move(0, 0);
      return clipAround(page, '#modal-update .update-dialog', 24);
    },
  },

  /** The update dialog once the download is done: the one question before the restart. */
  'update-ready': {
    async setUp({ app, page }) {
      // The download would go to GitHub; the screenshot only needs it to succeed.
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler('update:download');
        ipcMain.handle('update:download', async () => ({ ok: true }));
      });
      await offerUpdate(app, page);
      await page.click('#modal-update-actions .btn-primary');
      // "Found" has three buttons, "downloading" one, "ready" two.
      await poll(() => page.evaluate(() => document.querySelectorAll('#modal-update-actions button').length === 2),
        { what: 'the ready step' });
      await page.mouse.move(0, 0);
      await pause(300);
      return clipAround(page, '#modal-update .update-dialog', 24);
    },
  },

  /** The update dialog for an installation that cannot replace itself: the reason and the release page. */
  'update-manual': {
    async setUp({ app, page }) {
      await offerUpdate(app, page, {
        canSelfUpdate: false,
        installKind: 'linux-package',
        selfUpdateBlockedReason: { key: 'update.reason.package' },
        asset: null,
      });
      await page.mouse.move(0, 0);
      return clipAround(page, '#modal-update .update-dialog', 24);
    },
  },

  /** The history column next to the chat, with three chats of the folder. */
  history: {
    text: {
      en: {
        chats: [
          { title: 'Crop rotation for next year', question: 'Suggest a crop rotation for the three beds.', answer: 'Rotate in three steps — heavy feeders, medium feeders, light feeders — one bed further each year.' },
          { title: 'Spacing of the radishes', question: 'How far apart should the radishes be?', answer: 'Four centimetres, according to `plants.csv`.' },
          { title: 'Garden Planner overview', question: 'What does this project do?', answer: 'It works out which vegetables go into which bed, and when to sow them.' },
        ],
      },
      de: {
        chats: [
          { title: 'Fruchtfolge fürs nächste Jahr', question: 'Schlag eine Fruchtfolge für die drei Beete vor.', answer: 'Wechsle in drei Schritten — Starkzehrer, Mittelzehrer, Schwachzehrer —, jedes Jahr ein Beet weiter.' },
          { title: 'Abstand der Radieschen', question: 'Wie weit sollen die Radieschen auseinander?', answer: 'Vier Zentimeter, laut `pflanzen.csv`.' },
          { title: 'Überblick Gartenplaner', question: 'Was macht dieses Projekt?', answer: 'Es legt fest, welches Gemüse in welches Beet kommt und wann es gesät wird.' },
        ],
      },
    },
    async setUp({ page, model, text }) {
      await page.click('#btn-toggle-chat-history');
      await poll(() => shown(page, 'chat-history'), { what: 'history column' });
      for (const [index, chat] of text.chats.entries()) {
        if (index > 0) await page.click('#btn-chat-new');
        model.setTitle(chat.title);
        model.queueAnswer({ match: chat.question, text: chat.answer });
        await send(page, chat.question);
        await waitForRunEnd(page);
        await poll(() => page.evaluate((count) => document.querySelectorAll('#chat-history-list .chat-history-row').length >= count, index + 1),
          { what: `${index + 1} chats in the history` });
      }
      await page.mouse.move(0, 0);
      return page.evaluate(() => {
        const left = document.getElementById('chat-panel').getBoundingClientRect().left;
        return { x: left, y: 0, width: window.innerWidth - left, height: window.innerHeight };
      });
    },
  },

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

/** A profile on the demo project, with the fake model shown as MODEL. */
async function demoProfile(userDataDir, locale, model, configure) {
  const workspace = await demoWorkspace(locale);
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  const configPath = path.join(userDataDir, 'llm-config.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.presets[0].model = MODEL.id;
  config.presets[0].connection.displayName = MODEL.name;
  configure?.(config);
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  return { config, workspace };
}

async function shootMotif(name, motif, locale, model) {
  const fresh = motif.profile === 'fresh';
  const userDataDir = await makeTempDir('snotra-manual-userdata-');
  const { config, workspace } = fresh ? {} : await demoProfile(userDataDir, locale, model, motif.configure);
  await motif.prepare?.({ userDataDir, workspace, locale });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'),
    JSON.stringify({ ...motif.prefs, appLocale: locale }), 'utf8');

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
    if (fresh) {
      await poll(() => shown(page, 'welcome'), { what: 'welcome page' });
    } else {
      await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
        { what: 'drawn tree' });
    }

    const text = motif.text?.[locale] ?? {};
    if (text.title) model.setTitle(text.title);
    const clip = await motif.setUp({ app, page, model, text, locale, config, workspace });

    for (const theme of THEMES) {
      await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
      // Two frames for the theme's transitions to settle before the shot.
      await pause(400);
      let png = await page.screenshot(clip ? { clip } : {});
      if (motif.htmlView) png = await withHtmlView(app, png, clip);
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
