// Links aus Modellantworten (Issues #82, #83).
//
// Der Klick-Handler in ChatStream.js braucht ein DOM; die Entscheidung, ob ein
// Link geoeffnet wird und was bei einem Fehlschlag zu melden ist, liegt darum
// in einem eigenen Modul und wird hier ohne DOM geprueft.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const modulePromise = import(
  pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'chat', 'openChatLink.js')).href
);

test('isOpenableChatLink deckt sich mit dem, was der Sanitizer stehen laesst', async () => {
  const { isOpenableChatLink } = await modulePromise;

  assert.equal(isOpenableChatLink('https://example.com'), true);
  assert.equal(isOpenableChatLink('http://localhost:3000'), true);
  assert.equal(isOpenableChatLink('mailto:test@example.com'), true);
  assert.equal(isOpenableChatLink('  mailto:test@example.com'), true);

  for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', '#anker', '', null, undefined]) {
    assert.equal(isOpenableChatLink(bad), false, String(bad));
  }
});

test('openChatLink reicht den Link an den Main-Prozess weiter', async () => {
  const { openChatLink } = await modulePromise;
  const calls = [];
  const api = {
    openExternal(url) {
      calls.push(url);
      return Promise.resolve({ ok: true });
    },
  };

  assert.deepEqual(await openChatLink(api, 'mailto:test@example.com'), { ok: true });
  assert.deepEqual(calls, ['mailto:test@example.com']);
});

test('openChatLink meldet einen Fehler des Main-Prozesses zurueck', async () => {
  const { openChatLink } = await modulePromise;
  const api = { openExternal: () => Promise.resolve({ ok: false, error: 'Kein Mailprogramm' }) };

  assert.deepEqual(await openChatLink(api, 'mailto:test@example.com'), {
    ok: false,
    error: 'Kein Mailprogramm',
  });
});

test('openChatLink schluckt eine abgewiesene IPC-Promise, statt sie unbehandelt zu lassen', async () => {
  const { openChatLink } = await modulePromise;
  const api = { openExternal: () => Promise.reject(new Error('IPC weg')) };

  assert.deepEqual(await openChatLink(api, 'https://example.com'), {
    ok: false,
    error: 'IPC weg',
  });
});

test('openChatLink oeffnet nichts, was der Sanitizer nicht durchlaesst', async () => {
  const { openChatLink } = await modulePromise;
  let called = false;
  const api = {
    openExternal() {
      called = true;
      return Promise.resolve({ ok: true });
    },
  };

  const result = await openChatLink(api, 'file:///etc/passwd');
  assert.equal(result.ok, false);
  assert.equal(called, false);
});

test('openChatLink meldet eine fehlende Bruecke, statt zu werfen', async () => {
  const { openChatLink } = await modulePromise;

  const result = await openChatLink({}, 'https://example.com');
  assert.equal(result.ok, false);
  assert.match(result.error, /nicht geöffnet werden/);
});
