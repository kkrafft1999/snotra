// Look instead of trust: adding a comment in the PDF view (#1386) in the real
// app, light and dark. Not a test — the smoke test checks what must hold; this
// one produces the pictures for the pull request: text selected with the
// mouse and its chip, the composer with a comment typed, the comment after
// saving, and the file read back to show it is really in the PDF.
//
//   node e2e/manual-pdf-annotate.mjs [label]
//
// Result: out/mockup/pdf-annotate-<label>-<state>-<theme>.png, label
// defaults to "current".

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';
import { makeTextPdf } from './helpers/pdf-fixtures.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-pdf-annotate-');
const userDataDir = await makeTempDir('snotra-pdf-annotate-userdata-');
await mkdir(SHOTS, { recursive: true });

const file = path.join(workspace, 'review.pdf');
const original = makeTextPdf({
  pages: 2,
  title: 'Garden plan 2027',
  lines: [
    'Bed 1 gets the tomatoes again, bed 2 the beans.',
    'The herb spiral stays where it is; it needs no water.',
    'Sowing starts in the second week of March, indoors.',
  ],
});
await writeFile(file, original);

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
});

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await settle(200);
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `pdf-annotate-${label}-${state}-${theme}.png`) });
  }
}

const state = () => page.evaluate(() => ({
  spans: document.querySelectorAll('.pdf-text-layer span').length,
  selection: String(document.getSelection()),
  chip: !document.querySelector('.pdf-compose-chip')?.hidden,
  composer: Boolean(document.querySelector('.pdf-compose')),
  marks: document.querySelectorAll('.pdf-compose-mark').length,
  targets: [...document.querySelectorAll('.pdf-comment-target')].map((b) => b.getAttribute('aria-label')),
  announcer: document.querySelector('.pdf-view__announcer')?.textContent ?? null,
  message: document.querySelector('.pdf-compose__message:not([hidden])')?.textContent ?? null,
}));

/** The client box of the span whose text starts with `text`. */
const spanBox = (text) => page.evaluate((wanted) => {
  const span = [...document.querySelectorAll('.pdf-page[data-page="1"] .pdf-text-layer span')]
    .find((s) => s.textContent.startsWith(wanted));
  if (!span) return null;
  const r = span.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}, text);

try {
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0, { what: 'tree' });
  await page.evaluate(() => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === 'review.pdf')?.click();
  });
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('.pdf-text-layer span').length)) > 0,
    { what: 'text layer', explain: state });
  await settle();

  // Drag across "The herb spiral stays where it is" with the mouse.
  const line = await spanBox('The herb spiral');
  if (!line) throw new Error(`no span for the line: ${JSON.stringify(await state())}`);
  const y = line.top + line.height / 2;
  await page.mouse.move(line.left + 1, y);
  await page.mouse.down();
  await page.mouse.move(line.left + line.width * 0.4, y, { steps: 6 });
  await page.mouse.move(line.left + line.width * 0.62, y, { steps: 6 });
  await page.mouse.up();
  await settle(500);
  console.log('selected', await state());
  await shoot('chip');

  await page.locator('.pdf-compose-chip').click();
  await settle();
  await page.keyboard.type('Does the spiral really need no water in August? Last summer it dried out.');
  await settle(200);
  console.log('composing', await state());
  await shoot('compose');

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('.pdf-comment-target').length)) > 0,
    { what: 'the saved comment', explain: state });
  await settle(600);
  console.log('saved', await state());
  await shoot('saved');

  await page.locator('.pdf-comment-target').first().click();
  await settle();
  await shoot('reopened');

  const written = await readFile(file);
  console.log('file', {
    before: original.length,
    after: written.length,
    appended: written.subarray(0, original.length).equals(original),
    highlight: written.includes(Buffer.from('/Highlight')),
  });
} finally {
  console.log('problems', problems);
  await snotra.stop().catch(() => {});
  await model.close();
}
