'use strict';

// apply_patch and edit_file put a change where it was approved, and nothing
// else (#647): misordered hunks and two spellings of one file are refused, CRLF
// files stay CRLF, every untouched line keeps its own ending, a BOM stays at
// byte 0, and a patch to an empty file ends with a newline. The hunk search
// tests candidate positions only (#650).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');

const LIMITS = { maxReadFileBytes: 4 * 1024 * 1024, maxWriteFileBytes: 4 * 1024 * 1024 };
const BOM = '﻿';

async function makeWorkspace(t, files = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-patch-fidelity-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(workspace, ...rel.split('/'));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
  return workspace;
}

function makeRunner(workspace) {
  const registry = createWorkspaceToolRegistry({ fsService: createFsService({ fs, path, ...LIMITS }) });
  return async (name, args) =>
    JSON.parse(await registry.execute(name, args, { approved: true, workspaceRoot: workspace, allowWrite: true }));
}

const diff = (...lines) => `${lines.join('\n')}\n`;
const read = (workspace, rel) => fs.readFile(path.join(workspace, ...rel.split('/')), 'utf8');
const hasBareLf = (text) => /(^|[^\r])\n/.test(text);

// ── Misordered hunks and two spellings of one file ─────────────────────────

test('hunks sent out of order are refused and the file stays unchanged (#647)', async (t) => {
  const lines = ['function a() {', '  return null;', '}'];
  for (let i = 4; i <= 13; i += 1) lines.push(`// ${i}`);
  lines.push('function b() {', '  return null;', '}');
  const original = `${lines.join('\n')}\n`;
  const workspace = await makeWorkspace(t, { 'a.js': original });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff(
      '--- a.js', '+++ a.js',
      '@@ -15,1 +15,1 @@', '-  return null;', '+  return 2;',
      '@@ -2,1 +2,1 @@', '-  return null;', '+  return 1;'
    ),
  });

  assert.match(out.error, /Hunk 2 of 2 does not apply to "a\.js": its lines stand at line 2,.*ascending line order/);
  assert.equal(await read(workspace, 'a.js'), original);
});

test('overlapping hunks are refused as well (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'a.txt': 'a\nb\nc\nd\n' });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff('--- a.txt', '+++ a.txt', '@@ -1,2 +1,2 @@', ' a', '-b', '+B', '@@ -2,2 +2,2 @@', ' b', '-c', '+C'),
  });

  assert.match(out.error, /must not overlap/);
  assert.equal(await read(workspace, 'a.txt'), 'a\nb\nc\nd\n');
});

test('two spellings of one file in a patch are refused and the file stays unchanged (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'src/app.js': 'one\ntwo\n' });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff(
      '--- src/app.js', '+++ src/app.js', '@@ -1,1 +1,1 @@', '-one', '+ONE',
      '--- src/../src/app.js', '+++ src/../src/app.js', '@@ -2,1 +2,1 @@', '-two', '+TWO'
    ),
  });

  assert.match(out.error, /"src\/\.\.\/src\/app\.js" appears more than once in the patch \(also as "src\/app\.js"\)/);
  assert.equal(await read(workspace, 'src/app.js'), 'one\ntwo\n');
});

test('a case variant of one file is refused on a case-insensitive file system (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'src/app.js': 'one\ntwo\n' });
  const caseInsensitive = await fs.stat(path.join(workspace, 'src', 'APP.JS')).then(() => true, () => false);
  if (!caseInsensitive) {
    t.skip('this file system tells upper and lower case apart');
    return;
  }
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff(
      '--- src/app.js', '+++ src/app.js', '@@ -1,1 +1,1 @@', '-one', '+ONE',
      '--- src/App.js', '+++ src/App.js', '@@ -2,1 +2,1 @@', '-two', '+TWO'
    ),
  });

  assert.match(out.error, /"src\/App\.js" appears more than once/);
  assert.equal(await read(workspace, 'src/app.js'), 'one\ntwo\n');
});

