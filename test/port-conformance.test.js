'use strict';

// Every port is checked against what implements it (#1004). `tsc` does the
// checking — `npm run typecheck`, which `npm test` runs first — but only for
// an implementation that names its port: an adapter's `@returns
// {import('…-port').XPort}` is what makes the compiler compare the object it
// builds with the typedef. This test holds the other half: that every port
// has such an implementation inside the checked set, that every adapter
// names a port, and that the gate is still wired up.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT_DIRS = ['src/application/ports', 'src/main/ports'];
// The driven adapters, and the remote bridge's in their own folder (#1114).
const ADAPTER_DIRS = ['src/main/adapters', 'src/main/remote'];
/**
 * Services that implement a port themselves rather than through an adapter
 * (#1098). Each one is in tsconfig.json's include list by name.
 */
const IMPLEMENTING_SERVICES = [
  'src/main/services/shell-runner-service.js',
  'src/main/services/python-runner-service.js',
];

/** Adapter factories that implement no port: stores and helpers main uses directly. */
const NOT_A_PORT = new Set([
  'createWebSearchStorePort',
  'createMcpConfigStorePort',
  'createMcpSecretsPort',
  'createGuardedLookup',
  'createUpdateCheck',
]);

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

function jsFiles(dir) {
  return fs.readdirSync(path.join(ROOT, dir))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `${dir}/${name}`);
}

function declaredPorts() {
  const ports = new Map();
  for (const file of PORT_DIRS.flatMap(jsFiles)) {
    for (const match of read(file).matchAll(/@typedef \{Object\} ([A-Za-z]+Port)\b/g)) ports.set(match[1], file);
  }
  return ports;
}

/** `XPort` → the adapter files whose factories return it. */
function implementedPorts() {
  const implemented = new Map();
  for (const file of [...ADAPTER_DIRS.flatMap(jsFiles), ...IMPLEMENTING_SERVICES]) {
    for (const match of read(file).matchAll(/@returns \{import\('[^']+'\)\.([A-Za-z]+Port)\b/g)) {
      implemented.set(match[1], [...(implemented.get(match[1]) || []), file]);
    }
  }
  return implemented;
}

/** The JSDoc block right above each `function createX(`, keyed by the name. */
function adapterFactories() {
  const factories = [];
  for (const file of ADAPTER_DIRS.flatMap(jsFiles)) {
    const source = read(file);
    for (const match of source.matchAll(/^(?:async )?function (create[A-Za-z]+)\(/gm)) {
      const before = source.slice(0, match.index).trimEnd();
      const doc = before.endsWith('*/') ? before.slice(before.lastIndexOf('/**')) : '';
      factories.push({ file, name: match[1], doc });
    }
  }
  return factories;
}

test('every port has a type-checked implementation', () => {
  const ports = declaredPorts();
  const implemented = implementedPorts();
  assert.ok(ports.size >= 30, `found only ${ports.size} port typedefs — did the pattern stop matching?`);
  const missing = [...ports.keys()].filter((port) => !implemented.has(port));
  assert.deepEqual(missing, [], 'a port without an adapter that names it in `@returns` is a contract nobody checks');
});

test('a port file is a type declaration and exports no runtime value', () => {
  // The values a port's callers need live in src/shared/contracts/ (#1098).
  for (const file of PORT_DIRS.flatMap(jsFiles)) {
    assert.deepEqual(Object.keys(require(path.join(ROOT, file))), [], `${file} exports a runtime value`);
  }
});

test('every adapter factory names the port it implements', () => {
  const unnamed = adapterFactories()
    .filter(({ name, doc }) => !NOT_A_PORT.has(name) && !/@returns \{import\('[^']+-port'\)\.[A-Za-z]+Port\b/.test(doc))
    .map(({ file, name }) => `${file}: ${name}`);
  assert.deepEqual(unnamed, [], 'without `@returns {import(…-port).XPort}` tsc has nothing to compare the adapter with');
  for (const name of NOT_A_PORT) {
    assert.ok(adapterFactories().some((factory) => factory.name === name), `${name} is gone — drop it from NOT_A_PORT`);
  }
});

test('the type check covers the core, the ports, the contracts and the adapters', () => {
  // tsconfig.json is JSONC; its comments are whole lines.
  const config = JSON.parse(read('tsconfig.json').replace(/^\s*\/\/.*$/gm, ''));
  // The three source trees are included as a whole (#1098), with nothing
  // excluded: a port, an adapter or a service that implements one cannot fall
  // out of the type check.
  for (const tree of ['src/application', 'src/main', 'src/shared']) {
    assert.ok(config.include.includes(`${tree}/**/*.js`), `${tree} fell out of the include list`);
  }
  assert.equal(config.exclude, undefined, 'nothing is excluded from the type check any more (#1098)');
  assert.equal(config.compilerOptions.checkJs, true);
  assert.equal(config.compilerOptions.noImplicitAny, true, 'every parameter has a type (#1098)');
  assert.equal(config.compilerOptions.strictNullChecks, true, 'null and undefined are values of their own (#1098)');
  assert.equal(config.compilerOptions.noEmit, true, 'the app has no build step; tsc must not write files');
});

test('npm test runs the type check first', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json');
  assert.match(pkg.scripts.pretest, /npm run typecheck/);
  assert.ok(pkg.devDependencies.typescript, 'typescript is a dev dependency only');
  assert.ok(!pkg.dependencies.typescript, 'typescript must not ship with the app');
});
