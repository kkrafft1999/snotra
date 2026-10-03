// The rule for a name typed into the tree (#349): the same on all three
// platforms, the strictest of them, checked in the renderer while typing and
// in main before the disk is touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateItemName,
  namesFoldEqual,
  MAX_ITEM_NAME_BYTES,
} = require('../src/shared/contracts/item-name');

const reasonOf = (name) => validateItemName(name).reason ?? null;

test('ordinary names pass, trimmed of the white space around them', () => {
  for (const name of ['notes.md', 'Übersicht März.md', 'my file (2).txt', '.env', '.github', 'a', 'Ölförderung']) {
    assert.deepEqual(validateItemName(name), { ok: true, name });
  }
  assert.deepEqual(validateItemName('  draft.md \t'), { ok: true, name: 'draft.md' });
});

test('empty, dot names and separators are refused', () => {
  assert.equal(reasonOf(''), 'empty');
  assert.equal(reasonOf('   '), 'empty');
  assert.equal(reasonOf(undefined), 'empty');
  assert.equal(reasonOf(42), 'empty');
  assert.equal(reasonOf('.'), 'dots');
  assert.equal(reasonOf('..'), 'dots');
  assert.equal(reasonOf('../escape.md'), 'separator');
  assert.equal(reasonOf('a/b'), 'separator');
  assert.equal(reasonOf('a\\b'), 'separator');
  assert.equal(reasonOf('/etc'), 'separator');
});

test('what Windows cannot hold is refused on every platform', () => {
  for (const char of ['<', '>', ':', '"', '|', '?', '*']) {
    assert.deepEqual(
      validateItemName(`a${char}b`),
      { ok: false, reason: 'character', name: `a${char}b`, character: char },
    );
  }
  assert.equal(reasonOf('notes.'), 'trailing-dot');
  assert.equal(reasonOf('a\u0007b'), 'control');
  for (const name of ['CON', 'con', 'nul.txt', 'Aux.md', 'COM1', 'lpt9.log', 'com¹']) {
    assert.equal(reasonOf(name), 'reserved', name);
  }
  // Only the device name itself is reserved, not a name that starts with it.
  for (const name of ['console.md', 'nullable.js', 'com10', 'auxiliary']) {
    assert.equal(validateItemName(name).ok, true, name);
  }
});

test('the limit is 255 bytes of UTF-8, not 255 characters', () => {
  assert.equal(validateItemName('a'.repeat(MAX_ITEM_NAME_BYTES)).ok, true);
  assert.equal(reasonOf('a'.repeat(MAX_ITEM_NAME_BYTES + 1)), 'too-long');
  // 128 umlauts are 256 bytes.
  assert.equal(reasonOf('ü'.repeat(128)), 'too-long');
  assert.equal(validateItemName('ü'.repeat(127)).ok, true);
});

test('names fold equal across case and Unicode normalization', () => {
  assert.equal(namesFoldEqual('readme.md', 'README.md'), true);
  assert.equal(namesFoldEqual('März', 'März'), true);
  assert.equal(namesFoldEqual('a.md', 'b.md'), false);
});
