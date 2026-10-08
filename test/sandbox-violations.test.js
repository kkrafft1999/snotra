// What the sandbox refused, parsed from the runtime's violation lines (#792):
// the three dialects (Seatbelt, Linux observer, proxy), folding cache writes
// into their folder, and the text the model reads instead of the raw lines.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  KINDS,
  MAX_ENTRIES,
  parseViolationLine,
  summarizeViolations,
  describeForModel,
} = require('../src/main/services/sandbox-violations');

const HOME = '/Users/me';

test('parseViolationLine: a Seatbelt write names the path and the process', () => {
  assert.deepEqual(parseViolationLine('node(4711) deny(1) file-write-create /Users/me/Library/Caches/prisma/x'), {
    kind: KINDS.WRITE,
    operation: 'file-write-create',
    process: 'node',
    target: '/Users/me/Library/Caches/prisma/x',
  });
});

test('parseViolationLine: a path with spaces and a process name with spaces stay whole', () => {
  const p = parseViolationLine('Code Helper(12) deny(1) file-write-data /Users/me/Library/Application Support/x y');
  assert.equal(p.kind, KINDS.WRITE);
  assert.equal(p.process, 'Code Helper');
  assert.equal(p.target, '/Users/me/Library/Application Support/x y');
});

test('parseViolationLine: a Seatbelt read is a protected location', () => {
  const p = parseViolationLine('npm(9) deny(1) file-read-data /Users/me/.npmrc');
  assert.equal(p.kind, KINDS.READ);
  assert.equal(p.target, '/Users/me/.npmrc');
});

test('parseViolationLine: a Seatbelt network-outbound to an address bypassed the proxy', () => {
  const p = parseViolationLine('psql(77) deny(1) network-outbound 10.0.0.5:5432');
  assert.equal(p.kind, KINDS.DIRECT);
  assert.equal(p.target, '10.0.0.5:5432');
});

test('parseViolationLine: a Seatbelt network-outbound to a socket path is no connection to a host', () => {
  assert.equal(parseViolationLine('x(1) deny(1) network-outbound /private/var/run/foo.sock').kind, KINDS.OTHER);
});

test('parseViolationLine: other Seatbelt operations are kept as such', () => {
  const p = parseViolationLine('go(3) deny(1) mach-lookup com.apple.trustd.agent');
  assert.equal(p.kind, KINDS.OTHER);
  assert.equal(p.operation, 'mach-lookup');
  assert.equal(p.target, 'com.apple.trustd.agent');
});

test('parseViolationLine: the proxy dialect carries host, port and reason', () => {
  assert.deepEqual(parseViolationLine('deny network-outbound download.pytorch.org:443 (host is not on the allow list)'), {
    kind: KINDS.NETWORK,
    target: 'download.pytorch.org:443',
    operation: 'network-outbound',
    reason: 'host is not on the allow list',
  });
});

test('parseViolationLine: a refused HTTP request is reduced to its host', () => {
  const p = parseViolationLine('deny http-request GET https://api.example.com/v1/x?… (blocked by rule)');
  assert.equal(p.kind, KINDS.NETWORK);
  assert.equal(p.target, 'api.example.com:443');
  assert.equal(p.operation, 'http-request GET');
  assert.equal(p.reason, 'blocked by rule');
});

test('parseViolationLine: the Linux observer reports write intents', () => {
  const p = parseViolationLine('deny openat /home/me/.cache/pip/http/a');
  assert.equal(p.kind, KINDS.WRITE);
  assert.equal(p.target, '/home/me/.cache/pip/http/a');
  assert.equal(p.operation, 'openat');
});

test('parseViolationLine: empty input is nothing, unknown text is kept as other', () => {
  assert.equal(parseViolationLine(''), null);
  assert.equal(parseViolationLine('   '), null);
  assert.deepEqual(parseViolationLine('something odd'), { kind: KINDS.OTHER, target: '', operation: 'something odd' });
});

test('summarizeViolations: no lines, no summary', () => {
  assert.equal(summarizeViolations([]), null);
  assert.equal(summarizeViolations(undefined), null);
  assert.equal(summarizeViolations(['', '  ']), null);
});

test('summarizeViolations: a cache full of files folds into the program\'s cache folder', () => {
  const lines = [];
  for (let i = 0; i < 40; i += 1) {
    lines.push(`pip(5) deny(1) file-write-create ${HOME}/Library/Caches/pip/http-v2/${i % 7}/${i}/body`);
  }
  const s = summarizeViolations(lines, { homeDir: HOME });
  assert.equal(s.entries.length, 1);
  assert.deepEqual(s.entries[0], {
    kind: KINDS.WRITE,
    target: `${HOME}/Library/Caches/pip/http-v2`,
    folder: true,
    count: 40,
    operations: ['file-write-create'],
  });
  assert.equal(s.total, 40);
});

