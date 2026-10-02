'use strict';

// "Show changes" in the main process (#348): the line diff, the recorder that
// keeps before and after of every write, and the way the three writing tools
// hand both over — through the registry and the adapter, as in the app.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { splitLines, diffLines, countChanges } = require('../src/main/services/line-diff');
const { createFileChangeRecorder, analyze } = require('../src/main/services/file-change-recorder');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { createWorkspaceFileWrittenEvent, normalizeFileChangeSummary } = require('../src/shared/contracts/chat');
const { toolTraceEntryForStore } = require('../src/main/services/chat-history-normalization');

const LIMITS = { maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 };

/** Replays the runs on `a`; the result has to be `b`. */
function apply(segments, a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  for (const run of segments) {
    if (run.op === 'equal') {
      for (let k = 0; k < run.count; k += 1) {
        assert.equal(a[i], b[j], 'an equal run pairs equal lines');
        out.push(a[i]);
        i += 1;
        j += 1;
      }
    } else if (run.op === 'delete') {
      i += run.count;
    } else {
      for (let k = 0; k < run.count; k += 1) out.push(b[j++]);
    }
  }
  assert.equal(i, a.length, 'every old line is accounted for');
  return out;
}

// ── line-diff ──────────────────────────────────────────────────────────────

test('splitLines keeps each ending and does not invent a last empty line', () => {
  assert.deepEqual(splitLines('a\r\nb\nc'), { lines: ['a', 'b', 'c'], endings: ['\r\n', '\n', ''], trailingNewline: false });
  assert.deepEqual(splitLines('a\n'), { lines: ['a'], endings: ['\n'], trailingNewline: true });
  assert.deepEqual(splitLines(''), { lines: [], endings: [], trailingNewline: false });
  assert.deepEqual(splitLines('\n\n'), { lines: ['', ''], endings: ['\n', '\n'], trailingNewline: true });
  assert.deepEqual(splitLines('a\rb').lines, ['a', 'b']);
});

test('diffLines finds the shortest edit and puts removals before additions', () => {
  const a = ['one', 'two', 'three', 'four'];
  const b = ['one', 'TWO', 'three', 'four', 'five'];
  const { segments, approximate } = diffLines(a, b);
  assert.equal(approximate, false);
  assert.deepEqual(segments, [
    { op: 'equal', count: 1 },
    { op: 'delete', count: 1 },
    { op: 'insert', count: 1 },
    { op: 'equal', count: 2 },
    { op: 'insert', count: 1 },
  ]);
  assert.deepEqual(countChanges(segments), { added: 2, removed: 1 });
});

