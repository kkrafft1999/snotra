// Removing a package although Electron's fs takes its app.asar for a folder (#914).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { writeMinimalAsar } = require('./helpers/asar.js');
const { removeTempDir } = require('./helpers/temp-dir');

const RAW_FS = require.resolve('../src/main/services/raw-fs');

test('removeTree removes a package folder with its app.asar', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-rawfs-test-'));
  t.after(() => removeTempDir(dir));
  const staged = path.join(dir, '.snotra-new-1');
  await fsp.mkdir(path.join(staged, 'resources'), { recursive: true });
  writeMinimalAsar(path.join(staged, 'resources', 'app.asar'), {
    'package.json': JSON.stringify({ productName: 'Snotra Agent', version: '1.0.0' }),
  });
  await fsp.writeFile(path.join(staged, 'Snotra Agent.exe'), 'exe');

  const { removeTree } = require(RAW_FS);
  await removeTree(staged);
  await removeTree(staged); // a folder that is gone already is fine

  assert.deepEqual(await fsp.readdir(dir), []);
});

test('inside Electron, removeTree goes through original-fs, not the patched fs', async (t) => {
  const calls = [];
  const originalFs = { promises: { rm: async (...args) => { calls.push(args); } } };
  const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'original-fs') return originalFs;
    return load.call(this, request, ...rest);
  };
  delete require.cache[RAW_FS];
  t.after(() => {
    Module._load = load;
    delete require.cache[RAW_FS];
  });

  const { rawFs, removeTree } = require(RAW_FS);
  await removeTree('/somewhere/.snotra-new-1');

  assert.equal(rawFs, originalFs);
  assert.deepEqual(calls, [['/somewhere/.snotra-new-1', { recursive: true, force: true }]]);
});

test('the updater removes folders only through removeTree', () => {
  const dir = path.join(__dirname, '..', 'src', 'main', 'services');
  const offenders = fs.readdirSync(dir)
    .filter((name) => /^update-.*\.js$/.test(name))
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n')
      .map((line, i) => ({ where: `${name}:${i + 1}`, line }))
      .filter(({ line }) => /\b(fs|fsp)\.(promises\.)?rm(Sync)?\(/.test(line) && /recursive/.test(line)))
    .map(({ where }) => where);
  assert.deepEqual(offenders, [], 'a recursive rm through the patched fs leaves app.asar behind');
});
