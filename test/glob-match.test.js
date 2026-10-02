const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { compileGlob, createGitignoreMatcher } = require('../src/main/services/glob-match');
const { createFsService } = require('../src/main/services/fs-service');

function matches(pattern, relPath) {
  return compileGlob(pattern).test(relPath);
}

test('compileGlob keeps the pinned glob behaviour: basename at any depth, anchoring, folders only (#644)', () => {
  assert.equal(matches('*.txt', 'a.txt'), true);
  assert.equal(matches('*.txt', 'sub/deep/b.txt'), true);
  assert.equal(matches('*.txt', 'a.txt.bak'), false);
  assert.equal(matches('sub/*.md', 'sub/c.md'), true);
  assert.equal(matches('sub/*.md', 'x/sub/c.md'), false, 'a pattern with a slash is anchored');
  assert.equal(matches('sub/*.md', 'sub/x/c.md'), false, '* does not cross a folder');
  assert.equal(matches('/top', 'top'), true);
  assert.equal(matches('/top', 'x/top'), false);
  assert.equal(matches('a?c', 'abc'), true);
  assert.equal(matches('a?c', 'abbc'), false);
  const dirOnly = compileGlob('build/');
  assert.equal(dirOnly.dirOnly, true);
  assert.equal(dirOnly.test('pkg/build'), true, 'the caller decides about dirOnly');
});

test('compileGlob treats ** as a whole segment only (#644)', () => {
  assert.equal(matches('**', 'a/b/c'), true);
  assert.equal(matches('**/foo', 'foo'), true);
  assert.equal(matches('**/foo', 'a/b/foo'), true);
  assert.equal(matches('src/**/*.md', 'src/a.md'), true);
  assert.equal(matches('src/**/*.md', 'src/x/y/a.md'), true);
  assert.equal(matches('a/**/b', 'a/b'), true);
  assert.equal(matches('a/**/b', 'a/x/y/b'), true);
  assert.equal(matches('a/**/b', 'a/x/y/c'), false);
  assert.equal(matches('src/**', 'src/a/b'), true);
  assert.equal(matches('src/**', 'src'), false, 'x/** matches what is inside x, not x itself');
  assert.equal(matches('foo/**bar', 'foo/xbar'), true, '** inside a segment is a plain *');
  assert.equal(matches('foo/**bar', 'foo/x/bar'), false);
});

test('compileGlob supports bracket expressions with ranges and negation, never matching / (#644)', () => {
  assert.equal(matches('*.[jt]s', 'a.js'), true);
  assert.equal(matches('*.[jt]s', 'lib/a.ts'), true);
  assert.equal(matches('*.[jt]s', 'a.cs'), false);
  assert.equal(matches('*.py[cod]', 'a.pyc'), true);
  assert.equal(matches('*.py[cod]', 'a.pyo'), true);
  assert.equal(matches('*.py[cod]', 'a.py'), false);
  assert.equal(matches('[Bb]in', 'Bin'), true);
  assert.equal(matches('[Bb]in', 'x/bin'), true);
  assert.equal(matches('[a-c]x', 'bx'), true);
  assert.equal(matches('[a-c]x', 'dx'), false);
  assert.equal(matches('[!a]b', 'cb'), true);
  assert.equal(matches('[!a]b', 'ab'), false);
  assert.equal(matches('[^a]b', 'ab'), false);
  assert.equal(matches('[]]x', ']x'), true, '] right after [ is a member');
  assert.equal(matches('[!]]x', ']x'), false);
  assert.equal(matches('[[:digit:]]*', '1abc'), true);
  assert.equal(matches('[[:digit:]]*', 'abc'), false);
  assert.equal(matches('a[!x]b', 'a/b'), false, 'a negated class does not match a separator');
  assert.equal(matches('report[', 'report['), true, 'an unclosed [ is literal');
});

test('compileGlob unescapes backslashes and counts characters, not UTF-16 units (#644)', () => {
  assert.equal(matches('\\#notes.txt', '#notes.txt'), true);
  assert.equal(matches('\\*', '*'), true);
  assert.equal(matches('\\*', 'a'), false);
  assert.equal(matches('\\[x]', '[x]'), true);
  assert.equal(matches('?.txt', '😀.txt'), true);
});

