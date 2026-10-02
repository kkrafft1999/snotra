'use strict';

// The matching budget of a `.gitignore` holds inside a single path, is small
// enough that using it up costs a fraction of a second, and is not spent again
// on every listing: the compiled rules are kept while the file stays the same
// (#644). An ordinary large `.gitignore` still applies in full.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createGitignoreMatcher } = require('../src/main/services/glob-match');

// 1,040 rules of `**/R/**/R` with R = `*` + 120 × `a` + `b`, filling 256 KB:
// against a name of `a`s every rule backtracks through the whole name.
const CRAFTED_RULE = (() => {
  const r = `*${'a'.repeat(120)}b`;
  return `**/${r}/**/${r}`;
})();
const CRAFTED = Array.from({ length: 1040 }, () => CRAFTED_RULE).join('\n');

function ordinaryGitignore() {
  const shapes = [
    (i) => `build${i}/`, (i) => `*.tmp${i}`, (i) => `/out${i}`, (i) => `logs${i}/**/*.log`,
    (i) => `**/cache${i}`, (i) => `docs/gen${i}/*.md`, (i) => `*.py[cod]${i}`, (i) => `!keep${i}.txt`,
    (i) => `node_modules${i}`, (i) => `.env.local${i}`,
  ];
  return ['*.log', ...Array.from({ length: 999 }, (_, i) => shapes[i % shapes.length](i))].join('\n');
}

test('one deep path against crafted rules gives up inside the path (#644)', () => {
  let exhausted = 0;
  const ignored = createGitignoreMatcher(`keep-out.txt\n${CRAFTED}\n`, { onExhausted: () => (exhausted += 1) });
  assert.equal(ignored('keep-out.txt', false), true);

  const deep = Array.from({ length: 30 }, () => 'a'.repeat(200)).join('/');
  const started = Date.now();
  assert.equal(ignored(deep, false), false);
  const elapsed = Date.now() - started;

  assert.equal(exhausted, 1, 'the budget is used up within this one path');
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
  assert.equal(ignored('keep-out.txt', false), false, 'past the budget nothing is ignored any more');
  assert.equal(exhausted, 1);
});

test('an ordinary large .gitignore applies in full over 5,000 paths (#644)', () => {
  let exhausted = false;
  const ignored = createGitignoreMatcher(ordinaryGitignore(), { onExhausted: () => (exhausted = true) });
  for (let i = 0; i < 5000; i += 1) {
    const parts = Array.from({ length: 1 + (i % 5) }, (_, d) => `folder${(i * 7 + d) % 97}`);
    ignored([...parts, `file-name-${i}.js`].join('/'), false);
  }
  assert.equal(exhausted, false);
  assert.equal(ignored('src/last.log', false), true);
  assert.equal(ignored('cache3', true), false);
  assert.equal(ignored('a/b/cache4', true), true);
});

test('rules past the 10,000th are dropped (#644)', () => {
  const rules = Array.from({ length: 10000 }, (_, i) => `x${i}`);
  const ignored = createGitignoreMatcher([...rules, 'late.txt'].join('\n'));
  assert.equal(ignored('x9999', false), true);
  assert.equal(ignored('late.txt', false), false);
});

// Windows refuses a 200-character name below the temp folder (MAX_PATH); the
// matcher is covered above on every platform.
test(
  'the @ list stays fast on crafted rules, and a used-up .gitignore is not spent again (#644)',
  { skip: process.platform === 'win32' },
  async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-gitignore-budget-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    // Sorts before the long names, so it is matched while the budget lasts.
    await fs.writeFile(path.join(root, '0-ignored.txt'), 'x\n');
    for (let i = 0; i < 60; i += 1) {
      await fs.writeFile(path.join(root, `${'a'.repeat(200)}${String(i).padStart(2, '0')}`), 'x\n');
    }
    await fs.writeFile(path.join(root, '.gitignore'), `0-ignored.txt\n${CRAFTED}\n`);
    const svc = createFsService({ fs, path });
    const listed = async () => (await svc.listWorkspacePaths(root)).entries.map((entry) => entry.path);

    let started = Date.now();
    let paths = await listed();
    assert.ok(Date.now() - started < 1000, `first listing took ${Date.now() - started} ms`);
    assert.equal(paths.includes('0-ignored.txt'), false);
    assert.equal(paths.filter((p) => p.startsWith('aaa')).length, 60);

    // The same file again: off at once instead of compiled and spent anew.
    started = Date.now();
    paths = await listed();
    assert.ok(Date.now() - started < 1000, `second listing took ${Date.now() - started} ms`);
    assert.equal(paths.includes('0-ignored.txt'), true);

    // A changed file is compiled again and applies.
    await fs.writeFile(path.join(root, '.gitignore'), '0-ignored.txt\n');
    paths = await listed();
    assert.equal(paths.includes('0-ignored.txt'), false);
  }
);
