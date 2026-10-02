const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

// #347: what the agent read or changed, per conversation, for the tree.
const marksPromise = import(
  pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'tree', 'agentMarks.js')).href
);

const ROOT = '/w';

test('a write is unseen, looking at it makes it changed, another write makes it unseen again', async () => {
  const { createAgentMarks, AGENT_MARK } = await marksPromise;
  const marks = createAgentMarks();
  marks.recordWrite('c1', '/w/a.js');
  assert.equal(marks.markOf('c1', '/w/a.js'), AGENT_MARK.UNSEEN);
  marks.markSeen('/w/a.js');
  assert.equal(marks.markOf('c1', '/w/a.js'), AGENT_MARK.CHANGED);
  marks.recordWrite('c1', '/w/a.js');
  assert.equal(marks.markOf('c1', '/w/a.js'), AGENT_MARK.UNSEEN);
});

test('a read never lowers a change, and looking leaves a read alone', async () => {
  const { createAgentMarks, AGENT_MARK } = await marksPromise;
  const marks = createAgentMarks();
  marks.recordWrite('c1', '/w/a.js');
  marks.recordRead('c1', '/w/a.js');
  assert.equal(marks.markOf('c1', '/w/a.js'), AGENT_MARK.UNSEEN);
  marks.recordRead('c1', '/w/b.js');
  marks.markSeen('/w/b.js');
  assert.equal(marks.markOf('c1', '/w/b.js'), AGENT_MARK.READ);
  marks.recordWrite('c1', '/w/b.js');
  assert.equal(marks.markOf('c1', '/w/b.js'), AGENT_MARK.UNSEEN);
});

test('marks belong to their conversation; looking counts in all of them', async () => {
  const { createAgentMarks, AGENT_MARK } = await marksPromise;
  const marks = createAgentMarks();
  marks.recordWrite('c1', '/w/a.js');
  marks.recordWrite('c2', '/w/a.js');
  assert.equal(marks.markOf('c3', '/w/a.js'), null);
  assert.equal(marks.hasMarks('c3'), false);
  marks.markSeen('/w/a.js');
  assert.equal(marks.markOf('c1', '/w/a.js'), AGENT_MARK.CHANGED);
  assert.equal(marks.markOf('c2', '/w/a.js'), AGENT_MARK.CHANGED);
  marks.clearChat('c1');
  assert.equal(marks.hasMarks('c1'), false);
  assert.equal(marks.hasMarks('c2'), true);
});

test('clear drops a file, or a folder with everything below it, in one chat only', async () => {
  const { createAgentMarks } = await marksPromise;
  const marks = createAgentMarks();
  marks.recordWrite('c1', '/w/src/a.js');
  marks.recordRead('c1', '/w/src/deep/b.js');
  marks.recordRead('c1', '/w/srcx.js');
  marks.recordRead('c2', '/w/src/a.js');
  marks.clear('c1', '/w/src');
  assert.equal(marks.markOf('c1', '/w/src/a.js'), null);
  assert.equal(marks.markOf('c1', '/w/src/deep/b.js'), null);
  assert.equal(marks.markOf('c1', '/w/srcx.js'), 'read', 'a sibling with the same prefix stays');
  assert.equal(marks.markOf('c2', '/w/src/a.js'), 'read');
});

test('forget removes a deleted path from every chat; clearAll empties everything', async () => {
  const { createAgentMarks } = await marksPromise;
  const marks = createAgentMarks();
  marks.recordWrite('c1', '/w/a.js');
  marks.recordWrite('c2', '/w/a.js');
  marks.forget('/w/a.js');
  assert.equal(marks.hasMarks('c1'), false);
  assert.equal(marks.hasMarks('c2'), false);
  marks.recordRead('c1', '/w/b.js');
  marks.clearAll();
  assert.equal(marks.hasMarks('c1'), false);
});

