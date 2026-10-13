// Stale generated files stop a test run with the remedy (#919).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { staleGenerated } = require('../scripts/generated-freshness');

const BUILT = [
  'src/preload/bundle.js',
  'src/preload/manual-bundle.js',
  'src/renderer/generated/contracts.js',
  'src/renderer/generated/i18n.js',
  'src/renderer/generated/skill-frontmatter.js',
];

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-freshness-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (rel, mtimeSeconds) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '// x\n');
    fs.utimesSync(file, mtimeSeconds, mtimeSeconds);
  };
  write('src/preload/index.js', 1000);
  write('src/shared/contracts/index.js', 1000);
  write('src/renderer/vendor/marked.umd.js', 1000);
  write('src/renderer/vendor/purify.min.js', 1000);
  for (const rel of BUILT) write(rel, 2000);
  return { root, write };
}

test('built after their sources: nothing to report', (t) => {
  const { root } = tree(t);
  assert.deepEqual(staleGenerated(root), []);
});

test('a source changed after the build makes every built file stale', (t) => {
  const { root, write } = tree(t);
  write('src/shared/i18n/messages/en.js', 3000);
  const problems = staleGenerated(root);
  assert.equal(problems.length, BUILT.length);
  assert.equal(problems[2], 'src/renderer/generated/contracts.js is older than src/shared/i18n/messages/en.js');
});

test('missing files are named, the bundles themselves do not count as sources', (t) => {
  const { root, write } = tree(t);
  fs.rmSync(path.join(root, 'src/renderer/vendor/marked.umd.js'));
  fs.rmSync(path.join(root, 'src/renderer/generated/i18n.js'));
  write('src/preload/bundle.js', 5000);
  assert.deepEqual(staleGenerated(root), [
    'src/renderer/vendor/marked.umd.js is missing',
    'src/renderer/generated/i18n.js is missing',
  ]);
});

test('the checkout itself is fresh after the pretest sync', () => {
  assert.deepEqual(staleGenerated(), []);
});
