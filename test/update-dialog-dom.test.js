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
  assert.equal(ui.title(), 'Version 1.8.0 ist verfügbar');
  assert.match(ui.summary(), /Du hast Version 1\.7\.1/);
  // Die Groesse steht im Text — der Nutzer entscheidet mit Kenntnis darueber,
  // was der Klick kostet, ohne dass die Knopfzeile umbricht.
  assert.match(ui.summary(), /die neue Version \(92,0 MB\) herunter/);
  assert.deepEqual(ui.labels(), ['Herunterladen', 'Überspringen', 'Später']);
  assert.deepEqual(ui.calls, [], 'ohne Klick wird nichts geladen');
  assert.match(ui.dom.document.getElementById('modal-update-notes-body').textContent, /Selbst-Update/);
});

test('eine Vorab-Version wird als solche benannt', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);
  await ui.push({ ...AVAILABLE, isPrerelease: true });
  assert.equal(ui.title(), 'Version 1.8.0 ist verfügbar (Vorab-Version)');
});

test('„Später" schliesst nur, „Überspringen" merkt sich die Version', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Später');
  assert.equal(ui.isOpen(), false);
  assert.deepEqual(ui.calls, []);

  await ui.push({ ...AVAILABLE });
  await ui.click('Überspringen');
  assert.equal(ui.isOpen(), false);
  assert.deepEqual(ui.calls, ['ignore:1.8.0']);
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
  await ui.click('Herunterladen');

  // Waehrend des Downloads: Fortschritt sichtbar, nur noch „Abbrechen", und
  // der Dialog laesst sich nicht wegklicken.
  assert.equal(ui.title(), 'Version 1.8.0 wird geladen');
  assert.deepEqual(ui.labels(), ['Abbrechen']);
  assert.equal(ui.$('modal-update-progress').classList.contains('hidden'), false);
  assert.equal(ui.$('modal-update-close').disabled, true);
  ui.$('modal-update-backdrop').click();
  await flush();
  assert.equal(ui.isOpen(), true, 'ein Klick daneben darf den Download nicht wegwerfen');

  await ui.progress({ receivedBytes: 46 * 1024 * 1024, totalBytes: 92 * 1024 * 1024 });
  assert.equal(ui.$('modal-update-track').getAttribute('aria-valuenow'), '50');
  assert.match(ui.$('modal-update-progress-text').textContent, /^50 % – 46,0 MB von 92,0 MB$/);
  assert.equal(ui.$('modal-update-bar').style.width, '50%');

  resolveDownload({ ok: true });
  await flush();

  // Geladen heisst noch nicht installiert — es wird erneut gefragt.
  assert.equal(ui.title(), 'Version 1.8.0 ist bereit');
  assert.deepEqual(ui.labels(), ['Installieren und neu starten', 'Abbrechen']);
  assert.deepEqual(calls, ['download'], 'noch nichts installiert');

  await ui.click('Installieren und neu starten');
  assert.deepEqual(calls, ['download', 'install']);
  assert.equal(ui.title(), 'Version 1.8.0 wird installiert');
  assert.match(ui.summary(), /lässt sich nicht mehr abbrechen/);
  assert.deepEqual(ui.labels(), [], 'ab hier gibt es keinen wirkungslosen Knopf');
});

test('Abbrechen im Download fuehrt zurueck auf „verfuegbar"', async (t) => {
  let resolveDownload;
  const ui = await mount({
    api: { downloadUpdate: () => new Promise((resolve) => { resolveDownload = resolve; }) },
  });
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Herunterladen');
  await ui.click('Abbrechen');
  assert.deepEqual(ui.calls, ['cancel']);

  resolveDownload({ ok: false, canceled: true });
  await flush();

  assert.equal(ui.title(), 'Version 1.8.0 ist verfügbar');
  assert.ok(ui.labels()[0].startsWith('Herunterladen'), 'der Weg steht wieder offen');
  assert.equal(ui.$('modal-update-close').disabled, false);
});

test('Abbrechen nach dem Laden verwirft die Datei und schliesst', async (t) => {
  const ui = await mount();
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Herunterladen');
  assert.equal(ui.title(), 'Version 1.8.0 ist bereit');

  await ui.click('Abbrechen');
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
  await ui.click('Herunterladen');
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
  await ui.click('Herunterladen');

  assert.equal(ui.title(), 'Die Aktualisierung hat nicht geklappt');
  assert.equal(ui.summary(), 'Netzwerk weg.');
  assert.equal(ui.$('modal-update-notes').classList.contains('hidden'), true,
    'im Fehlerfall lenkt die Änderungsliste nur ab');
  assert.match(ui.hint().textContent, /laufende Version ist unverändert/);
  assert.equal(ui.hint().classList.contains('hidden'), false);
  assert.deepEqual(ui.labels(), ['Erneut versuchen', 'Release-Seite öffnen', 'Schließen']);

  await ui.click('Release-Seite öffnen');
  assert.ok(ui.calls.includes('open:https://example.test/releases/v1.8.0'));
});

test('eine gescheiterte Installation meldet sich, statt stumm haengenzubleiben', async (t) => {
  const ui = await mount({
    api: { installUpdate: async () => ({ ok: false, error: 'Keine Schreibrechte für /Applications.' }) },
  });
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE });
  await ui.click('Herunterladen');
  await ui.click('Installieren und neu starten');

  assert.equal(ui.title(), 'Die Aktualisierung hat nicht geklappt');
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
  assert.deepEqual(ui.labels(), ['Release-Seite öffnen', 'Überspringen', 'Später']);

  await ui.click('Release-Seite öffnen');
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
  assert.equal(ui.title(), 'Keine neue Version');
  assert.match(ui.summary(), /bereits die neueste Version \(1\.8\.0\)/);
  assert.deepEqual(ui.labels(), ['Schließen']);
});

test('eine fehlgeschlagene Pruefung wird als solche benannt', async (t) => {
  const ui = await mount({
    api: { checkForUpdate: async () => ({ updateAvailable: false, currentVersion: '1.7.1', error: 'Server nicht erreichbar.' }) },
  });
  t.after(ui.dom.cleanup);

  await ui.dialog.checkNow();
  await flush();
  assert.match(ui.summary(), /Prüfung ist fehlgeschlagen: Server nicht erreichbar\./);
});

test('ohne bekannte Gesamtgroesse laeuft ein unbestimmter Balken statt einer erfundenen Zahl', async (t) => {
  let resolveDownload;
  const ui = await mount({
    api: { downloadUpdate: () => new Promise((resolve) => { resolveDownload = resolve; }) },
  });
  t.after(ui.dom.cleanup);

  await ui.push({ ...AVAILABLE, asset: null, canSelfUpdate: true });
  await ui.click('Herunterladen');
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
