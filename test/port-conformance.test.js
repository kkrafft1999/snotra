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
const ADAPTER_DIR = 'src/main/adapters';

/**
 * Ports whose implementation lies outside the checked set, with the reason.
 * The list may only shrink (#1098): once one of them is covered, the test
 * below asks for its entry to go.
 */
const IMPLEMENTED_OUTSIDE = new Map([
  ['ToolPolicyPort', 'built in src/main/composition (#1005, #1098)'],
  ['OwnSecretsPort', 'built in src/main/composition (#1005, #1098)'],
  ['ConfigProposalPort', 'built in src/main/composition (#1005, #1098)'],
  ['ShellExecutionPort', 'src/main/services/shell-runner-service.js (#1077, #1098)'],
  ['CodeExecutionPort', 'src/main/services/python-runner-service.js (#1077, #1098)'],
]);

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
  for (const file of jsFiles(ADAPTER_DIR)) {
    for (const match of read(file).matchAll(/@returns \{import\('[^']+'\)\.([A-Za-z]+Port)\b/g)) {
      implemented.set(match[1], [...(implemented.get(match[1]) || []), file]);
    }
  }
  return implemented;
}

/** The JSDoc block right above each `function createX(`, keyed by the name. */
function adapterFactories() {
  const factories = [];
  for (const file of jsFiles(ADAPTER_DIR)) {
    const source = read(file);
    for (const match of source.matchAll(/^(?:async )?function (create[A-Za-z]+)\(/gm)) {
      const before = source.slice(0, match.index).trimEnd();
      const doc = before.endsWith('*/') ? before.slice(before.lastIndexOf('/**')) : '';
      factories.push({ file, name: match[1], doc });
    }
  }
  return factories;
}

test('every port has a type-checked implementation, or a reason why not yet', () => {
  const ports = declaredPorts();
  const implemented = implementedPorts();
  assert.ok(ports.size >= 30, `found only ${ports.size} port typedefs — did the pattern stop matching?`);
  const missing = [...ports.keys()].filter((port) => !implemented.has(port) && !IMPLEMENTED_OUTSIDE.has(port));
  assert.deepEqual(missing, [], 'a port without an adapter that names it in `@returns` is a contract nobody checks');
});

test('the list of ports implemented outside only shrinks', () => {
  const ports = declaredPorts();
  const implemented = implementedPorts();
  for (const port of IMPLEMENTED_OUTSIDE.keys()) {
    assert.ok(ports.has(port), `${port} is no port any more — drop it from IMPLEMENTED_OUTSIDE`);
    assert.ok(!implemented.has(port), `${port} is checked now (${implemented.get(port)}) — drop it from IMPLEMENTED_OUTSIDE`);
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
  for (const dir of ['src/application', 'src/main/ports', 'src/main/adapters', 'src/shared/contracts']) {
    assert.ok(config.include.includes(`${dir}/**/*.js`), `${dir} fell out of the include list`);
  }
  assert.equal(config.compilerOptions.checkJs, true);
  assert.equal(config.compilerOptions.noEmit, true, 'the app has no build step; tsc must not write files');
});

test('npm test runs the type check first', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.typecheck, 'tsc -p tsconfig.json');
  assert.match(pkg.scripts.pretest, /npm run typecheck/);
  assert.ok(pkg.devDependencies.typescript, 'typescript is a dev dependency only');
  assert.ok(!pkg.dependencies.typescript, 'typescript must not ship with the app');
});