// ── CRLF in the edit paths ─────────────────────────────────────────────────

test('edit_file matches a multi-line old_string in a CRLF file and writes CRLF (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
  const run = makeRunner(workspace);

  const multiOld = await run('edit_file', { relative_path: 'a.txt', old_string: 'one\ntwo', new_string: 'ONE\nTWO' });
  assert.equal(multiOld.error, undefined);
  assert.equal(multiOld.first_changed_line, 1);
  assert.equal(await read(workspace, 'a.txt'), 'ONE\r\nTWO\r\nthree\r\n');

  const multiNew = await run('edit_file', { relative_path: 'a.txt', old_string: 'three', new_string: 'three\nfour' });
  assert.equal(multiNew.error, undefined);
  assert.equal(multiNew.first_changed_line, 3);
  const text = await read(workspace, 'a.txt');
  assert.equal(text, 'ONE\r\nTWO\r\nthree\r\nfour\r\n');
  assert.equal(hasBareLf(text), false);
});

test('the edits form matches multi-line text in a CRLF file and writes CRLF (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    relative_path: 'a.txt',
    edits: [
      { old_string: 'one\ntwo', new_string: 'ONE\nTWO' },
      { old_string: 'three', new_string: 'three\nfour' },
    ],
  });

  assert.equal(out.error, undefined);
  const text = await read(workspace, 'a.txt');
  assert.equal(text, 'ONE\r\nTWO\r\nthree\r\nfour\r\n');
  assert.equal(hasBareLf(text), false);
});

test('edit text with a \\r of its own is taken as written, and an LF file stays LF (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'crlf.txt': 'one\r\ntwo\r\n', 'lf.txt': 'one\ntwo\n' });
  const run = makeRunner(workspace);

  await run('edit_file', { relative_path: 'crlf.txt', old_string: 'one\r\ntwo', new_string: 'ONE\r\nTWO' });
  assert.equal(await read(workspace, 'crlf.txt'), 'ONE\r\nTWO\r\n');
  await run('edit_file', { relative_path: 'lf.txt', old_string: 'one\ntwo', new_string: 'ONE\nTWO\nthree' });
  assert.equal(await read(workspace, 'lf.txt'), 'ONE\nTWO\nthree\n');
});

// ── Line endings, lone CR and BOM in apply_patch ───────────────────────────

test('apply_patch keeps the ending of every line it does not touch (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'mixed.txt': 'l1\nl2\nl3\nl4\r\n', 'mostly-crlf.txt': 'a\r\nb\nc\r\nd\r\n' });
  const run = makeRunner(workspace);

  await run('apply_patch', { patch: diff('--- mixed.txt', '+++ mixed.txt', '@@ -1,1 +1,1 @@', '-l1', '+L1') });
  assert.equal(await read(workspace, 'mixed.txt'), 'L1\nl2\nl3\nl4\r\n');

  // A new line gets the majority ending; b keeps its own LF.
  await run('apply_patch', { patch: diff('--- mostly-crlf.txt', '+++ mostly-crlf.txt', '@@ -3,1 +3,2 @@', ' c', '+x') });
  assert.equal(await read(workspace, 'mostly-crlf.txt'), 'a\r\nb\nc\r\nx\r\nd\r\n');
});

test('apply_patch splits only on \\n and \\r\\n — a lone \\r stays content (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'pct.txt': '10%\r20%\r30%\nnext\n' });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', { patch: diff('--- pct.txt', '+++ pct.txt', '@@ -2,1 +2,1 @@', '-next', '+NEXT') });

  assert.equal(out.error, undefined);
  assert.equal(await read(workspace, 'pct.txt'), '10%\r20%\r30%\nNEXT\n');
});

test('a hunk on line 1 of a BOM file applies and the BOM stays at byte 0 (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'bom.txt': `${BOM}first\nsecond\n` });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff('--- bom.txt', '+++ bom.txt', '@@ -1,2 +1,2 @@', '-first', '+FIRST', ' second'),
  });

  assert.equal(out.error, undefined);
  assert.equal(out.files[0].line_offsets, undefined);
  assert.equal(await read(workspace, 'bom.txt'), `${BOM}FIRST\nsecond\n`);
});

