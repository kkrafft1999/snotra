'use strict';

// extract_document_text as the model meets it (#42): the path checks of every
// read tool, the worker with its time budget, the sensitivity check on the
// extracted text and the mark in the tree. Office files go through the real
// worker here — they need no pdf.js, so plain Node runs them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { createDocumentTextService } = require('../src/main/services/document-text-service');
const { createDocumentTextExtractor, pdfjsDataUrl } = require('../src/main/services/document-text-worker');
const { summarizeToolCall } = require('../src/shared/presentation/tool-display');
const { toolCategory } = require('../src/shared/contracts/tool-categories');
const { makeDocx, makeXlsx, p } = require('./helpers/ooxml-fixtures');

const PDFJS_DIR = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'pdfjs');

async function makeFixture(t, { extractor, maxBytes } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-doctext-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'projekt');
  await fs.mkdir(path.join(workspace, 'docs'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'docs', 'angebot.docx'), makeDocx({ body: p('Angebot') + p('Preis 900 €') }));
  await fs.writeFile(path.join(base, 'outside.docx'), makeDocx({ body: p('außerhalb') }));
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  const documentText = createDocumentTextService({
    fs,
    fsService,
    extractor: extractor || createDocumentTextExtractor({ pdfjsDir: PDFJS_DIR }),
    ...(maxBytes ? { maxBytes } : {}),
  });
  const registry = createWorkspaceToolRegistry({ fsService, documentText });
  const adapter = createWorkspaceToolAdapter(registry, { fsService, fs, path });
  const run = async (args, context = {}) => {
    const plan = await adapter.plan('extract_document_text', args, { workspaceRoot: workspace });
    return adapter.execute('extract_document_text', args, { workspaceRoot: workspace, approved: true, plan, ...context });
  };
  return { base, workspace, registry, run };
}

test('the tool is offered with its extractor, as a read tool', async (t) => {
  const { registry } = await makeFixture(t);
  const tool = registry.getTools().find((entry) => entry.function.name === 'extract_document_text');
  assert.ok(tool, 'offered to the model');
  assert.deepEqual(tool.function.parameters.required, ['relative_path']);
  assert.equal(registry.getDefinition('extract_document_text').riskClass, 'read');
  assert.equal(toolCategory('extract_document_text'), 'read');
});

test('a document in the folder: text, size and the mark in the tree', async (t) => {
  const { run } = await makeFixture(t);
  const result = await run({ relative_path: 'docs/angebot.docx' });
  const out = JSON.parse(result.output);
  assert.equal(out.relative_path, 'docs/angebot.docx');
  assert.equal(out.format, 'docx');
  assert.ok(out.size_bytes > 0);
  assert.equal(out.content, 'Angebot\nPreis 900 €');
  assert.deepEqual(result.progressEvents.map((event) => event.relativePath), ['docs/angebot.docx']);
  assert.equal(result.sensitive, undefined);
});

test('the path checks of every read tool apply', async (t) => {
  const { run, workspace } = await makeFixture(t);
  const outside = JSON.parse((await run({ relative_path: '../outside.docx' })).output);
  assert.ok(outside.error, 'outside the folder is refused');
  assert.doesNotMatch(JSON.stringify(outside), /außerhalb/);
  assert.match(JSON.parse((await run({ relative_path: 'docs' })).output).error, /folder, not a file/);
  assert.match(JSON.parse((await run({ relative_path: '' })).output).error, /relative_path is required/);
  assert.match(JSON.parse((await run({ relative_path: 'docs/angebot.docx', start_character: -3 })).output).error, /whole number/);
  await fs.writeFile(path.join(workspace, 'notes.txt'), 'nur Text\n');
  assert.match(JSON.parse((await run({ relative_path: 'notes.txt' })).output).error, /read_file_text/);
});

test('a file above the size limit is not read', async (t) => {
  const { run } = await makeFixture(t, { maxBytes: 100 });
  assert.match(JSON.parse((await run({ relative_path: 'docs/angebot.docx' })).output).error, /too large/);
});

test('the extracted text is checked for secrets, not the compressed bytes', async (t) => {
  const { run, workspace } = await makeFixture(t);
  await fs.writeFile(path.join(workspace, 'docs', 'zugang.docx'), makeDocx({ body: p('api_key = "abcdefgh12345678"') }));
  const result = await run({ relative_path: 'docs/zugang.docx' });
  assert.equal(JSON.parse(result.output).format, 'docx');
  assert.equal(result.sensitive, true);
});

test('arguments reach the extractor; numbers for pages are accepted', async (t) => {
  const seen = [];
  const extractor = {
    extract: async (bytes, request, { abortSignal } = {}) => {
      seen.push({ request, hasSignal: Boolean(abortSignal), isBuffer: Buffer.isBuffer(bytes) });
      return { format: 'pdf', page_count: 9, content: 'x' };
    },
  };
  const { run } = await makeFixture(t, { extractor });
  const controller = new AbortController();
  await run(
    { relative_path: 'docs/angebot.docx', pages: 3, sheet: 'S', range: 'A1:B2', start_character: 7, max_characters: 2000 },
    { abortSignal: controller.signal },
  );
  assert.deepEqual(seen, [{
    request: { pages: '3', sheet: 'S', range: 'A1:B2', startCharacter: 7, maxCharacters: 2000 },
    hasSignal: true,
    isBuffer: true,
  }]);
});

test('worker: a stopped run and an exhausted time budget end the extraction', async (t) => {
  const rows = Array.from({ length: 60000 }, (_, r) => [`Zeile ${r}`, r, `Wert ${r}`]);
  const big = makeXlsx({ sheets: [{ name: 'Groß', rows }] });

  const slow = createDocumentTextExtractor({ pdfjsDir: PDFJS_DIR, timeBudgetMs: 1 });
  assert.match((await slow.extract(big, {})).error, /longer than 0 s/);

  const extractor = createDocumentTextExtractor({ pdfjsDir: PDFJS_DIR });
  const controller = new AbortController();
  const pending = extractor.extract(big, {}, { abortSignal: controller.signal });
  controller.abort();
  assert.match((await pending).error, /cancelled/);
  assert.match((await extractor.extract(big, {}, { abortSignal: controller.signal })).error, /cancelled/);

  const whole = await extractor.extract(big, { range: 'A59999:C60000' });
  assert.equal(whole.content, 'row\tA\tB\tC\n59999\tZeile 59998\t59998\tWert 59998\n60000\tZeile 59999\t59999\tWert 59999');
  t.diagnostic('the worker reads a 60 000-row sheet and answers with two rows');
});

test('the line in the chat log names the document', () => {
  assert.equal(summarizeToolCall('extract_document_text', { relative_path: 'docs/a.pdf' }, 'start', 'en'), 'Reading document docs/a.pdf …');
  assert.equal(summarizeToolCall('extract_document_text', { relative_path: 'docs/a.pdf' }, 'done', 'de'), 'Dokument docs/a.pdf gelesen');
  assert.equal(summarizeToolCall('extract_document_text', {}, 'start', 'de'), 'Dokument wird gelesen …');
});

// pdf.js refuses a data folder that does not end in "/" — on Windows a
// trailing backslash failed every PDF in CI (#42).
test('the pdf.js data folders end in a slash on every platform', () => {
  assert.equal(pdfjsDataUrl('C:\\Snotra\\vendor\\pdfjs', 'cmaps', path.win32), 'C:\\Snotra\\vendor\\pdfjs\\cmaps/');
  assert.equal(pdfjsDataUrl('/app/vendor/pdfjs', 'standard_fonts', path.posix), '/app/vendor/pdfjs/standard_fonts/');
});
