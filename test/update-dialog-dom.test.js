// Update-Dialog am echten DOM (Issue #232).
//
// Der Kern der Anforderung ist nicht „es aktualisiert sich", sondern „es fragt
// jedes Mal und laesst sich jederzeit abbrechen". Genau das wird hier geprueft:
// dass ohne Klick nichts geladen wird, dass ohne zweiten Klick nichts
// installiert wird, und dass Abbrechen an jeder Stelle wirklich zurueckfuehrt.

const test = require('node:test');
const assert = require('node:assert/strict');
const { importRenderer, setupRendererDom, flush } = require('./helpers/dom.js');

const AVAILABLE = Object.freeze({
  updateAvailable: true,
  currentVersion: '1.7.1',
  latestVersion: '1.8.0',
  isPrerelease: false,
  releaseUrl: 'https://example.test/releases/v1.8.0',
  notes: '- Selbst-Update\n- Kleinkram',
  canSelfUpdate: true,
  selfUpdateBlockedReason: '',
  installKind: 'macos-bundle',
  asset: { name: 'Snotra-AI-1.8.0-mac-arm64.dmg', size: 92 * 1024 * 1024 },
});

/** Mountet den Dialog gegen die echte index.html und liefert Zugriff + Spione. */
async function mount({ api: apiOverrides = {} } = {}) {
  const dom = setupRendererDom();
  const { initUpdateDialog } = await importRenderer('components', 'UpdateDialog.js');

  const calls = [];
  let pushAvailable = () => {};
  let pushProgress = () => {};

  const api = {
    onUpdateAvailable: (cb) => { pushAvailable = cb; },
    onUpdateProgress: (cb) => { pushProgress = cb; },
    checkForUpdate: async () => { calls.push('check'); return { ...AVAILABLE }; },
    ignoreUpdateVersion: async (v) => { calls.push(`ignore:${v}`); return { ok: true }; },
    downloadUpdate: async () => { calls.push('download'); return { ok: true }; },
    cancelUpdateDownload: async () => { calls.push('cancel'); return { ok: true }; },
    discardUpdateDownload: async () => { calls.push('discard'); return { ok: true }; },
    installUpdate: async () => { calls.push('install'); return { ok: true }; },
    openExternal: async (url) => { calls.push(`open:${url}`); return { ok: true }; },
    ...apiOverrides,
  };

  const dialog = initUpdateDialog({ api });
  const $ = (id) => dom.document.getElementById(id);
  const buttons = () => Array.from($('modal-update-actions').querySelectorAll('button'));
  const labels = () => buttons().map((b) => b.textContent);
  const click = async (label) => {
    const btn = buttons().find((b) => b.textContent.startsWith(label));
    assert.ok(btn, `Knopf „${label}" nicht gefunden, da steht: ${labels().join(' | ')}`);
    btn.click();
    await flush();
  };

  return {
    dom, dialog, calls, $, buttons, labels, click,
    isOpen: () => !$('modal-update').classList.contains('hidden'),
    title: () => $('modal-update-title').textContent,
    summary: () => $('modal-update-summary').textContent,
    hint: () => $('modal-update-hint'),
    push: async (payload) => { pushAvailable(payload); await flush(); },
    progress: async (payload) => { pushProgress(payload); await flush(); },
  };
}

test('ein stiller Start-Check ohne Update oeffnet gar nichts', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.push({ updateAvailable: false, currentVersion: '1.7.1' });
  assert.equal(ui.isOpen(), false);
});

test('ein gefundenes Update wird gezeigt, aber noch nichts geladen', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.push({ ...AVAILABLE });

  assert.equal(ui.isOpen(), true);
  assert.equal(ui.title(), 'Version 1.8.0 is available');
  assert.match(ui.summary(), /You have version 1\.7\.1/);
  // Die Groesse steht im Text — der Nutzer entscheidet mit Kenntnis darueber,
  // was der Klick kostet, ohne dass die Knopfzeile umbricht.
  assert.match(ui.summary(), /the new version \(92,0 MB\)/);
  assert.deepEqual(ui.labels(), ['Download', 'Remind me later', 'Skip this version']);
  assert.deepEqual(ui.calls, [], 'ohne Klick wird nichts geladen');
  assert.match(ui.dom.document.getElementById('modal-update-notes-body').textContent, /Selbst-Update/);
});

