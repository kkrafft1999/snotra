// How a configured command is started on Windows (CR-B16-01): found over PATH
// and PATHEXT, and a batch file started through cmd.exe with its arguments
// escaped for both of cmd's reads. Pure functions, so they run everywhere;
// the real cmd.exe is exercised in mcp-stdio-transport.test.js on Windows.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  windowsLaunch,
  findWindowsCommand,
  escapeCmdArgument,
  escapeCmdCommand,
} = require('../src/main/services/windows-command');

const NODEJS = 'C:\\Program Files\\nodejs';
const UV = 'C:\\Users\\me\\.local\\bin';

function filesystem(...files) {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return (file) => set.has(file.toLowerCase());
}

const ENV = { Path: `${UV};"${NODEJS}"`, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' };

test('a bare name is found over PATH and PATHEXT, whatever the case of the variable names', () => {
  const isFile = filesystem(`${NODEJS}\\npx.cmd`, `${UV}\\uvx.exe`);
  assert.equal(findWindowsCommand('npx', { env: ENV, cwd: 'C:\\work', isFile }), `${NODEJS}\\npx.cmd`);
  assert.equal(findWindowsCommand('uvx', { env: ENV, cwd: 'C:\\work', isFile }), `${UV}\\uvx.exe`);
  assert.equal(findWindowsCommand('nothing', { env: ENV, cwd: 'C:\\work', isFile }), '');
});

test('PATHEXT decides the order: an .exe wins over a .cmd of the same name', () => {
  const isFile = filesystem(`${UV}\\tool.cmd`, `${UV}\\tool.exe`);
  assert.equal(findWindowsCommand('tool', { env: ENV, cwd: '', isFile }), `${UV}\\tool.exe`);
});

test('a name with an extension is taken as it is, a name with a directory relative to cwd', () => {
  const isFile = filesystem(`${NODEJS}\\npx.cmd`, 'C:\\work\\bin\\server.bat');
  assert.equal(findWindowsCommand('npx.cmd', { env: ENV, cwd: '', isFile }), `${NODEJS}\\npx.cmd`);
  assert.equal(findWindowsCommand('bin\\server', { env: ENV, cwd: 'C:\\work', isFile }), 'C:\\work\\bin\\server.bat');
  assert.equal(findWindowsCommand('C:\\work\\bin\\server.bat', { env: ENV, cwd: 'D:\\', isFile }), 'C:\\work\\bin\\server.bat');
});

test('without PATHEXT the Windows default applies', () => {
  const isFile = filesystem(`${NODEJS}\\npx.cmd`);
  const env = { PATH: NODEJS };
  assert.equal(findWindowsCommand('npx', { env, cwd: '', isFile }), `${NODEJS}\\npx.cmd`);
});

test('an .exe is started directly, by its full path', () => {
  const launch = windowsLaunch({
    command: 'uvx', args: ['mcp-server-git'], env: ENV, cwd: 'C:\\work', isFile: filesystem(`${UV}\\uvx.exe`),
  });
  assert.deepEqual(launch, { command: `${UV}\\uvx.exe`, args: ['mcp-server-git'], options: {} });
});

test('a command that is nowhere to be found is handed on unchanged, so spawn reports it', () => {
  const launch = windowsLaunch({ command: 'nothing', args: ['-x'], env: ENV, cwd: '', isFile: () => false });
  assert.deepEqual(launch, { command: 'nothing', args: ['-x'], options: {} });
});

test('a .cmd goes through cmd.exe with verbatim arguments', () => {
  const launch = windowsLaunch({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: ENV,
    cwd: 'C:\\work',
    isFile: filesystem(`${NODEJS}\\npx.cmd`),
  });
  assert.equal(launch.command, 'C:\\Windows\\system32\\cmd.exe');
  assert.deepEqual(launch.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(
    launch.args[3],
    '"C:\\Program^ Files\\nodejs\\npx.cmd ^^^"-y^^^" ^^^"@modelcontextprotocol/server-github^^^""',
  );
  assert.deepEqual(launch.options, { windowsVerbatimArguments: true });
});

test('without ComSpec, cmd.exe is found by name', () => {
  const launch = windowsLaunch({
    command: 'npx', args: [], env: { PATH: NODEJS }, cwd: '', isFile: filesystem(`${NODEJS}\\npx.cmd`),
  });
  assert.equal(launch.command, 'cmd.exe');
});

test('an argument is quoted for the program and its metacharacters escaped for both reads of cmd', () => {
  // One read of cmd takes one level of carets away; what is left after two
  // is what CommandLineToArgvW then splits.
  const twoReads = (text) => text.replace(/\^(.)/g, '$1').replace(/\^(.)/g, '$1');
  assert.equal(twoReads(escapeCmdArgument('plain')), '"plain"');
  assert.equal(twoReads(escapeCmdArgument('a b&c')), '"a b&c"');
  assert.equal(twoReads(escapeCmdArgument('%PATH%')), '"%PATH%"');
  assert.equal(twoReads(escapeCmdArgument('')), '""');
  // A quote inside is escaped for the program; the backslashes before it doubled.
  assert.equal(twoReads(escapeCmdArgument('say "hi"')), '"say \\"hi\\""');
  assert.equal(twoReads(escapeCmdArgument('a\\"b')), '"a\\\\\\"b"');
  // Trailing backslashes are doubled, because the closing quote follows them.
  assert.equal(twoReads(escapeCmdArgument('C:\\dir\\')), '"C:\\dir\\\\"');
  // Every metacharacter carries a caret for each read, quotes included.
  assert.equal(escapeCmdArgument('x&y'), '^^^"x^^^&y^^^"');
});

test('the path of the batch file is escaped once — cmd reads it once', () => {
  assert.equal(escapeCmdCommand('C:\\Program Files (x86)\\x.cmd'), 'C:\\Program^ Files^ ^(x86^)\\x.cmd');
});
