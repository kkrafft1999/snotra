// The PDF preview's main-process side (#346): the contract, the read of a PDF
// from the open folder, and the reader for the files pdf.js asks for.
//
// Against real files, like the image tests (#244): a symlink that points out
// of the workspace is only proof as a real symlink.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createPdfAssetReader } = require('../src/main/services/pdf-assets');
const {
  MAX_WORKSPACE_PDF_BYTES,
  WORKSPACE_PDF_ERRORS,
  PDF_ASSET_DIRS,
  isPdfHeader,
  isPdfAssetName,
  createWorkspacePdfError,
} = require('../src/shared/contracts/workspace-pdf');
const contracts = require('../src/shared/contracts');
const { removeTempDir } = require('./helpers/temp-dir');

const PDF = Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n', 'latin1');

async function makeWorkspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-ws-pdf-'));
  t.after(() => removeTempDir(dir));
  return fs.realpath(dir);
}

const makeFsService = () => createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });

// ── Contract ───────────────────────────────────────────────────────────────

test('a PDF is recognised by %PDF- within the first kilobyte, not by its name', () => {
  assert.equal(isPdfHeader(PDF), true);
  assert.equal(isPdfHeader(Buffer.concat([Buffer.from('junk before the header\n'), PDF])), true);
  assert.equal(isPdfHeader(Buffer.concat([Buffer.alloc(1100, 0x20), PDF])), false, 'past the first kilobyte');
  assert.equal(isPdfHeader(Buffer.from('%PDF')), false, 'the dash belongs to it');
  assert.equal(isPdfHeader(Buffer.from('just text')), false);
  assert.equal(isPdfHeader(null), false);
});

test('pdf.js may ask for plain file names only', () => {
  for (const name of ['78-EUC-H.bcmap', 'FoxitSerif.pfb', 'LiberationSans-Regular.ttf', 'openjpeg.wasm', 'jbig2_nowasm_fallback.js']) {
    assert.equal(isPdfAssetName(name), true, name);
  }
  for (const name of ['../main/index.js', '..', '.hidden', 'a/b.bcmap', 'a\\b.bcmap', '', null, 'x'.repeat(200), 'C:evil']) {
    assert.equal(isPdfAssetName(name), false, String(name));
  }
  assert.deepEqual(Object.keys(PDF_ASSET_DIRS).sort(), ['cMapUrl', 'standardFontDataUrl', 'wasmUrl']);
});

test('an unknown reason becomes not-found, and the contract reaches the renderer bundle', () => {
  assert.equal(createWorkspacePdfError('nonsense').reason, WORKSPACE_PDF_ERRORS.NOT_FOUND);
  assert.equal(createWorkspacePdfError(WORKSPACE_PDF_ERRORS.TOO_LARGE, { size: 7 }).size, 7);
  assert.equal(contracts.MAX_WORKSPACE_PDF_BYTES, MAX_WORKSPACE_PDF_BYTES);
  assert.equal(contracts.WORKSPACE_PDF_ERRORS, WORKSPACE_PDF_ERRORS);
});

// ── fs-service ─────────────────────────────────────────────────────────────

test('a PDF from the workspace arrives as bytes, with size and mtime', async (t) => {
  const root = await makeWorkspace(t);
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'spec.pdf'), PDF);
  const result = await makeFsService().readWorkspacePdf(root, path.join(root, 'docs', 'spec.pdf'));
  assert.equal(result.ok, true);
  assert.ok(Buffer.isBuffer(result.bytes), 'a Buffer, which IPC hands over as a Uint8Array');
  assert.deepEqual(result.bytes, PDF);
  assert.equal(result.size, PDF.length);
  assert.ok(result.mtimeMs > 0);
});

