// extract_document_text in the real app (#42): the model asks for a PDF and a
// workbook, and what comes back is their text — through the composition root,
// the worker and the pdf.js the preview ships.
//
// The unit tests cover the Office formats and the window over a stand-in PDF;
// pdf.js itself needs Electron's runtime (`Uint8Array.prototype.toHex`), so
// the real PDF path is proven here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';
import { makeEncryptedPdf, makeTextPdf } from './helpers/pdf-fixtures.mjs';

const require = createRequire(import.meta.url);
const { makeXlsx } = require('../test/helpers/ooxml-fixtures.js');

test('the model reads a PDF and a workbook through extract_document_text', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-doctext-');
  const userDataDir = await makeTempDir('snotra-doctext-userdata-');
  await mkdir(path.join(workspace, 'docs'), { recursive: true });
  await writeFile(path.join(workspace, 'docs', 'manual.pdf'), makeTextPdf({ pages: 40, title: 'Operator manual' }));
  await writeFile(path.join(workspace, 'docs', 'locked.pdf'), makeEncryptedPdf({ password: 'secret' }));
  await writeFile(path.join(workspace, 'docs', 'budget.xlsx'), makeXlsx({
    sheets: [{ name: 'Plan', rows: [['Item', 'Amount'], ['Licence', 900], ['Hosting', 120]] }],
  }));
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;

  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  model.queueAnswer({
    match: 'Summarise the documents',
    toolCalls: [
      { name: 'extract_document_text', arguments: { relative_path: 'docs/manual.pdf', pages: '39-', max_characters: 2000 } },
      { name: 'extract_document_text', arguments: { relative_path: 'docs/manual.pdf', max_characters: 1000 } },
      { name: 'extract_document_text', arguments: { relative_path: 'docs/locked.pdf' } },
      { name: 'extract_document_text', arguments: { relative_path: 'docs/budget.xlsx' } },
    ],
  });
  model.queueAnswer({ text: 'Done.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Summarise the documents.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });

  const toolResults = () => {
    const request = model.requests.find((r) => !r.isTitleRequest
      && r.body.messages?.filter((m) => m.role === 'tool').length >= 4);
    return request ? request.body.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content)) : null;
  };
  await poll(async () => {
    await page.evaluate(() => {
      document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])')?.click();
    });
    return toolResults() !== null;
  }, {
    what: 'the four tool results sent back to the model',
    timeoutMs: 60000,
    explain: async () => `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}\nmain:\n${snotra.mainOutput()}`,
  });

  const [tail, head, locked, budget] = toolResults();
  // The whole result on failure: on Windows an error came back where a PDF should.
  assert.equal(tail.format, 'pdf', JSON.stringify(tail));
  assert.equal(head.format, 'pdf', JSON.stringify(head));
  assert.equal(tail.page_count, 40);
  assert.equal(tail.pages, '39-40');
  assert.equal(tail.truncated, false);
  assert.match(tail.content, /^\[Page 39\]\nOperator manual\nPage 39 of 40\nThis page is drawn by pdf\.js inside Snotra\./);
  assert.match(tail.content, /\[Page 40\]\nOperator manual\nPage 40 of 40/);

  assert.equal(head.truncated, true);
  assert.equal(head.next_start_character, 1000);
  assert.match(head.pages, /^1-\d$/, 'only the first pages were read');

  assert.deepEqual(locked, { error: 'The PDF is password-protected; its text cannot be read.' });

  assert.equal(budget.format, 'xlsx');
  assert.equal(budget.sheet, 'Plan');
  assert.equal(budget.content, 'row\tA\tB\n1\tItem\tAmount\n2\tLicence\t900\n3\tHosting\t120');

  // The log line names what was read.
  await poll(() => page.evaluate(() => document.body.textContent.includes('Document docs/budget.xlsx read')),
    { what: 'tool line in the chat' });
});
