// The MCP dialog shows a server's arguments as one line and reads them back
// on save (CR-B14-03). The way back has to give exactly the list the way
// there started from — an imported argument holding JSON broke on its first
// edit before.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

async function load() {
  setupRendererDom();
  return importRenderer('components', 'McpPanel.js');
}

const ROUND_TRIPS = [
  ['--json', '{"a": 1}', '--prefix', ''],
  ['-y', '@modelcontextprotocol/server-github'],
  ['C:\\Program Files\\node\\server.js', 'C:\\srv\\run.js', 'C:\\dir\\'],
  ['say "hi"', "it's", '\\"', '\\\\', 'a\\\\b', 'back\\', '"', "'"],
  ['', '', 'x'],
  ['tab\there', 'line\nbreak', '  padded  '],
  ['--from=mein paket', 'ünïcödé ✓'],
];

test('joinArgs and splitArgs round-trip quotes, backslashes and empty arguments', async () => {
  const { joinArgs, splitArgs } = await load();
  for (const args of ROUND_TRIPS) {
    assert.deepEqual(splitArgs(joinArgs(args)), args, joinArgs(args));
  }
});

test('the round trip holds for arbitrary arguments, too', async () => {
  const { joinArgs, splitArgs } = await load();
  // A small fixed-seed generator: reproducible, and heavy on the characters
  // that matter here.
  let seed = 20261001;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const alphabet = ['a', 'Z', '0', ' ', '\t', '"', "'", '\\', '=', '-', '{', '}', ':'];
  for (let n = 0; n < 500; n += 1) {
    const args = Array.from({ length: Math.floor(random() * 5) }, () =>
      Array.from({ length: Math.floor(random() * 7) }, () => alphabet[Math.floor(random() * alphabet.length)]).join(''));
    assert.deepEqual(splitArgs(joinArgs(args)), args, JSON.stringify(args));
  }
});

test('plain arguments are shown without quotes', async () => {
  const { joinArgs } = await load();
  assert.equal(joinArgs(['-y', '@scope/pkg', 'C:\\srv\\run.js']), '-y @scope/pkg C:\\srv\\run.js');
  assert.equal(joinArgs(['--json', '{"a": 1}', '']), '--json "{\\"a\\": 1}" ""');
});

test('typed lines are read like a command line', async () => {
  const { splitArgs } = await load();
  assert.deepEqual(splitArgs('--from "mein paket" server'), ['--from', 'mein paket', 'server']);
  assert.deepEqual(splitArgs("--from='mein paket'"), ['--from=mein paket']);
  assert.deepEqual(splitArgs('--from="mein paket"'), ['--from=mein paket']);
  assert.deepEqual(splitArgs('a "" b'), ['a', '', 'b']);
  assert.deepEqual(splitArgs('  a   b  '), ['a', 'b']);
  assert.deepEqual(splitArgs('C:\\srv\\run.js'), ['C:\\srv\\run.js'], 'a backslash outside quotes is literal');
  assert.deepEqual(splitArgs('"C:\\Program Files\\x"'), ['C:\\Program Files\\x']);
  assert.deepEqual(splitArgs('"unclosed quote'), ['unclosed quote']);
  assert.deepEqual(splitArgs(''), []);
  assert.deepEqual(splitArgs(undefined), []);
});
