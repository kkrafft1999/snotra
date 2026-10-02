const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');

const MB = 1024 * 1024;

async function outline(t, fileName, content) {
  const svc = createFsService({ fs, path, maxReadFileBytes: 2 * MB });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-outline-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, fileName), content, 'utf8');
  const started = Date.now();
  const result = JSON.parse(await svc.runOutlineFileTool({ relative_path: fileName }, root));
  return { result, elapsed: Date.now() - started };
}

// A heading or signature line made of a megabyte of blanks used to take
// minutes: four of the patterns had overlapping quantifiers (#643).
test('a 1 MB heading line outlines in under 200 ms (#643)', async (t) => {
  const { result, elapsed } = await outline(t, 'a.md', `# x${' '.repeat(MB)}y\n`);
  assert.equal(result.error, undefined);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].kind, 'heading');
  assert.ok(elapsed < 200, `took ${elapsed} ms`);
});

test('a 1 MB heading line with a closing-# run outlines in under 200 ms (#643)', async (t) => {
  const blanks = ' '.repeat(MB / 2);
  const { result, elapsed } = await outline(t, 'a.md', `# x${blanks}y${blanks}#z\n`);
  assert.equal(result.entries.length, 1);
  assert.ok(elapsed < 200, `took ${elapsed} ms`);
});

test('a 1 MB `foo(): …` line outlines in under 200 ms (#643)', async (t) => {
  const { result, elapsed } = await outline(t, 'a.js', `foo(): ${' '.repeat(MB)}x\n`);
  assert.equal(result.error, undefined);
  assert.ok(elapsed < 200, `took ${elapsed} ms`);
});

// The cap on the line length alone would hide a slow pattern behind short
// lines, so a file of many adversarial lines just below the cap is timed too.
test('a 2 MB file of long adversarial signature lines outlines in under a second (#643)', async (t) => {
  const width = 480;
  const shapes = [
    (n) => `function${' '.repeat(n)};`,
    (n) => `const x :${' '.repeat(n)}x`,
    (n) => `const x = (a) :${' '.repeat(n)}x`,
    (n) => `foo():${' '.repeat(n)}x`,
    (n) => `foo${' '.repeat(n)}x`,
    (n) => `x: (a) :${' '.repeat(n)}x`,
    (n) => `int f() throws${' '.repeat(n)}x`,
  ];
  const lines = [];
  let size = 0;
  for (let i = 0; size < 2 * MB - 1000; i++) {
    const line = shapes[i % shapes.length](width);
    lines.push(line);
    size += line.length + 1;
  }
  const { result, elapsed } = await outline(t, 'a.ts', `${lines.join('\n')}\n`);
  assert.equal(result.error, undefined);
  assert.ok(elapsed < 1000, `took ${elapsed} ms`);
});

test('the rewritten patterns still find what they found before (#643)', async (t) => {
  const markdown = await outline(t, 'a.md', '# Title ##\n## Sub #tag\n### Spaced   ###   \n#hashtag\n');
  assert.deepEqual(
    markdown.result.entries.map((entry) => entry.text),
    ['Title', 'Sub #tag', 'Spaced']
  );

  const code = await outline(
    t,
    'a.ts',
    [
      'function * gen () {',
      'export default async function main(a) {',
      'const add = (a, b): number => a + b;',
      'const handler: Handler = async (e) => {',
      'class Box {',
      '  get value(): number {',
      '  map<T> (fn) {',
      '  onClick: (e): void => {',
      '}',
      'int run(void) throws IOException, Exception {',
    ].join('\n')
  );
  assert.deepEqual(
    code.result.entries.map(({ name, text }) => ({ name, text })),
    [
      { name: 'gen', text: 'function * gen ()' },
      { name: 'main', text: 'export default async function main(a)' },
      { name: 'add', text: 'const add = (a, b): number => a + b;' },
      { name: 'handler', text: 'const handler: Handler = async (e) =>' },
      { name: 'Box', text: 'class Box' },
      { name: 'value', text: 'get value(): number' },
      { name: 'map', text: 'map<T> (fn)' },
      { name: 'onClick', text: 'onClick: (e): void =>' },
      { name: 'run', text: 'int run(void) throws IOException, Exception' },
    ]
  );
});