test('eine Vorab-Version wird als solche benannt', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.push({ ...AVAILABLE, isPrerelease: true });
  assert.equal(ui.title(), 'Version 1.8.0 is available (pre-release)');
});

test('„Später erinnern" schliesst nur, „überspringen" merkt sich die Version', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Remind me later');
  assert.equal(ui.isOpen(), false);
  assert.deepEqual(ui.calls, []);

  await ui.push({ ...AVAILABLE });
  await ui.click('Skip this version');
  assert.equal(ui.isOpen(), false);
  assert.deepEqual(ui.calls, ['ignore:1.8.0']);
});

test('die dauerhafte Wirkung steht in der Beschriftung, nicht im Titel-Text', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.push({ ...AVAILABLE });

  // Ein `title` waere fuer Tastatur und Touch unsichtbar — die Knoepfe
  // muessen ihre Wirkung selbst sagen.
  assert.deepEqual(ui.buttons().map((b) => b.title), ['', '', '']);
  // Nur einer der beiden Abbrecher wirkt dauerhaft; der steht als dritte
  // Stufe da, nicht als gleichwertiger Nachbar der Hauptaktion.
  const skip = ui.buttons().find((b) => b.textContent.includes('Skip'));
  assert.equal(skip.className, 'btn-tertiary');
  assert.equal(ui.buttons()[0].className, 'btn-primary', 'Hauptaktion bleibt vorn');
  assert.equal(ui.dom.document.activeElement, ui.buttons()[0], 'und behaelt den Fokus');
});

test('der ganze Weg: laden bestaetigen, dann noch einmal installieren bestaetigen', async (t) => {
  let resolveDownload;
  const calls = [];
  const ui = await mount({
    api: {
      downloadUpdate: () => {
        calls.push('download');
        return new Promise((resolve) => { resolveDownload = resolve; });
      },
      installUpdate: async () => { calls.push('install'); return { ok: true }; },
    },
  });
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Download');

  // Waehrend des Downloads: Fortschritt sichtbar, nur noch „Abbrechen", und
  // der Dialog laesst sich nicht wegklicken.
  assert.equal(ui.title(), 'Downloading version 1.8.0');
  assert.deepEqual(ui.labels(), ['Cancel']);
  assert.equal(ui.$('modal-update-progress').classList.contains('hidden'), false);
  assert.equal(ui.$('modal-update-close').disabled, true);
  ui.$('modal-update-backdrop').click();
  await flush();
  assert.equal(ui.isOpen(), true, 'ein Klick daneben darf den Download nicht wegwerfen');

  await ui.progress({ receivedBytes: 46 * 1024 * 1024, totalBytes: 92 * 1024 * 1024 });
  assert.equal(ui.$('modal-update-track').getAttribute('aria-valuenow'), '50');
  assert.match(ui.$('modal-update-progress-text').textContent, /^50 % – 46,0 MB of 92,0 MB$/);
  assert.equal(ui.$('modal-update-bar').style.width, '50%');

  resolveDownload({ ok: true });
  await flush();

  // Geladen heisst noch nicht installiert — es wird erneut gefragt.
  assert.equal(ui.title(), 'Version 1.8.0 is ready');
  assert.deepEqual(ui.labels(), ['Install and restart', 'Cancel']);
  assert.deepEqual(calls, ['download'], 'noch nichts installiert');

  await ui.click('Install and restart');
  assert.deepEqual(calls, ['download', 'install']);
  assert.equal(ui.title(), 'Installing version 1.8.0');
  assert.match(ui.summary(), /can no longer be cancelled/);
  assert.deepEqual(ui.labels(), [], 'ab hier gibt es keinen wirkungslosen Knopf');
});