test('createGitignoreMatcher handles comments, negation, folders, escapes and trailing blanks (#644)', () => {
  const ignored = createGitignoreMatcher(
    '﻿# comment\nignored-dir/\n*.log\n!keep.log\n[Bb]in/\n[Oo]bj/\n*.py[cod]\n\\#notes.txt\n\\!bang\ntrail   \nkept\\ \n'
  );
  assert.equal(ignored('ignored-dir', true), true);
  assert.equal(ignored('ignored-dir', false), false, 'a folder pattern leaves a file alone');
  assert.equal(ignored('debug.log', false), true);
  assert.equal(ignored('keep.log', false), false);
  assert.equal(ignored('Bin', true), true);
  assert.equal(ignored('src/obj', true), true);
  assert.equal(ignored('x.pyc', false), true);
  assert.equal(ignored('#notes.txt', false), true);
  assert.equal(ignored('!bang', false), true);
  assert.equal(ignored('trail', false), true, 'trailing blanks are dropped');
  assert.equal(ignored('kept ', false), true, 'an escaped trailing space stays');
  assert.equal(ignored('normal.txt', false), false);
  assert.equal(createGitignoreMatcher('# only a comment\n\n'), null);
});

test('createGitignoreMatcher stops applying a .gitignore that has used up its budget (#644)', () => {
  const ignored = createGitignoreMatcher('*a*b\n', { maxSteps: 50 });
  assert.equal(ignored('xaxb', false), true);
  for (let i = 0; i < 10; i++) ignored(`${'a'.repeat(30)}${i}`, false);
  assert.equal(ignored('xaxb', false), false, 'past the budget nothing is ignored any more');
});

// The old regexes needed seconds for ten `*a` against 40 characters, and each
// further star multiplied that by 7 to 10 (#644).
const STARS = `${'*a'.repeat(30)}*b`;
const LONG_NAME = 'a'.repeat(255);

test('a 30-star pattern against a 255-character name is fast (#644)', () => {
  const started = Date.now();
  assert.equal(matches(STARS, LONG_NAME), false);
  assert.equal(matches(`dir/${STARS}`, `dir/${LONG_NAME}`), false);
  assert.equal(createGitignoreMatcher(`${STARS}\n`)(LONG_NAME, false), false);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 200, `took ${elapsed} ms`);
});

// Windows refuses a 255-character name below the temp folder (MAX_PATH); the
// matcher itself is covered above on every platform.
test(
  'find_files, search include/exclude and the @ list stay fast on a 30-star pattern (#644)',
  { skip: process.platform === 'win32' },
  async (t) => {
    const svc = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024 });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-glob-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, LONG_NAME), 'hit\n', 'utf8');

    let started = Date.now();
    const found = JSON.parse(await svc.runFindFilesTool({ pattern: STARS }, root));
    assert.deepEqual(found.results, []);
    assert.ok(Date.now() - started < 200, `find_files took ${Date.now() - started} ms`);

    started = Date.now();
    const included = JSON.parse(await svc.runSearchInFilesTool({ query: 'hit', include: STARS }, root));
    assert.deepEqual(included.matches, []);
    const excluded = JSON.parse(await svc.runSearchInFilesTool({ query: 'hit', exclude: STARS }, root));
    assert.equal(excluded.matches.length, 1);
    assert.ok(Date.now() - started < 200, `search took ${Date.now() - started} ms`);

    await fs.writeFile(path.join(root, '.gitignore'), `node_modules/\n${STARS}\n`, 'utf8');
    started = Date.now();
    const listed = await svc.listWorkspacePaths(root);
    assert.deepEqual(listed.entries.map((entry) => entry.path), [LONG_NAME]);
    assert.ok(Date.now() - started < 200, `listWorkspacePaths took ${Date.now() - started} ms`);
  }
);

test('the GitHub template lines take effect in the @ list and in find_files (#644)', async (t) => {
  const svc = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024 });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-glob-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '.gitignore'), '[Bb]in/\n[Oo]bj/\n*.py[cod]\n\\#notes.txt\n', 'utf8');
  for (const dir of ['Bin', 'obj', 'src']) await fs.mkdir(path.join(root, dir));
  await fs.writeFile(path.join(root, 'Bin', 'app.dll'), 'x', 'utf8');
  await fs.writeFile(path.join(root, 'obj', 'app.o'), 'x', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'main.py'), 'x', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'main.pyc'), 'x', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'app.js'), 'x', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'x', 'utf8');
  await fs.writeFile(path.join(root, '#notes.txt'), 'x', 'utf8');

  const listed = await svc.listWorkspacePaths(root);
  assert.deepEqual(listed.entries.map((entry) => entry.path).sort(), [
    'src',
    'src/app.js',
    'src/app.ts',
    'src/main.py',
  ]);

  const found = JSON.parse(await svc.runFindFilesTool({ pattern: '*.[jt]s' }, root));
  assert.deepEqual(found.results.map((entry) => entry.path), ['src/app.js', 'src/app.ts']);
});