test('summarizeViolations: two programs under ~/Library/Caches stay apart', () => {
  const s = summarizeViolations([
    `a(1) deny(1) file-write-create ${HOME}/Library/Caches/prisma/engines/1`,
    `a(1) deny(1) file-write-create ${HOME}/Library/Caches/prisma/engines/2`,
    `b(2) deny(1) file-write-data ${HOME}/Library/Caches/other/file`,
  ], { homeDir: HOME });
  assert.deepEqual(s.entries.map((e) => [e.target, e.count, !!e.folder]), [
    [`${HOME}/Library/Caches/other/file`, 1, false],
    [`${HOME}/Library/Caches/prisma/engines`, 2, true],
  ]);
});

test('summarizeViolations: single files in the home folder are not folded into the home folder', () => {
  const s = summarizeViolations([
    `x(1) deny(1) file-write-create ${HOME}/.a`,
    `x(1) deny(1) file-write-create ${HOME}/.b`,
  ], { homeDir: HOME });
  assert.deepEqual(s.entries.map((e) => e.target), [`${HOME}/.a`, `${HOME}/.b`]);
});

test('summarizeViolations: repeated lines count once per resource, with every operation', () => {
  const s = summarizeViolations([
    `x(1) deny(1) file-write-create ${HOME}/out.txt`,
    `x(1) deny(1) file-write-data ${HOME}/out.txt`,
    'deny network-outbound example.com:443 (host is not on the allow list)',
    'deny network-outbound example.com:443 (host is not on the allow list)',
  ], { homeDir: HOME });
  assert.equal(s.entries.length, 2);
  assert.deepEqual(s.entries[0].operations, ['file-write-create', 'file-write-data']);
  assert.equal(s.entries[1].kind, KINDS.NETWORK);
  assert.equal(s.entries[1].count, 2);
  assert.equal(s.entries[1].reason, 'host is not on the allow list');
});

test('summarizeViolations: entries are ordered write, read, network, direct', () => {
  const s = summarizeViolations([
    'psql(7) deny(1) network-outbound 10.0.0.5:5432',
    'deny network-outbound a.example:443 (host is not on the allow list)',
    'x(1) deny(1) file-read-data /Users/me/.npmrc',
    'x(1) deny(1) file-write-create /Users/me/x',
  ], { homeDir: HOME });
  assert.deepEqual(s.entries.map((e) => e.kind), [KINDS.WRITE, KINDS.READ, KINDS.NETWORK, KINDS.DIRECT]);
});

test('summarizeViolations: the system queries every Seatbelt run makes are left out', () => {
  const noise = [
    'sh(1) deny(1) sysctl-read kern.iossupportversion',
    'curl(2) deny(1) system-info vfs.disk-space',
    'curl(2) deny(1) mach-lookup com.apple.SystemConfiguration.configd',
  ];
  assert.equal(summarizeViolations(noise, { homeDir: HOME }), null);
  const s = summarizeViolations([...noise, 'cat(3) deny(1) file-read-data /Users/me/.ssh/config'], { homeDir: HOME });
  assert.equal(s.entries.length, 1);
  assert.equal(s.total, 1);
  assert.deepEqual(s.raw, ['cat(3) deny(1) file-read-data /Users/me/.ssh/config']);
});

test('summarizeViolations: more resources than fit are counted, not listed', () => {
  const lines = [];
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) lines.push(`deny network-outbound h${i}.example:443 (host is not on the allow list)`);
  const s = summarizeViolations(lines, { homeDir: HOME });
  assert.equal(s.entries.length, MAX_ENTRIES);
  assert.equal(s.moreEntries, 5);
  assert.equal(s.total, MAX_ENTRIES + 5);
  assert.equal(s.raw.length, MAX_ENTRIES + 5);
});

test('describeForModel: one line per resource and the instruction not to work around it', () => {
  const s = summarizeViolations([
    `pip(5) deny(1) file-write-create ${HOME}/Library/Caches/pip/a/1`,
    `pip(5) deny(1) file-write-create ${HOME}/Library/Caches/pip/b/2`,
    'deny network-outbound download.pytorch.org:443 (host is not on the allow list)',
  ], { homeDir: HOME });
  const text = describeForModel(s);
  assert.match(text, /^<sandbox_blocked>\n/);
  assert.match(text, /\n<\/sandbox_blocked>$/);
  assert.match(text, /- write outside the workspace: \/Users\/me\/Library\/Caches\/pip\/ \(2 paths\)/);
  assert.match(text, /- connection to a host outside network_domains: download\.pytorch\.org:443 \(host is not on the allow list\)/);
  assert.match(text, /Do not work around it/);
  assert.match(text, /network_domains of a new call/);
});

test('describeForModel: without a network refusal it does not mention network_domains', () => {
  const text = describeForModel(summarizeViolations(['x(1) deny(1) file-write-create /Users/me/x'], { homeDir: HOME }));
  assert.doesNotMatch(text, /network_domains of a new call/);
  assert.equal(describeForModel(null), '');
});