test('diffLines reconstructs the new side for random edits, and stays minimal on small ones', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let round = 0; round < 200; round += 1) {
    const a = Array.from({ length: Math.floor(random() * 40) }, () => String(Math.floor(random() * 8)));
    const b = a.filter(() => random() > 0.2).flatMap((line) => (random() > 0.85 ? [line, String(Math.floor(random() * 8))] : [line]));
    const { segments } = diffLines(a, b);
    assert.deepEqual(apply(segments, a, b), b);
  }
  // One changed line in the middle of 5,000: one line out, one line in.
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`);
  const edited = big.slice();
  edited[2500] = 'changed';
  assert.deepEqual(countChanges(diffLines(big, edited).segments), { added: 1, removed: 1 });
});

test('beyond the edit bound the middle is shown as removed, then added — still correct', () => {
  const a = Array.from({ length: 300 }, (_, i) => `old ${i}`);
  const b = Array.from({ length: 300 }, (_, i) => (i % 2 ? `old ${i}` : `new ${i}`));
  const { segments, approximate } = diffLines(a, b, { maxEditDistance: 10 });
  assert.equal(approximate, true);
  assert.deepEqual(apply(segments, a, b), b);
});

// ── analyze ────────────────────────────────────────────────────────────────

const buf = (text) => Buffer.from(text, 'utf8');

test('analyze tells a new file, a rewrite, binary content and changes of line endings apart', () => {
  const created = analyze(null, buf('a\nb\n'));
  assert.equal(created.status, 'text');
  assert.equal(created.created, true);
  assert.deepEqual([created.added, created.removed], [2, 0]);

  const rewritten = analyze(buf('a\nb\n'), buf('c\nd\ne\n'));
  assert.equal(rewritten.rewritten, true);
  assert.deepEqual([rewritten.added, rewritten.removed], [3, 2]);

  assert.equal(analyze(buf('a\n'), Buffer.from([0x61, 0x00])).status, 'binary');

  const eol = analyze(buf('a\r\nb\r\n'), buf('a\nb\n'));
  assert.equal(eol.status, 'eol-only');
  assert.deepEqual(eol.eolChange, { from: 'crlf', to: 'lf' });
  assert.equal(eol.lineCount, 2);

  const finalNewline = analyze(buf('a\nb'), buf('a\nb\n'));
  assert.equal(finalNewline.status, 'eol-only');
  assert.equal(finalNewline.finalNewline, 'added');

  const bom = analyze(buf('﻿a\n'), buf('a\n'));
  assert.equal(bom.status, 'eol-only', 'only an invisible character changed');
  assert.equal(bom.eolChange, null);
  assert.equal(bom.finalNewline, null);

  assert.equal(analyze(buf('same\n'), buf('same\n')).status, 'unchanged');
  const tooMany = analyze(buf('a\n'), buf('x\n'.repeat(30)), { maxLines: 20 });
  assert.equal(tooMany.status, 'too-large');
  assert.equal(tooMany.reason, 'lines');
  assert.equal(tooMany.limitLines, 20);
});

test('a CRLF file edited with LF lines shows the edit, not every line', () => {
  const result = analyze(buf('one\r\ntwo\r\nthree\r\n'), buf('one\r\nTWO\r\nthree\r\n'));
  assert.deepEqual([result.status, result.added, result.removed], ['text', 1, 1]);
});

// ── recorder ───────────────────────────────────────────────────────────────

test('the recorder hands back a summary without content, and the diff on request', async () => {
  const recorder = createFileChangeRecorder({ bootId: 'ab12' });
  const summary = recorder.record({ relativePath: 'a.txt', absPath: null, before: buf('a\nb\n'), after: 'a\nB\n' });
  assert.deepEqual(summary, { id: 'ab12-1', relativePath: 'a.txt', status: 'text', created: false, added: 1, removed: 1 });
  assert.deepEqual(normalizeFileChangeSummary(summary), summary, 'the summary survives the contract');

  const result = await recorder.describe(['ab12-1']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.beforeLines, ['a', 'b']);
  assert.deepEqual(result.afterLines, ['a', 'B']);
  assert.equal(result.calls, 1);
});

test('several changes to one file combine: before the first against after the last', async () => {
  const recorder = createFileChangeRecorder({ bootId: 'ab12' });
  const first = recorder.record({ relativePath: 'a.txt', before: buf('one\n'), after: 'two\n' });
  const second = recorder.record({ relativePath: 'a.txt', before: buf('two\n'), after: 'two\nthree\n' });
  const combined = await recorder.describe([second.id, first.id]);
  assert.deepEqual(combined.beforeLines, ['one']);
  assert.deepEqual(combined.afterLines, ['two', 'three']);
  assert.equal(combined.calls, 2);

  const back = recorder.record({ relativePath: 'a.txt', before: buf('two\nthree\n'), after: 'one\n' });
  assert.equal((await recorder.describe([first.id, second.id, back.id])).status, 'unchanged');
});

test('ids from before a restart, dropped ones and unknown ones each say why', async () => {
  const recorder = createFileChangeRecorder({ bootId: 'ab12', budgetBytes: 10 });
  const old = recorder.record({ relativePath: 'a.txt', before: buf('aaaa'), after: 'bbbb' });
  recorder.record({ relativePath: 'b.txt', before: buf('cccc'), after: 'dddd' });
  assert.deepEqual(await recorder.describe([old.id]), { ok: false, reason: 'evicted' });
  assert.deepEqual(await recorder.describe(['ffff-3']), { ok: false, reason: 'restarted' });
  assert.deepEqual(await recorder.describe(['ab12-99']), { ok: false, reason: 'unknown' });
  assert.deepEqual(await recorder.describe([]), { ok: false, reason: 'invalid' });
  assert.equal(recorder.stats().entries, 1, 'the newest change is kept even above the budget');
});

test('a file above the size limit is recorded with its sizes only', async () => {
  const recorder = createFileChangeRecorder({ bootId: 'ab12', maxBytesPerFile: 8 });
  const summary = recorder.record({ relativePath: 'big.txt', before: null, beforeBytes: 4096, after: 'small' });
  assert.equal(summary.status, 'too-large');
  assert.equal(summary.created, false, 'a file too large to read was there before');
  const result = await recorder.describe([summary.id]);
  assert.deepEqual(
    { status: result.status, reason: result.reason, beforeBytes: result.beforeBytes, limitBytes: result.limitBytes },
    { status: 'too-large', reason: 'bytes', beforeBytes: 4096, limitBytes: 8 }
  );
  assert.equal(recorder.stats().heldBytes, 0, 'no content is kept for it');
});

test('the diff says when the file moved on since, or went away', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-changes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.txt');
  await fs.writeFile(file, 'after\n');
  const recorder = createFileChangeRecorder({ fs, bootId: 'ab12' });
  const { id } = recorder.record({ relativePath: 'a.txt', absPath: file, before: buf('before\n'), after: 'after\n' });
  assert.equal((await recorder.describe([id])).changedSince, null);
  await fs.writeFile(file, 'edited by hand\n');
  assert.equal((await recorder.describe([id])).changedSince, 'changed');
  await fs.rm(file);
  assert.equal((await recorder.describe([id])).changedSince, 'deleted');
});

// ── the tools, through registry and adapter ────────────────────────────────

async function workspaceWith(t, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-changes-ws-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), content);
  }
  return dir;
}

function makeAdapter() {
  const fsService = createFsService({ fs, path, ...LIMITS });
  const registry = createWorkspaceToolRegistry({ fsService });
  const recorder = createFileChangeRecorder({ fs, bootId: 'ab12' });
  // Overwriting needs a trash for its recovery copy; this one just deletes it.
  const trashItem = (target) => fs.rm(target, { force: true });
  const adapter = createWorkspaceToolAdapter(registry, { fileChangeRecorder: recorder, trashItem });
  const run = (name, args, workspaceRoot) => adapter.execute(name, args, { workspaceRoot, approved: true, allowWrite: true });
  return { run, recorder };
}

test('edit_file, apply_patch and write_file_text each report what they changed', async (t) => {
  const root = await workspaceWith(t, { 'a.txt': 'one\ntwo\n', 'b.txt': 'x\ny\n', 'c.txt': 'old\n' });
  const { run, recorder } = makeAdapter();

  const edit = await run('edit_file', { relative_path: 'a.txt', old_string: 'two', new_string: 'TWO' }, root);
  assert.equal(edit.fileChanges.length, 1);
  assert.deepEqual(
    { added: edit.fileChanges[0].added, removed: edit.fileChanges[0].removed },
    { added: 1, removed: 1 }
  );
  assert.equal(edit.progressEvents[0].change.id, edit.fileChanges[0].id, 'the tree gets the same summary');

  const patch = await run('apply_patch', {
    patch: '--- a/b.txt\n+++ b/b.txt\n@@ -1,2 +1,3 @@\n x\n+inserted\n y\n',
  }, root);
  assert.equal(patch.fileChanges.length, 1);
  assert.equal(patch.fileChanges[0].relativePath, 'b.txt');
  assert.equal(patch.fileChanges[0].added, 1);

  const overwrite = await run('write_file_text', { relative_path: 'c.txt', content: 'new\n' }, root);
  const described = await recorder.describe([overwrite.fileChanges[0].id]);
  assert.deepEqual([described.beforeLines, described.afterLines], [['old'], ['new']]);

  const created = await run('write_file_text', { relative_path: 'fresh/d.txt', content: 'hello\n' }, root);
  assert.equal(created.fileChanges[0].created, true);
});

test('a call that fails records nothing', async (t) => {
  const root = await workspaceWith(t, { 'a.txt': 'one\n' });
  const { run, recorder } = makeAdapter();
  const result = await run('edit_file', { relative_path: 'a.txt', old_string: 'missing', new_string: 'x' }, root);
  assert.equal(result.fileChanges, undefined);
  assert.equal(recorder.stats().entries, 0);
});

test('without a recorder the tools write as before and report nothing extra', async (t) => {
  const root = await workspaceWith(t, { 'a.txt': 'one\n' });
  const registry = createWorkspaceToolRegistry({ fsService: createFsService({ fs, path, ...LIMITS }) });
  const adapter = createWorkspaceToolAdapter(registry, {});
  const result = await adapter.execute('edit_file', { relative_path: 'a.txt', old_string: 'one', new_string: 'two' }, {
    workspaceRoot: root, approved: true, allowWrite: true,
  });
  assert.equal(result.fileChanges, undefined);
  assert.deepEqual(result.progressEvents, [createWorkspaceFileWrittenEvent('a.txt')]);
  assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'two\n');
});

test('the history keeps the summaries of a tool row, and nothing that is not one', () => {
  const stored = toolTraceEntryForStore({
    line: 'Edited a.txt',
    tool: 'edit_file',
    changes: [
      { id: 'ab12-1', relativePath: 'a.txt', status: 'text', added: 1, removed: 2, content: 'secret' },
      { id: 'not an id', relativePath: 'b.txt' },
    ],
  });
  assert.deepEqual(stored.changes, [
    { id: 'ab12-1', relativePath: 'a.txt', status: 'text', created: false, added: 1, removed: 2 },
  ]);
});
