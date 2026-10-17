'use strict';

// docs/architecture.md describes the code, and a description nobody checks
// drifts (#1009): by the time of the architecture review its header said
// July while the content ran to October, the layer table missed half of
// `src/main/`, and the port list covered 14 of 18 ports. This keeps the
// checkable part honest — paths, layers, ports. What the prose claims about
// what a layer "does" or "never does" stays a matter of reading it against
// the code; no test can do that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const DOC = fs.readFileSync(path.join(ROOT, 'docs', 'architecture.md'), 'utf8').replace(/\r\n/g, '\n');

// Code fences hold diagrams and example JSON, not claims about files.
const PROSE = DOC.replace(/```[\s\S]*?```/g, '');
const SPANS = [...PROSE.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);

/** Everything the document may name that is not in the tree: built, or a user's own file. */
const NOT_IN_THE_TREE = new Set([
  // Written by the user in their own folder, named as an example.
  '.agents/memory.md',
  'docs/guide.md',
  'docs/img/',
]);
// Built by `npm run sync-vendor` / `scripts/bundle-manual.js` and ignored by git.
const GENERATED = [
  'src/renderer/generated/',
  'src/renderer/vendor/pdfjs/',
  'src/renderer/vendor/prism/',
  'src/manual/',
];

function section(heading) {
  const start = DOC.indexOf(`\n${heading}\n`);
  assert.notEqual(start, -1, `${heading} is gone from architecture.md`);
  const next = DOC.indexOf('\n## ', start + heading.length + 2);
  return DOC.slice(start, next === -1 ? undefined : next);
}

function spansOf(text) {
  return [...text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
}

function subdirectories(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** Shorthand the document uses: `services/x.js`, `main/services/x.js`, `contracts/x.js` … */
function lookupRoots() {
  const roots = ['', 'src', 'src/main', 'src/shared', 'src/application', 'src/renderer', 'src/preload', 'docs'];
  for (const layer of ['src/main', 'src/shared', 'src/application', 'src/renderer']) {
    for (const name of subdirectories(path.join(ROOT, layer))) roots.push(`${layer}/${name}`);
  }
  return roots;
}

test('every file path the document names exists', () => {
  const roots = lookupRoots();
  const missing = [];
  for (const span of new Set(SPANS)) {
    const isFilePath = /^[A-Za-z0-9_.\-/@]+$/.test(span)
      && span.includes('/')
      && /\.(?:js|mjs|cjs|json|md|svg|css|html|ya?ml|pl|txt|sh)$/.test(span);
    if (!isFilePath || NOT_IN_THE_TREE.has(span) || GENERATED.some((prefix) => span.startsWith(prefix))) continue;
    if (!roots.some((root) => fs.existsSync(path.join(ROOT, root, span)))) missing.push(span);
  }
  assert.deepEqual(missing, [], `architecture.md names files that do not exist:\n${missing.join('\n')}`);
});

test('every directory path the document names exists', () => {
  const missing = [];
  for (const span of new Set(SPANS)) {
    if (!/^(?:src|docs|test|e2e|scripts|manual)\/[A-Za-z0-9_.\-/]*\/$/.test(span)) continue;
    if (NOT_IN_THE_TREE.has(span) || GENERATED.some((prefix) => span.startsWith(prefix))) continue;
    const full = path.join(ROOT, span);
    if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) missing.push(span);
  }
  assert.deepEqual(missing, [], `architecture.md names directories that do not exist:\n${missing.join('\n')}`);
});

test('the layer table names every directory under src/ and every top-level file of main and shared', () => {
  const named = new Set(spansOf(section('## Layers')));
  const expected = ['src/preload/', 'src/renderer/'];
  for (const layer of ['src/application', 'src/main', 'src/shared']) {
    for (const name of subdirectories(path.join(ROOT, layer))) expected.push(`${layer}/${name}/`);
  }
  for (const layer of ['src/main', 'src/shared']) {
    const files = fs.readdirSync(path.join(ROOT, layer), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
      .map((entry) => `${layer}/${entry.name}`);
    expected.push(...files);
  }
  const missing = expected.filter((entry) => !named.has(entry));
  assert.deepEqual(missing, [], `the Layers table of architecture.md lacks:\n${missing.join('\n')}`);
  assert.ok(fs.existsSync(SRC), 'src/ exists');
});

test('the port lists match the two ports folders', () => {
  const portsOf = (dir) => fs.readdirSync(path.join(SRC, dir))
    .filter((name) => name.endsWith('-port.js'))
    .map((name) => name.replace(/\.js$/, ''));
  const onDisk = new Set([...portsOf('application/ports'), ...portsOf('main/ports')]);
  const named = new Set(SPANS.filter((span) => /^[a-z]+(?:-[a-z]+)*-port$/.test(span)));

  const undocumented = [...onDisk].filter((name) => !named.has(name)).sort();
  const unknown = [...named].filter((name) => !onDisk.has(name)).sort();
  assert.deepEqual(undocumented, [], `ports without an entry in architecture.md:\n${undocumented.join('\n')}`);
  assert.deepEqual(unknown, [], `architecture.md names ports that do not exist:\n${unknown.join('\n')}`);
});
