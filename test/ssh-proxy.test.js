// The tunnel helper for git over SSH in the macOS sandbox (#932), against a
// stand-in for the runtime's proxy: it must send the credentials from
// HTTPS_PROXY, pass bytes both ways, and say so when the proxy refuses.
// The real sandbox is exercised in sandbox-isolation.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('child_process');
const { existsSync } = require('fs');
const net = require('net');
const path = require('path');

const PERL = '/usr/bin/perl';
const SCRIPT = path.join(__dirname, '..', 'src', 'main', 'services', 'ssh-proxy.pl');
const skip = existsSync(PERL) ? false : 'no /usr/bin/perl';

/**
 * A CONNECT proxy that records each request and answers with `status`. An
 * accepted tunnel echoes what it receives, upper-cased, after a greeting that
 * arrives in the same packet as the 200 — as an SSH banner can.
 */
async function fakeProxy(status) {
  const requests = [];
  const server = net.createServer((socket) => {
    let head = '';
    socket.on('data', function onHead(chunk) {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      socket.off('data', onHead);
      requests.push(head.split('\r\n\r\n')[0]);
      if (status !== 200) {
        socket.end(`HTTP/1.1 ${status} Forbidden\r\nContent-Length: 0\r\n\r\n`);
        return;
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\nSSH-2.0-fake\r\n');
      socket.on('data', (data) => socket.write(data.toString('latin1').toUpperCase()));
      socket.on('end', () => socket.end());
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

function runHelper(args, proxyUrl, input) {
  return new Promise((resolve) => {
    const child = childProcess.spawn(PERL, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH, HTTPS_PROXY: proxyUrl },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('the tunnel carries the proxy credentials and passes bytes both ways', { skip }, async () => {
  const proxy = await fakeProxy(200);
  try {
    // The runtime percent-encodes the user part: a base64 command key.
    const url = `http://srt.Z2l0IGZldGNo%3D:0123abcd@localhost:${proxy.port}`;
    const result = await runHelper(['gitlab.example.com', '22'], url, 'hello');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'SSH-2.0-fake\r\nHELLO');
    const [line, ...headers] = proxy.requests[0].split('\r\n');
    assert.equal(line, 'CONNECT gitlab.example.com:22 HTTP/1.1');
    const auth = headers.find((h) => h.startsWith('Proxy-Authorization: Basic '));
    assert.equal(Buffer.from(auth.split(' ')[2], 'base64').toString(), 'srt.Z2l0IGZldGNo=:0123abcd');
  } finally {
    await proxy.close();
  }
});

test('a refused connection says so instead of ssh\'s "connection closed"', { skip }, async () => {
  const proxy = await fakeProxy(403);
  try {
    const result = await runHelper(['gitlab.example.com', '22'], `http://u:t@localhost:${proxy.port}`, '');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /the sandbox refused the connection to gitlab\.example\.com:22 \(HTTP\/1\.1 403 Forbidden\)/);
  } finally {
    await proxy.close();
  }
});

test('without a proxy or with a malformed target the helper stops before connecting', { skip }, async () => {
  assert.match((await runHelper(['host', '22'], '', '')).stderr, /no sandbox proxy in HTTPS_PROXY/);
  assert.match((await runHelper(['host;rm -rf', '22'], 'http://localhost:1', '')).stderr, /usage/);
  assert.match((await runHelper(['host', '22x'], 'http://localhost:1', '')).stderr, /usage/);
});