test('what is not a PDF, too large, missing or outside says why', async (t) => {
  const root = await makeWorkspace(t);
  const outside = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'notes.pdf'), 'plain text with a pdf name');
  await fs.writeFile(path.join(outside, 'secret.pdf'), PDF);
  const big = path.join(root, 'big.pdf');
  const handle = await fs.open(big, 'w');
  await handle.write(PDF);
  await handle.truncate(MAX_WORKSPACE_PDF_BYTES + 1);
  await handle.close();
  const svc = makeFsService();

  const notPdf = await svc.readWorkspacePdf(root, 'notes.pdf');
  assert.equal(notPdf.reason, WORKSPACE_PDF_ERRORS.NOT_PDF);
  const tooLarge = await svc.readWorkspacePdf(root, 'big.pdf');
  assert.equal(tooLarge.reason, WORKSPACE_PDF_ERRORS.TOO_LARGE);
  assert.equal(tooLarge.size, MAX_WORKSPACE_PDF_BYTES + 1, 'the size comes along, for the sentence');
  assert.equal((await svc.readWorkspacePdf(root, 'gone.pdf')).reason, WORKSPACE_PDF_ERRORS.NOT_FOUND);
  assert.equal((await svc.readWorkspacePdf(root, path.join(outside, 'secret.pdf'))).reason, WORKSPACE_PDF_ERRORS.OUTSIDE_WORKSPACE);
  assert.equal((await svc.readWorkspacePdf(root, '../secret.pdf')).reason, WORKSPACE_PDF_ERRORS.OUTSIDE_WORKSPACE);
  assert.equal((await svc.readWorkspacePdf(null, 'x.pdf')).reason, WORKSPACE_PDF_ERRORS.NO_WORKSPACE);
});

test('a symlink pointing out of the workspace is not followed', async (t) => {
  const root = await makeWorkspace(t);
  const outside = await makeWorkspace(t);
  await fs.writeFile(path.join(outside, 'secret.pdf'), PDF);
  try {
    await fs.symlink(path.join(outside, 'secret.pdf'), path.join(root, 'link.pdf'));
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) return t.skip(`no symlinks here: ${e.code}`);
    throw e;
  }
  const result = await makeFsService().readWorkspacePdf(root, 'link.pdf');
  assert.equal(result.ok, false);
  assert.equal(result.reason, WORKSPACE_PDF_ERRORS.OUTSIDE_WORKSPACE);
  assert.equal(result.bytes, undefined);
});

// ── pdf-assets ─────────────────────────────────────────────────────────────

test('the asset reader serves the three folders and nothing else', async (t) => {
  const root = await makeWorkspace(t);
  for (const dir of Object.values(PDF_ASSET_DIRS)) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, 'cmaps', 'Adobe-Japan1-UCS2.bcmap'), Buffer.from([1, 2, 3]));
  await fs.writeFile(path.join(root, 'wasm', 'openjpeg.wasm'), Buffer.from([0, 97, 115, 109]));
  await fs.writeFile(path.join(root, 'pdf.worker.min.mjs'), 'not an asset');
  const { readPdfAsset } = createPdfAssetReader({ fs, path, rootDir: root });

  const cmap = await readPdfAsset('cMapUrl', 'Adobe-Japan1-UCS2.bcmap');
  assert.equal(cmap.ok, true);
  assert.deepEqual([...cmap.bytes], [1, 2, 3]);
  assert.equal((await readPdfAsset('wasmUrl', 'openjpeg.wasm')).ok, true);

  assert.deepEqual(await readPdfAsset('wasmUrl', 'missing.wasm'), { ok: false });
  assert.deepEqual(await readPdfAsset('cMapUrl', '../pdf.worker.min.mjs'), { ok: false }, 'no way up');
  assert.deepEqual(await readPdfAsset('iccUrl', 'x.icc'), { ok: false }, 'an unknown kind');
  assert.deepEqual(await readPdfAsset('__proto__', 'x'), { ok: false });
  assert.deepEqual(await readPdfAsset('cMapUrl', 'Adobe-Japan1-UCS2.bcmap/'), { ok: false });
});

test('the vendored pdf.js has what the reader serves, and no scripting sandbox', async (t) => {
  const vendor = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'pdfjs');
  try {
    await fs.access(vendor);
  } catch {
    return t.skip('vendor/pdfjs is created by `npm run sync-vendor` (pretest)');
  }
  const { readPdfAsset } = createPdfAssetReader({ fs, path, rootDir: vendor });
  assert.equal((await readPdfAsset('standardFontDataUrl', 'FoxitSerif.pfb')).ok, true);
  assert.equal((await readPdfAsset('cMapUrl', '78-EUC-H.bcmap')).ok, true);
  assert.equal((await readPdfAsset('wasmUrl', 'openjpeg.wasm')).ok, true);
  assert.equal((await readPdfAsset('wasmUrl', 'quickjs-eval.wasm')).ok, false, 'PDF JavaScript never runs');
  const files = await fs.readdir(vendor);
  assert.ok(!files.some((f) => f.includes('sandbox')), files.join(', '));
});

