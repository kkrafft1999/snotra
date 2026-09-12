const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHttpUrl, isBlockedHostname, isBlockedAddress } = require('../src/shared/runtime/url-safety');

// Issue #95: Ein frei waehlbarer Abruf ist ein SSRF-Werkzeug, solange die
// Adressregeln nicht sitzen. Deshalb hier die Grenzfaelle einzeln.

test('parseHttpUrl nimmt nur http und https an', () => {
  assert.equal(parseHttpUrl('https://example.org/a').url.href, 'https://example.org/a');
  assert.equal(parseHttpUrl('http://example.org').url.protocol, 'http:');

  for (const raw of ['file:///etc/passwd', 'ftp://example.org', 'data:text/html,<b>x', 'javascript:alert(1)']) {
    assert.match(parseHttpUrl(raw).error || '', /Nur http und https|gültige Adresse/, raw);
  }
});

test('parseHttpUrl lehnt leere und kaputte Eingaben ab', () => {
  assert.match(parseHttpUrl('').error, /keine Adresse/);
  assert.match(parseHttpUrl(null).error, /keine Adresse/);
  assert.match(parseHttpUrl('kein-url').error, /gültige Adresse/);
});

test('parseHttpUrl lehnt Zugangsdaten in der Adresse ab', () => {
  assert.match(parseHttpUrl('https://user:geheim@example.org/').error, /Benutzername oder Passwort/);
});

test('isBlockedHostname sperrt lokale Namen', () => {
  for (const host of ['localhost', 'LOCALHOST', 'foo.localhost', 'nas.local', 'db.internal', 'router.home.arpa']) {
    assert.equal(isBlockedHostname(host), true, host);
  }
  for (const host of ['example.org', 'www.github.com', 'localhost.example.org']) {
    assert.equal(isBlockedHostname(host), false, host);
  }
});

test('isBlockedHostname prüft IP-Literale direkt', () => {
  assert.equal(isBlockedHostname('127.0.0.1'), true);
  assert.equal(isBlockedHostname('192.168.1.1'), true);
  assert.equal(isBlockedHostname('[::1]'), true);
  assert.equal(isBlockedHostname('93.184.216.34'), false);
});

test('isBlockedAddress sperrt private, lokale und reservierte IPv4-Bereiche', () => {
  for (const ip of [
    '0.0.0.0',
    '10.0.0.1',
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254', // Cloud-Metadaten
    '172.16.0.1',
    '172.31.255.254',
    '192.168.178.1',
    '100.64.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '171.16.0.1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('isBlockedAddress sperrt IPv6-Loopback, ULA und Link-Local', () => {
  for (const ip of ['::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  assert.equal(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
});

test('isBlockedAddress durchschaut IPv4-in-IPv6 (::ffff:127.0.0.1)', () => {
  assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:192.168.0.1'), true);
  assert.equal(isBlockedAddress('::ffff:8.8.8.8'), false);
});

test('isBlockedAddress lehnt ab, was keine Adresse ist', () => {
  for (const value of ['', 'abc', '1.2.3', '1.2.3.4.5', '999.1.1.1', null, undefined]) {
    assert.equal(isBlockedAddress(value), true, String(value));
  }
});
