// Look instead of trust: comments in the PDF view (#1299) in the real app,
// light and dark. Not a test — the smoke test checks what must hold; this one
// produces the pictures for the pull request: the markings at rest, a comment
// opened by the mouse, one opened by the keyboard, a long one near the page
// edge, and the same at a larger zoom.
//
//   node e2e/manual-pdf-comments.mjs [label]
//
// Result: out/mockup/pdf-comments-<label>-<state>-<theme>.png, label
// defaults to "current".

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';
import { lineRect, makeTextPdf } from './helpers/pdf-fixtures.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await makeTempDir('snotra-pdf-comments-');
const userDataDir = await makeTempDir('snotra-pdf-comments-userdata-');
await mkdir(SHOTS, { recursive: true });

const LONG = 'The figure in this paragraph was taken from the draft of last spring. '
  + 'Before we send this out, someone should compare it with the measurements from September, '
  + 'because the two disagree by almost a third and nobody has said which one is right.';

await writeFile(path.join(workspace, 'review.pdf'), makeTextPdf({
  pages: 3,
  title: 'Garden plan 2027',
  lines: [
    'Bed 1 gets the tomatoes again, bed 2 the beans.',
    'The herb spiral stays where it is; it needs no water.',
    'Sowing starts in the second week of March, indoors.',
  ],
  comments: [
    {
      rect: lineRect(0, 330),
      author: 'Ada Lovelace',
      text: 'Tomatoes in the same bed three years running? That invites blight.',
      date: new Date('2026-10-28T09:12:00Z'),
      replies: [
        { author: 'Grace Hopper', text: 'Agreed, swap with bed 2.', date: new Date('2026-10-28T14:40:00Z') },
        { author: 'Ada Lovelace', text: 'Done in the next draft.', date: new Date('2026-10-29T08:05:00Z') },
      ],
    },
    { rect: lineRect(2, 320), author: 'Grace Hopper', text: LONG, date: new Date('2026-10-29T16:30:00Z') },
    { kind: 'note', rect: [520, 770, 540, 790], author: '', text: 'Check the date of the frost.' },
  ],
}));

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
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `pdf-comments-${label}-${state}-${theme}.png`) });
  }
}

const state = () => page.evaluate(() => {
  const popover = document.querySelector('.pdf-comment');
  return {
    targets: [...document.querySelectorAll('.pdf-comment-target')].map((b) => b.getAttribute('aria-label')),
    open: popover ? popover.getAttribute('aria-label') : null,
    focus: document.activeElement?.className ?? null,
    popoverBox: popover ? (() => { const r = popover.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`; })() : null,
    pageBox: (() => { const r = document.querySelector('.pdf-page')?.getBoundingClientRect(); return r ? `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}` : null; })(),
  };
});

try {
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0, { what: 'tree' });
  await page.evaluate(() => {
    [...document.querySelectorAll('#tree-container .tree-item')]
      .find((el) => el.querySelector('.label')?.textContent === 'review.pdf')?.click();
  });
  await poll(async () => (await page.evaluate(() => document.querySelectorAll('.pdf-comment-target').length)) > 0,
    { what: 'comment buttons', explain: state });
  await settle();
  console.log('rest', await state());
  await shoot('rest');

  await page.locator('.pdf-comment-target').first().hover();
  await settle(200);
  await shoot('hover');

  await page.locator('.pdf-comment-target').first().click();
  await settle();
  console.log('open', await state());
  console.log('open outline', await page.evaluate(() => {
    const b = document.querySelector('.pdf-comment-target--open');
    const cs = getComputedStyle(b);
    return { cls: b.className, outline: cs.outline, bg: cs.backgroundColor };
  }));
  await shoot('open');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await settle();
  console.log('keyboard', await state());
  await shoot('keyboard');

  await page.keyboard.press('Escape');
  await page.locator('.pdf-comment-target').nth(2).click();
  await settle();
  console.log('note', await state());
  await shoot('note');

  await page.keyboard.press('Escape');
  for (let i = 0; i < 4; i += 1) await page.locator('#preview-tools .pdf-tools__zoom-in').click();
  await settle(800);
  await page.locator('.pdf-comment-target').nth(1).click();
  await settle();
  console.log('zoomed', await state());
  await shoot('zoomed');
} finally {
  console.log('problems', problems);
  await snotra.stop().catch(() => {});
  await model.close();
}