test('folder summaries carry the loudest mark below, up to but not including the root', async () => {
  const { createAgentMarks, AGENT_MARK } = await marksPromise;
  const marks = createAgentMarks();
  marks.recordRead('c1', '/w/src/a.js');
  marks.recordWrite('c1', '/w/src/main/deep/x.js');
  marks.recordRead('c1', '/w/docs/readme.md');
  const s = marks.folderSummaries('c1', ROOT);
  assert.equal(s.get('/w/src'), AGENT_MARK.UNSEEN);
  assert.equal(s.get('/w/src/main'), AGENT_MARK.UNSEEN);
  assert.equal(s.get('/w/src/main/deep'), AGENT_MARK.UNSEEN);
  assert.equal(s.get('/w/docs'), AGENT_MARK.READ);
  assert.equal(s.has('/w'), false);
  marks.markSeen('/w/src/main/deep/x.js');
  assert.equal(marks.folderSummaries('c1', ROOT).get('/w/src'), AGENT_MARK.CHANGED);
});

test('folder summaries stay right when a quieter mark arrives after a louder one', async () => {
  const { createAgentMarks, AGENT_MARK } = await marksPromise;
  const marks = createAgentMarks();
  marks.recordWrite('c1', '/w/a/b/x.js');
  marks.recordRead('c1', '/w/a/y.js');
  marks.recordRead('c1', '/w/a/b/c/z.js');
  const s = marks.folderSummaries('c1', ROOT);
  assert.equal(s.get('/w/a'), AGENT_MARK.UNSEEN);
  assert.equal(s.get('/w/a/b'), AGENT_MARK.UNSEEN);
  assert.equal(s.get('/w/a/b/c'), AGENT_MARK.READ);
});

test('Windows paths: summaries and clear work with backslashes', async () => {
  const { createAgentMarks, AGENT_MARK, markPathFor } = await marksPromise;
  const marks = createAgentMarks();
  const file = markPathFor('C:\\w', 'src/a.js');
  assert.equal(file, 'C:\\w\\src\\a.js');
  marks.recordWrite('c1', file);
  assert.equal(marks.folderSummaries('c1', 'C:\\w').get('C:\\w\\src'), AGENT_MARK.UNSEEN);
  marks.clear('c1', 'C:\\w\\src');
  assert.equal(marks.hasMarks('c1'), false);
});

test('pruneListing drops marks of entries a full listing no longer has, spares the kept ones', async () => {
  const { createAgentMarks } = await marksPromise;
  const marks = createAgentMarks();
  marks.recordWrite('c1', '/w/src/old.js');
  marks.recordWrite('c1', '/w/src/gone/inner.js');
  marks.recordRead('c1', '/w/src/stays/inner.js');
  marks.recordRead('c1', '/w/src/.env');
  marks.recordRead('c2', '/w/src/old.js');
  marks.recordRead('c1', '/w/other.js');
  marks.pruneListing('/w/src', ['/w/src/new.js', '/w/src/stays'], (p) => p.endsWith('/.env'));
  assert.equal(marks.markOf('c1', '/w/src/old.js'), null);
  assert.equal(marks.markOf('c2', '/w/src/old.js'), null);
  assert.equal(marks.markOf('c1', '/w/src/gone/inner.js'), null);
  assert.equal(marks.markOf('c1', '/w/src/stays/inner.js'), 'read');
  assert.equal(marks.markOf('c1', '/w/src/.env'), 'read');
  assert.equal(marks.markOf('c1', '/w/other.js'), 'read');
});

test('markPathFor resolves dot segments and refuses paths that leave the folder', async () => {
  const { markPathFor } = await marksPromise;
  assert.equal(markPathFor('/w', './src/../a.js'), '/w/a.js');
  assert.equal(markPathFor('/w', '.github/ci.yml'), '/w/.github/ci.yml');
  assert.equal(markPathFor('/w', '../x.js'), null);
  assert.equal(markPathFor('/w', '.'), null);
  assert.equal(markPathFor(null, 'a.js'), null);
});

test('listeners hear changes, and only real ones', async () => {
  const { createAgentMarks } = await marksPromise;
  const marks = createAgentMarks();
  let calls = 0;
  const off = marks.onChange(() => { calls += 1; });
  marks.recordRead('c1', '/w/a.js');
  marks.recordRead('c1', '/w/a.js');
  marks.markSeen('/w/a.js');
  marks.clear('c1', '/w/nothing');
  assert.equal(calls, 1);
  marks.recordWrite('c1', '/w/a.js');
  assert.equal(calls, 2);
  off();
  marks.clearAll();
  assert.equal(calls, 2);
});
