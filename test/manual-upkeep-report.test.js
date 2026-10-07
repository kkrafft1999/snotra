const test = require('node:test');
const assert = require('node:assert/strict');
const { classify, pullRequestNumber, touchesUi } = require('../scripts/manual-upkeep-report');

// #780: the release skill lists pull requests that changed what a user sees
// without a word about the user manual.

const ticked = '## User manual\n\n- [ ] User manual updated in `manual/` (English and German)\n- [x] User manual not affected — because: only a log line changed\n';
const unticked = ticked.replace('[x]', '[ ]');

test('changes outside the app are internal, whatever the description says', () => {
  assert.equal(classify({ files: ['docs/architecture.md', 'test/x.test.js', '.github/workflows/ci.yml'], body: null }), 'internal');
  assert.equal(classify({ files: ['e2e/smoke.test.mjs', 'scripts/make-dmg.js'], body: unticked }), 'internal');
});

test('a change to the app that touched manual/ is covered', () => {
  assert.equal(classify({ files: ['src/renderer/app.js', 'manual/src/content/docs/chat.md'], body: null }), 'covered');
  assert.equal(classify({ files: ['system-skills/snotra-memory/SKILL.md', 'manual/public/screenshots/x.en.light.webp'], body: unticked }), 'covered');
});

test('a ticked "not affected" box counts as a decision', () => {
  assert.equal(classify({ files: ['src/main/index.js'], body: ticked }), 'declared');
  assert.equal(classify({ files: ['src/main/index.js'], body: ticked.replace('[x]', '[X]') }), 'declared');
});

test('neither manual change nor ticked box is reported', () => {
  assert.equal(classify({ files: ['src/main/index.js'], body: unticked }), 'missing');
  assert.equal(classify({ files: ['src/renderer/styles.css'], body: '' }), 'missing');
});

test('an unreadable description is not taken as either answer', () => {
  assert.equal(classify({ files: ['src/main/index.js'], body: null }), 'unknown');
});

test('the pull request number comes from the squash subject', () => {
  assert.equal(pullRequestNumber('Generate the manual\'s screenshots by script (#779) (#797)'), 797);
  assert.equal(pullRequestNumber('v1.16.0 (#776)'), 776);
  assert.equal(pullRequestNumber('A direct commit'), null);
});

test('only renderer changes call for new screenshots', () => {
  assert.equal(touchesUi(['src/renderer/chat/view.js']), true);
  assert.equal(touchesUi(['src/main/index.js', 'manual/README.md']), false);
});