test('Abbrechen im Download fuehrt zurueck auf „verfuegbar"', async (t) => {
  let resolveDownload;
  const ui = await mount({
    api: { downloadUpdate: () => new Promise((resolve) => { resolveDownload = resolve; }) },
  });
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Download');
  await ui.click('Cancel');
  assert.deepEqual(ui.calls, ['cancel']);

  resolveDownload({ ok: false, canceled: true });
  await flush();

  assert.equal(ui.title(), 'Version 1.8.0 is available');
  assert.ok(ui.labels()[0].startsWith('Download'), 'der Weg steht wieder offen');
  assert.equal(ui.$('modal-update-close').disabled, false);
});

test('Abbrechen nach dem Laden verwirft die Datei und schliesst', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Download');
  assert.equal(ui.title(), 'Version 1.8.0 is ready');

  await ui.click('Cancel');
  assert.deepEqual(ui.calls, ['download', 'discard']);
  assert.equal(ui.isOpen(), false);
});

test('Escape schliesst den Dialog, solange nichts laeuft', async (t) => {
  let resolveDownload;
  const ui = await mount({
    api: { downloadUpdate: () => new Promise((resolve) => { resolveDownload = resolve; }) },
  });
  t.after(ui.dom.cleanup);
  const escape = () => {
    ui.$('modal-update').dispatchEvent(
      new ui.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
    );
  };

  await ui.push({ ...AVAILABLE });
  escape();
  await flush();
  assert.equal(ui.isOpen(), false);

  await ui.push({ ...AVAILABLE });
  await ui.click('Download');
  escape();
  await flush();
  assert.equal(ui.isOpen(), true, 'waehrend des Downloads bleibt der Dialog stehen');
  resolveDownload({ ok: false, canceled: true });
  await flush();
});

test('ein fehlgeschlagener Download bietet Wiederholung und den Handweg an', async (t) => {
  const ui = await mount({
    api: { downloadUpdate: async () => ({ ok: false, error: 'Netzwerk weg.' }) },
  });
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Download');

  assert.equal(ui.title(), 'The update did not work');
  assert.equal(ui.summary(), 'Netzwerk weg.');
  assert.equal(ui.$('modal-update-notes').classList.contains('hidden'), true,
    'im Fehlerfall lenkt die Änderungsliste nur ab');
  assert.match(ui.hint().textContent, /running version is unchanged/);
  assert.equal(ui.hint().classList.contains('hidden'), false);
  assert.deepEqual(ui.labels(), ['Try again', 'Open release page', 'Close']);

  await ui.click('Open release page');
  assert.ok(ui.calls.includes('open:https://example.test/releases/v1.8.0'));
});

test('eine gescheiterte Installation meldet sich, statt stumm haengenzubleiben', async (t) => {
  const ui = await mount({
    api: { installUpdate: async () => ({ ok: false, error: 'Keine Schreibrechte für /Applications.' }) },
  });
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Download');
  await ui.click('Install and restart');

  assert.equal(ui.title(), 'The update did not work');
  assert.equal(ui.summary(), 'Keine Schreibrechte für /Applications.');
  assert.equal(ui.$('modal-update-close').disabled, false, 'der Dialog ist wieder bedienbar');
});

test('ohne moegliches Selbst-Update erklaert der Dialog den Grund und verlinkt', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);

  await ui.push({
    ...AVAILABLE,
    canSelfUpdate: false,
    installKind: 'linux-package',
    selfUpdateBlockedReason: 'Snotra AI wurde als Systempaket installiert.',
    asset: null,
  });

  assert.equal(ui.hint().textContent, 'Snotra AI wurde als Systempaket installiert.');
  assert.deepEqual(ui.labels(), ['Open release page', 'Remind me later', 'Skip this version']);

  await ui.click('Open release page');
  assert.deepEqual(ui.calls, ['open:https://example.test/releases/v1.8.0']);
});

test('der manuelle Check meldet auch, wenn es nichts Neues gibt', async (t) => {
  const ui = await mount({
    api: { checkForUpdate: async () => ({ updateAvailable: false, currentVersion: '1.8.0' }) },
  });
  t.after(ui.dom.cleanup);

  await ui.dialog.checkNow();
  await flush();

  assert.equal(ui.isOpen(), true);
  assert.equal(ui.title(), 'No new version');
  assert.match(ui.summary(), /already have the latest version \(1\.8\.0\)/);
  assert.deepEqual(ui.labels(), ['Close']);
});

