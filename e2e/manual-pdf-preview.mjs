// Look instead of trust: PDFs in the file preview (#346), every state from the
// definition of done in the real app, light and dark. Not a test — the smoke
// test checks what must hold; this one produces the pictures for the pull
// request and prints what a picture cannot show (pages drawn, focus,
// requests, whether PDF JavaScript ran).
//
//   node e2e/manual-pdf-preview.mjs [label]
//
// Result: out/mockup/pdf-<label>-<state>-<theme>.png, label defaults to
// "current".

import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll } from './helpers/app.mjs';
import { BROKEN_PDF, HOSTILE_HOST, makeEncryptedPdf, makeTextPdf } from './helpers/pdf-fixtures.mjs';

const label = process.argv[2] || 'current';
const SHOTS = path.resolve('out/mockup');

const model = await startFakeModel();
const workspace = await mkdtemp(path.join(tmpdir(), 'snotra-pdf-'));
const outside = await mkdtemp(path.join(tmpdir(), 'snotra-pdf-outside-'));
const userDataDir = await mkdtemp(path.join(tmpdir(), 'snotra-pdf-userdata-'));
await mkdir(SHOTS, { recursive: true });

const files = {
  'docs/specification-v2.pdf': makeTextPdf({ pages: 12, title: 'Specification', hostile: true }),
  'manuals/operator-handbook.pdf': makeTextPdf({ pages: 300, title: 'Operator handbook' }),
  'invoices/2026-09-invoice.pdf': makeTextPdf({ pages: 1, title: 'Invoice 2026-09' }),
  'contracts/nda-signed.pdf': makeEncryptedPdf({ password: 'secret' }),
  'exports/report.pdf': BROKEN_PDF,
  'exports/notes.pdf': 'This is a text file with a .pdf name.\n',
  // Over the 50 MB limit — the size alone decides, the content is never read.
  'scans/archive-2019.pdf': Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(51 * 1024 * 1024)]),
};
for (const [name, content] of Object.entries(files)) {
  const file = path.join(workspace, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}
await writeFile(path.join(outside, 'secret.pdf'), makeTextPdf({ pages: 1, title: 'Secret' }));
await symlink(path.join(outside, 'secret.pdf'), path.join(workspace, 'exports', 'outside.pdf'));

await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
const snotra = await launchApp({ userDataDir });
const { page } = snotra;

const requests = [];
page.on('request', (request) => {
  const url = request.url();
  if (!url.startsWith('data:') && !url.startsWith('file:') && !url.startsWith('devtools:')) requests.push(url);
});
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
});
await page.evaluate(() => {
  globalThis.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    globalThis.__cspViolations.push(`${e.violatedDirective} ${e.blockedURI}`);
  });
});

const pane = () => page.evaluate(() => {
  const view = document.querySelector('.pdf-view');
  const message = document.querySelector('.pdf-view__message');
  return {
    name: document.getElementById('preview-filename').textContent,
    view: document.querySelector('#preview-body > .file-view')?.dataset.view ?? null,
    meta: document.getElementById('preview-meta').textContent,
    pages: document.querySelectorAll('.pdf-page').length,
    drawn: [...document.querySelectorAll('.pdf-page canvas')].map((c) => c.closest('.pdf-page').dataset.page),
    shown: Boolean(view && !view.hidden),
    page: document.querySelector('.pdf-tools__page')?.value ?? null,
    total: document.querySelector('.pdf-tools__total')?.textContent ?? null,
    zoom: document.querySelector('.pdf-tools__zoom')?.textContent ?? null,
    firstWidth: document.querySelector('.pdf-page')?.style.width ?? null,
    message: message && !message.hidden ? message.textContent : null,
  };
});