test('the vendored pdf.js compiles no code from strings: in the worker nothing else would stop it', async (t) => {
  // The worker comes from a file: URL and gets no CSP; `isEvalSupported` is
  // gone from pdf.js 6 (#641, docs/architecture/architecture.md *PDFs*).
  const vendor = path.join(__dirname, '..', 'src', 'renderer', 'vendor', 'pdfjs');
  let scripts;
  try {
    scripts = ['pdf.min.mjs', 'pdf.worker.min.mjs', ...(await fs.readdir(path.join(vendor, 'wasm')))
      .filter((f) => f.endsWith('.js')).map((f) => path.join('wasm', f))];
  } catch {
    return t.skip('vendor/pdfjs is created by `npm run sync-vendor` (pretest)');
  }
  for (const script of scripts) {
    const source = await fs.readFile(path.join(vendor, script), 'utf8');
    assert.doesNotMatch(source, /(?<![\w$.])(?:Function|eval)\(|\bnew Function\b/, script);
  }
});

// ── Writing a comment (#1386) ──────────────────────────────────────────────

const APPENDED = Buffer.from('\n2 0 obj\n<<>>\nendobj\n%%EOF\n', 'latin1');

test('a comment is written when the new bytes append to the file on disk', async (t) => {
  const root = await makeWorkspace(t);
  const file = path.join(root, 'spec.pdf');
  await fs.writeFile(file, PDF);
  await fs.chmod(file, 0o640);
  const next = new Uint8Array(Buffer.concat([PDF, APPENDED]));
  const result = await makeFsService().writeWorkspacePdfFromUser(root, file, next);
  assert.equal(result.ok, true);
  assert.equal(result.size, next.length);
  assert.deepEqual(await fs.readFile(file), Buffer.from(next));
  if (process.platform !== 'win32') assert.equal((await fs.stat(file)).mode & 0o777, 0o640, 'the mode stays');
  const leftovers = (await fs.readdir(root)).filter((name) => name !== 'spec.pdf');
  assert.deepEqual(leftovers, [], 'no temporary file is left behind');
});

test('a workspace opened through a link takes comments too', async (t) => {
  // macOS keeps temporary folders behind /var → /private/var; a folder the
  // user opened may sit behind a link the same way.
  const real = await makeWorkspace(t);
  const holder = await makeWorkspace(t);
  const root = path.join(holder, 'linked');
  try {
    await fs.symlink(real, root, 'dir');
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) return t.skip(`no symlinks here: ${e.code}`);
    throw e;
  }
  await fs.writeFile(path.join(real, 'spec.pdf'), PDF);
  const next = new Uint8Array(Buffer.concat([PDF, APPENDED]));
  const result = await makeFsService().writeWorkspacePdfFromUser(root, path.join(root, 'spec.pdf'), next);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(await fs.readFile(path.join(real, 'spec.pdf')), Buffer.from(next));
});

test('a file changed on disk since it was read is not overwritten', async (t) => {
  const root = await makeWorkspace(t);
  const file = path.join(root, 'spec.pdf');
  await fs.writeFile(file, PDF);
  const next = new Uint8Array(Buffer.concat([PDF, APPENDED]));
  // Someone else saved meanwhile: the old bytes are no longer the start.
  const theirs = Buffer.concat([PDF.subarray(0, 10), Buffer.from('X'), PDF.subarray(11)]);
  await fs.writeFile(file, theirs);
  const svc = makeFsService();
  assert.deepEqual(await svc.writeWorkspacePdfFromUser(root, file, next), { ok: false, reason: 'changed' });
  assert.deepEqual(await fs.readFile(file), theirs);
  // Bytes that only cut the file, or leave it as it is, are no update either.
  await fs.writeFile(file, PDF);
  assert.equal((await svc.writeWorkspacePdfFromUser(root, file, new Uint8Array(PDF))).reason, 'changed');
  assert.equal((await svc.writeWorkspacePdfFromUser(root, file, new Uint8Array(PDF.subarray(0, 20)))).reason, 'changed');
  assert.deepEqual(await fs.readFile(file), PDF);
});

