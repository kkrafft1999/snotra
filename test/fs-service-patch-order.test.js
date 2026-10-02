'use strict';

// apply_patch judges the order of the hunks by where they are found, not by
// the numbers in their headers (#647). Models often get those numbers wrong,
// so a patch whose hunks come in the right order applies whatever its headers
// say; a hunk whose nearest match stands before the end of the hunk in front
// was sent out of order (or overlaps it) and is refused, as GNU patch does.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');

async function makeWorkspace(t, files = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-patch-order-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    await fs.writeFile(path.join(workspace, rel), content);
  }
  return workspace;
}

function makeRunner(workspace) {
  const registry = createWorkspaceToolRegistry({ fsService: createFsService({ fs, path }) });
  return async (name, args) =>
    JSON.parse(await registry.execute(name, args, { approved: true, workspaceRoot: workspace, allowWrite: true }));
}

const diff = (...lines) => `${lines.join('\n')}\n`;
const read = (workspace, rel) => fs.readFile(path.join(workspace, rel), 'utf8');
const numbered = (count) => `${Array.from({ length: count }, (_, i) => `l${i + 1}`).join('\n')}\n`;

// Two functions at lines 1–3 and 14–16, both with `return null;` (#647).
function twoFunctions(extra = []) {
  const lines = ['function a() {', '  return null;', '}'];
  for (let i = 4; i <= 13; i += 1) lines.push(`// ${i}`);
  lines.push('function b() {', '  return null;', '}', ...extra);
  return `${lines.join('\n')}\n`;
}

test('hunks in the right order apply even when every header says line 1', async (t) => {
  const workspace = await makeWorkspace(t, { 'a.txt': numbered(30) });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff('--- a.txt', '+++ a.txt', '@@ -1,1 +1,1 @@', '-l5', '+L5', '@@ -1,1 +1,1 @@', '-l20', '+L20'),
  });

  assert.equal(out.error, undefined);
  assert.equal(out.hunks_applied, 2);
  assert.deepEqual(out.files[0].line_offsets, [4, 15]);
  const lines = (await read(workspace, 'a.txt')).split('\n');
  assert.equal(lines[4], 'L5');
  assert.equal(lines[19], 'L20');
  assert.equal(lines.filter((line) => /^L/.test(line)).length, 2);
});

test('hunks in the right order apply even when their headers descend', async (t) => {
  const workspace = await makeWorkspace(t, { 'a.txt': numbered(30) });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff('--- a.txt', '+++ a.txt', '@@ -20,1 +20,1 @@', '-l5', '+L5', '@@ -10,1 +10,1 @@', '-l20', '+L20'),
  });

  assert.equal(out.error, undefined);
  const lines = (await read(workspace, 'a.txt')).split('\n');
  assert.equal(lines[4], 'L5');
  assert.equal(lines[19], 'L20');
});

test('a hunk sent out of order is refused and the file stays unchanged (#647)', async (t) => {
  const original = twoFunctions();
  const workspace = await makeWorkspace(t, { 'a.js': original });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff(
      '--- a.js', '+++ a.js',
      '@@ -15,1 +15,1 @@', '-  return null;', '+  return 2;',
      '@@ -2,1 +2,1 @@', '-  return null;', '+  return 1;'
    ),
  });

  assert.match(out.error, /Hunk 2 of 2 does not apply to "a\.js": its lines stand at line 2, .*\(line 15\)/);
  assert.match(out.error, /ascending line order/);
  assert.equal(await read(workspace, 'a.js'), original);
});

test('a hunk out of order with a sloppy header does not land on a later match (#647)', async (t) => {
  // A third `return null;` at line 18: searching only forward from the hunk
  // in front would put the second hunk there.
  const original = twoFunctions(['function c() {', '  return null;', '}']);
  const workspace = await makeWorkspace(t, { 'a.js': original });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff(
      '--- a.js', '+++ a.js',
      '@@ -15,1 +15,1 @@', '-  return null;', '+  return 2;',
      '@@ -4,1 +4,1 @@', '-  return null;', '+  return 1;'
    ),
  });

  assert.match(out.error, /Hunk 2 of 2 .*its lines stand at line 2, .*ascending line order/);
  assert.equal(await read(workspace, 'a.js'), original);
});

test('a hunk that shares a context line with the one in front is refused (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'a.txt': 'a\nb\nc\nd\ne\n' });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff('--- a.txt', '+++ a.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', '@@ -3,2 +3,2 @@', ' c', '-d', '+D'),
  });

  assert.match(out.error, /Hunk 2 of 2 .*line 3, before the end of the hunk in front of it \(line 3\).*must not overlap/);
  assert.equal(await read(workspace, 'a.txt'), 'a\nb\nc\nd\ne\n');
});

test('an insertion sent out of order is refused as well (#647)', async (t) => {
  const workspace = await makeWorkspace(t, { 'a.txt': numbered(20) });
  const run = makeRunner(workspace);

  const out = await run('apply_patch', {
    patch: diff('--- a.txt', '+++ a.txt', '@@ -15,1 +15,1 @@', '-l15', '+L15', '@@ -2,0 +3,1 @@', '+new'),
  });

  assert.match(out.error, /Hunk 2 of 2 .*insertion point \(after line 2\) lies before the end/);
  assert.equal(await read(workspace, 'a.txt'), numbered(20));
});