async function openPath(...names) {
  for (const name of names) {
    await page.evaluate((fileName) => {
      [...document.querySelectorAll('#tree-container .tree-item')]
        .find((el) => el.querySelector('.label')?.textContent === fileName)
        ?.click();
    }, name);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function openAndWait(name, ready, what) {
  await openPath(name);
  return poll(async () => {
    const state = await pane();
    return state.name === name && ready(state) ? state : null;
  }, { what: what ?? name });
}

async function shoot(state) {
  for (const theme of ['light', 'dark']) {
    await page.evaluate((th) => {
      if (th === 'dark') document.documentElement.dataset.theme = 'dark';
      else delete document.documentElement.dataset.theme;
    }, theme);
    await new Promise((r) => setTimeout(r, 200));
    await page.locator('#content').screenshot({ path: path.join(SHOTS, `pdf-${label}-${state}-${theme}.png`) });
  }
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

try {
  await poll(
    async () => (await page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length)) > 0,
    { what: 'tree' }
  );
  await page.setViewportSize?.({ width: 1440, height: 900 });

  await openPath('docs');
  const spec = await openAndWait('specification-v2.pdf', (s) => s.shown && s.drawn.length > 0);
  await settle();
  console.log('spec:', await pane());
  await shoot('spec');

  // Scroll down: the page number follows.
  await page.evaluate(() => { document.querySelector('.pdf-view').scrollTop = 2600; });
  await settle();
  console.log('spec scrolled:', await pane());

  // Zoom in twice by button, then back to width.
  await page.click('.pdf-tools__zoom-in');
  await page.click('.pdf-tools__zoom-in');
  await settle();
  console.log('zoomed in:', await pane());
  await shoot('spec-zoomed');
  await page.click('.pdf-tools__fit');
  await settle();

  // Jump to page 7 by keyboard: focus the field, type, Enter.
  await page.focus('.pdf-tools__page');
  await page.keyboard.type('7');
  await page.keyboard.press('Enter');
  await settle();
  console.log('after jump to 7:', await pane(), await page.evaluate(() => ({
    focus: document.activeElement?.className,
  })));
  await page.focus('.pdf-view');
  await shoot('spec-page7-focus');
  // Clicking into a page must not follow its links.
  await page.mouse.click(700, 400);
  await settle();

  await openPath('manuals');
  const long = await openAndWait('operator-handbook.pdf', (s) => s.shown && s.drawn.length > 0);
  await page.evaluate(() => { document.querySelector('.pdf-view').scrollTop = 1e9; });
  await settle(800);
  console.log('300 pages at the end:', await pane());
  await shoot('long-end');

  await openPath('invoices');
  console.log('one page:', await openAndWait('2026-09-invoice.pdf', (s) => s.shown && s.drawn.length > 0));
  await settle();
  await shoot('one-page');

  await openPath('contracts');
  console.log('locked:', await openAndWait('nda-signed.pdf', (s) => Boolean(s.message)));
  await shoot('password');
  await page.keyboard.type('wrong');
  await page.keyboard.press('Enter');
  await poll(async () => (await pane()).message?.includes(await page.evaluate(() =>
    document.querySelector('.pdf-view__password-feedback')?.textContent || '§')), { what: 'wrong password feedback' });
  console.log('wrong password:', await pane(), await page.evaluate(() => document.activeElement?.className));
  await shoot('password-wrong');
  await page.fill('.pdf-view__password-input', 'secret');
  await page.keyboard.press('Enter');
  console.log('right password:', await poll(async () => {
    const s = await pane();
    return s.shown && s.drawn.length > 0 ? s : null;
  }, { what: 'unlocked pdf' }));
  await settle();
  await shoot('password-open');

  await openPath('scans');
  console.log('too large:', await openAndWait('archive-2019.pdf', (s) => Boolean(s.message)));
  await shoot('too-large');
  await openPath('exports');
  console.log('broken:', await openAndWait('report.pdf', (s) => Boolean(s.message)));
  await shoot('broken');
  console.log('not a pdf:', await openAndWait('notes.pdf', (s) => Boolean(s.message)));
  console.log('outside:', await openAndWait('outside.pdf', (s) => Boolean(s.message)));

  // Narrow column: the header has to hold name, page, zoom and size.
  await openAndWait('specification-v2.pdf', (s) => s.shown && s.drawn.length > 0);
  await page.evaluate(() => {
    const content = document.getElementById('content');
    content.style.flex = '0 0 420px';
    content.style.maxWidth = '420px';
  });
  await settle(600);
  console.log('narrow:', await pane());
  await shoot('narrow');

  console.log('PDF JavaScript ran:', await page.evaluate(() => globalThis.__pwnedPdf ?? null));
  console.log('CSP violations:', await page.evaluate(() => globalThis.__cspViolations));
  console.log(`requests outside file:/data: (${HOSTILE_HOST} must not appear):`, requests);
  console.log('console problems:', problems.slice(0, 20));
} finally {
  await snotra.stop().catch(() => {});
  await model.close();
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
  await rm(userDataDir, { recursive: true, force: true });
}