test('what is not a PDF update, or not in the workspace, is refused with a reason', async (t) => {
  const root = await makeWorkspace(t);
  const outside = await makeWorkspace(t);
  await fs.writeFile(path.join(root, 'spec.pdf'), PDF);
  await fs.writeFile(path.join(outside, 'other.pdf'), PDF);
  let linked = true;
  try {
    await fs.symlink(path.join(outside, 'other.pdf'), path.join(root, 'link.pdf'));
  } catch (e) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e;
    linked = false;
  }
  const svc = makeFsService();
  const next = new Uint8Array(Buffer.concat([PDF, APPENDED]));
  assert.equal((await svc.writeWorkspacePdfFromUser(root, 'spec.pdf', 'text')).reason, 'invalid');
  assert.equal((await svc.writeWorkspacePdfFromUser(root, 'spec.pdf', new Uint8Array(Buffer.from('<html>')))).reason, 'invalid');
  assert.equal((await svc.writeWorkspacePdfFromUser(root, '../other.pdf', next)).reason, 'outside-workspace');
  if (linked) assert.equal((await svc.writeWorkspacePdfFromUser(root, 'link.pdf', next)).reason, 'outside-workspace');
  assert.equal((await svc.writeWorkspacePdfFromUser(root, 'gone.pdf', next)).reason, 'not-found');
  assert.equal((await svc.writeWorkspacePdfFromUser(null, 'spec.pdf', next)).reason, 'no-workspace');
  assert.deepEqual(await fs.readFile(path.join(outside, 'other.pdf')), PDF, 'nothing outside was touched');
  const tooLarge = new Uint8Array(MAX_WORKSPACE_PDF_BYTES + 1);
  tooLarge.set(PDF);
  assert.equal((await svc.writeWorkspacePdfFromUser(root, 'spec.pdf', tooLarge)).reason, 'too-large');
});

test('the write contract reaches the renderer with its reasons', () => {
  assert.equal(contracts.WORKSPACE_PDF_WRITE_ERRORS.CHANGED, 'changed');
  assert.equal(contracts.MAX_PDF_COMMENT_CHARS, 5000);
  assert.deepEqual(contracts.createWorkspacePdfWriteError('nonsense'), { ok: false, reason: 'failed' });
});

// ── The name a comment is signed with (#1386) ─────────────────────────────

const { createAccountName } = require('../src/main/services/account-name');

test('the comment author is the account\'s full name, else its login name', async () => {
  const mac = createAccountName({
    platform: 'darwin',
    userInfo: () => ({ username: 'kim', uid: 501 }),
    execFileFn: (file, args, options, done) => done(null, 'Kim Example\n'),
  });
  assert.equal(await mac.fullName(), 'Kim Example');

  const linux = createAccountName({
    platform: 'linux',
    userInfo: () => ({ username: 'kim', uid: 1000 }),
    readFileFn: async () => 'root:x:0:0:root:/root:/bin/sh\nkim:x:1000:1000:Kim Example,,,:/home/kim:/bin/bash\n',
  });
  assert.equal(await linux.fullName(), 'Kim Example');

  const failing = createAccountName({
    platform: 'darwin',
    userInfo: () => ({ username: 'kim', uid: 501 }),
    execFileFn: (file, args, options, done) => done(new Error('no id')),
  });
  assert.equal(await failing.fullName(), 'kim');

  const windows = createAccountName({ platform: 'win32', userInfo: () => ({ username: 'Kim\u0007', uid: -1 }) });
  assert.equal(await windows.fullName(), 'Kim', 'control characters go');

  let asked = 0;
  const once = createAccountName({
    platform: 'darwin',
    userInfo: () => ({ username: 'kim', uid: 501 }),
    execFileFn: (file, args, options, done) => {
      asked += 1;
      done(null, 'Kim');
    },
  });
  await once.fullName();
  await once.fullName();
  assert.equal(asked, 1, 'asked once and kept');
});