test('a prepend to a BOM file keeps the BOM at byte 0 (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'bom.txt': `${BOM}first\n` });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', { patch: diff('--- bom.txt', '+++ bom.txt', '@@ -0,0 +1,1 @@', '+zeroth') });

  assert.equal(out.error, undefined);
  const bytes = await fs.readFile(path.join(workspace, 'bom.txt'));
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), `${BOM}zeroth\nfirst\n`);
});

// ── Empty file ─────────────────────────────────────────────────────────────

test('a patch to an empty file ends with a newline unless the patch says otherwise (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'empty.txt': '', 'empty-no-eol.txt': '' });
  const run = makeRunner(workspace);

  await run('apply_patch', { patch: diff('--- empty.txt', '+++ empty.txt', '@@ -0,0 +1,2 @@', '+a', '+b') });
  assert.equal(await read(workspace, 'empty.txt'), 'a\nb\n');

  await run('apply_patch', {
    patch: diff('--- empty-no-eol.txt', '+++ empty-no-eol.txt', '@@ -0,0 +1,2 @@', '+a', '+b', '\\ No newline at end of file'),
  });
  assert.equal(await read(workspace, 'empty-no-eol.txt'), 'a\nb');
});

// ── Hunk search (#650) ─────────────────────────────────────────────────────

test('a displaced hunk lands on the nearest match, the earlier one on a tie (#650)', async (t) => {
  const workspace = await makeWorkspace(t, { 'a.txt': 'a\nb\nm\nc\nd\ne\nm\nf\n' });
  const run = makeRunner(workspace);

  // Expected at line 5; "m" stands at lines 3 and 7, two lines away either way.
  const out = await run('apply_patch', { patch: diff('--- a.txt', '+++ a.txt', '@@ -5,1 +5,1 @@', '-m', '+M') });

  assert.deepEqual(out.files[0].line_offsets, [-2]);
  assert.equal(await read(workspace, 'a.txt'), 'a\nb\nM\nc\nd\ne\nm\nf\n');
});

test('a 10k-line hunk that does not match a 300k-line file is refused quickly (#650)', async (t) => {
  const workspace = await makeWorkspace(t, { 'data.csv': 'x\n'.repeat(300000) });
  const run = makeRunner(workspace);
  const context = Array.from({ length: 10000 }, () => ' x');
  const patch = diff('--- data.csv', '+++ data.csv', '@@ -1,10001 +1,10001 @@', ...context, '-y', '+z');

  const started = process.hrtime.bigint();
  const out = await run('apply_patch', { patch });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.match(out.error, /context does not match/);
  // Measured at ~20 ms; the margin is for Windows runners with Defender scanning.
  assert.ok(elapsedMs < 1000, `took ${elapsedMs.toFixed(1)} ms`);
});

test('a 10k-line hunk displaced far into a 300k-line file is found quickly (#650)', async (t) => {
  const lines = Array.from({ length: 300000 }, () => 'x');
  lines[250000] = 'y';
  const workspace = await makeWorkspace(t, { 'data.csv': `${lines.join('\n')}\n` });
  const run = makeRunner(workspace);
  const context = Array.from({ length: 10000 }, () => ' x');
  const patch = diff('--- data.csv', '+++ data.csv', '@@ -1,10001 +1,10001 @@', ...context, '-y', '+z');

  const started = process.hrtime.bigint();
  const out = await run('apply_patch', { patch });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(out.error, undefined);
  assert.deepEqual(out.files[0].line_offsets, [240000]);
  assert.ok(elapsedMs < 500, `took ${elapsedMs.toFixed(1)} ms`);
  const text = await read(workspace, 'data.csv');
  assert.equal(text.split('\n')[250000], 'z');
});
