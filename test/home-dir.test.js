const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const { HOME_DIR_ENV, resolveHomeDir, withHomeDir } = require('../src/main/services/home-dir');

const elsewhere = path.resolve(os.tmpdir(), 'snotra-home-707');

test('without the variable the home folder is the real one (#707)', () => {
  assert.equal(resolveHomeDir({ env: {}, homedir: () => '/real' }), '/real');
  assert.equal(withHomeDir(os, {}), os, 'the given os comes back unchanged');
});

test('an absolute SNOTRA_HOME_DIR moves the home folder (#707)', () => {
  const env = { [HOME_DIR_ENV]: ` ${elsewhere} ` };
  assert.equal(resolveHomeDir({ env, homedir: () => '/real' }), elsewhere);
  const moved = withHomeDir(os, env);
  assert.equal(moved.homedir(), elsewhere);
  assert.equal(moved.platform(), os.platform(), 'the rest of os stays as it is');
  assert.equal(os.homedir() === elsewhere, false, 'the real os is not touched');
});

test('a relative or empty SNOTRA_HOME_DIR is ignored (#707)', () => {
  for (const value of ['', '   ', 'relative/home', 42]) {
    assert.equal(resolveHomeDir({ env: { [HOME_DIR_ENV]: value }, homedir: () => '/real' }), '/real');
  }
});