test('eine fehlgeschlagene Pruefung wird als solche benannt', async (t) => {
  const ui = await mount({
    api: { checkForUpdate: async () => ({ updateAvailable: false, currentVersion: '1.7.1', error: 'Server nicht erreichbar.' }) },
  });
  t.after(ui.dom.cleanup);

  await ui.dialog.checkNow();
  await flush();
  assert.match(ui.summary(), /check failed: Server nicht erreichbar\./);
});

test('ohne bekannte Gesamtgroesse laeuft ein unbestimmter Balken statt einer erfundenen Zahl', async (t) => {
  let resolveDownload;
  const ui = await mount({
    api: { downloadUpdate: () => new Promise((resolve) => { resolveDownload = resolve; }) },
  });
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE, asset: null, canSelfUpdate: true });
  await ui.click('Download');
  await ui.progress({ receivedBytes: 1024 * 1024, totalBytes: 0 });

  assert.equal(
    ui.$('modal-update-track').classList.contains('update-progress__track--indeterminate'),
    true
  );
  assert.equal(ui.$('modal-update-track').hasAttribute('aria-valuenow'), false);
  assert.equal(ui.$('modal-update-progress-text').textContent, '1,0 MB geladen');
  resolveDownload({ ok: false, canceled: true });
  await flush();
});

test('der Fokus landet auf der Hauptaktion und bleibt im Dialog', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.push({ ...AVAILABLE });

  const items = ui.buttons();
  assert.equal(ui.dom.document.activeElement, items[0], 'die Hauptaktion hat den Fokus');

  // Tab am letzten Element springt an den Anfang zurueck, nicht aus dem Dialog.
  const last = items[items.length - 1];
  last.focus();
  last.dispatchEvent(new ui.dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  await flush();
  assert.equal(ui.dom.document.activeElement, ui.$('modal-update-close'));
});

test('die Aenderungsliste nennt nur, was sich geaendert hat', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  // So liefert GitHub seine automatisch gesetzten Notizen aus.
  await ui.push({
    ...AVAILABLE,
    notes: [
      "## What's Changed",
      '* Gedaechtnis: Snotra merkt sich Gesagtes by @kkrafft1999 in https://github.com/kkrafft1999/snotra/pull/265',
      '* Release v1.7.6 by @kkrafft1999 in https://github.com/kkrafft1999/snotra/pull/270',
      '',
      '## New Contributors',
      '* @someone made their first contribution in https://github.com/kkrafft1999/snotra/pull/1',
      '',
      '**Full Changelog**: https://github.com/kkrafft1999/snotra/compare/v1.7.5...v1.7.6',
    ].join('\n'),
  });

  const text = ui.$('modal-update-notes-body').textContent;
  assert.equal(text, [
    '• Gedaechtnis: Snotra merkt sich Gesagtes',
    '• Release v1.7.6',
  ].join('\n'));
  assert.equal(/@|github\.com|pull\//.test(text), false, 'kein Autor, kein Link');
  assert.equal(ui.$('modal-update-notes').classList.contains('hidden'), false);
});

test('bleibt von den Notizen nichts uebrig, wird die Liste nicht angeboten', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.push({
    ...AVAILABLE,
    notes: "## What's Changed\n\n**Full Changelog**: https://example.test/compare",
  });
  assert.equal(ui.$('modal-update-notes').classList.contains('hidden'), true);
});

test('handgeschriebene Notizen behalten ihre Gliederung', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.push({
    ...AVAILABLE,
    notes: '### Behoben\r\n- Absturz beim Start\r\n  - auch unter Windows\r\n\r\nDanke fuers Melden.',
  });
  assert.equal(ui.$('modal-update-notes-body').textContent, [
    'Behoben',
    '• Absturz beim Start',
    '  • auch unter Windows',
    '',
    'Danke fuers Melden.',
  ].join('\n'));
});
