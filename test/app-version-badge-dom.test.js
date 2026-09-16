// Versions-Badge in der Titelleiste (Issue #153).
//
// Das Markup kommt aus der echten index.html — faellt die ID #app-version
// weg, faellt dieser Test und nicht erst die App.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom } = require('./helpers/dom.js');

async function mount(api) {
  const dom = setupRendererDom();
  const { initAppVersionBadge } = await importRenderer('components', 'AppVersionBadge.js');
  const result = await initAppVersionBadge({ api });
  return { dom, result, badge: dom.document.getElementById('app-version') };
}

test('Badge zeigt die Version aus der App und wird erst dann sichtbar', async () => {
  const { result, badge } = await mount({ getAppVersion: async () => ({ version: '1.6.0' }) });

  assert.equal(result, '1.6.0');
  assert.equal(badge.textContent, '1.6.0');
  assert.equal(badge.hidden, false);
  assert.equal(badge.getAttribute('aria-label'), 'Version 1.6.0');
});

test('Badge bleibt verborgen, wenn die Abfrage fehlschlaegt', async () => {
  const { result, badge } = await mount({
    getAppVersion: async () => { throw new Error('IPC weg'); },
  });

  assert.equal(result, null);
  assert.equal(badge.hidden, true);
  assert.equal(badge.textContent, '');
});

test('Badge bleibt verborgen, wenn keine Version zurueckkommt', async () => {
  for (const answer of [null, {}, { version: '' }, { version: '   ' }]) {
    const { result, badge } = await mount({ getAppVersion: async () => answer });
    assert.equal(result, null, `Antwort ${JSON.stringify(answer)}`);
    assert.equal(badge.hidden, true, `Antwort ${JSON.stringify(answer)}`);
  }
});

test('ohne getAppVersion im API-Objekt passiert nichts', async () => {
  const { result, badge } = await mount({});
  assert.equal(result, null);
  assert.equal(badge.hidden, true);
});
