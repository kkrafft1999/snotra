// Fenstergroesse beim Start: Standard (Issue #208) und gemerkter Zustand
// (Issue #209).
//
// Der teure Fehler hier ist ein Fenster, das ausserhalb jedes Bildschirms
// aufgeht — die App scheint dann gar nicht zu starten. Genau das laesst sich
// nur pruefen, wenn die Entscheidung ohne Electron laeuft, deshalb liegt sie
// als reine Funktion in src/main/window-state.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  fitToWorkArea,
  normalizeWindowState,
  resolveWindowBounds,
  createWindowStateStore,
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
} = require('../src/main/window-state.js');

const MACBOOK = { workArea: { x: 0, y: 25, width: 1440, height: 850 } };
const EXTERN = { workArea: { x: 1440, y: 0, width: 2560, height: 1415 } };

test('die Startgroesse liegt 20 % ueber den frueheren 1280 x 800', () => {
  assert.equal(DEFAULT_WINDOW_WIDTH, Math.round(1280 * 1.2));
  assert.equal(DEFAULT_WINDOW_HEIGHT, Math.round(800 * 1.2));
});

test('auf einem grossen Bildschirm bleibt es beim Wunschmass', () => {
  assert.deepEqual(fitToWorkArea({ width: 2560, height: 1440 }), {
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
  });
});

test('auf einem kleinen Bildschirm bleibt das Fenster in der Arbeitsflaeche', () => {
  // 13-Zoll-Notebook: 960 px waeren hoeher als der sichtbare Bereich.
  assert.deepEqual(fitToWorkArea({ width: 1440, height: 850 }), { width: 1440, height: 850 });
});

test('ohne brauchbare Bildschirmangabe gilt das Wunschmass', () => {
  const expected = { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT };
  assert.deepEqual(fitToWorkArea(null), expected);
  assert.deepEqual(fitToWorkArea({ width: 0, height: -1 }), expected);
  assert.deepEqual(fitToWorkArea({ width: 'breit', height: NaN }), expected);
});

test('ohne gespeicherten Zustand gilt die Startgroesse', () => {
  assert.deepEqual(
    resolveWindowBounds({ displays: [MACBOOK], primaryWorkArea: MACBOOK.workArea }),
    { width: 1440, height: 850, maximized: false, fullScreen: false }
  );
});

test('der zuletzt eingestellte Zustand kommt unveraendert zurueck', () => {
  const saved = { width: 1100, height: 720, x: 120, y: 90, maximized: false, fullScreen: false };
  assert.deepEqual(
    resolveWindowBounds({ saved, displays: [MACBOOK], primaryWorkArea: MACBOOK.workArea }),
    { width: 1100, height: 720, x: 120, y: 90, maximized: false, fullScreen: false }
  );
});

test('maximiert und Vollbild kommen als Kennzeichen zurueck, mit den Massen darunter', () => {
  const saved = { width: 1200, height: 800, x: 10, y: 40, maximized: true, fullScreen: false };
  const restored = resolveWindowBounds({
    saved, displays: [MACBOOK], primaryWorkArea: MACBOOK.workArea,
  });
  assert.equal(restored.maximized, true);
  assert.deepEqual([restored.width, restored.height], [1200, 800]);

  const full = resolveWindowBounds({
    saved: { ...saved, maximized: false, fullScreen: true },
    displays: [MACBOOK],
    primaryWorkArea: MACBOOK.workArea,
  });
  assert.equal(full.fullScreen, true);
});

test('ein Fenster vom zweiten Bildschirm behaelt dort seinen Platz', () => {
  const saved = { width: 1800, height: 1100, x: 1600, y: 200 };
  assert.deepEqual(
    resolveWindowBounds({ saved, displays: [MACBOOK, EXTERN], primaryWorkArea: MACBOOK.workArea }),
    { width: 1800, height: 1100, x: 1600, y: 200, maximized: false, fullScreen: false }
  );
});

test('ist der zweite Bildschirm weg, bleibt die Groesse und die Position faellt weg', () => {
  // Ohne das startet die App unsichtbar neben dem Notebook-Bildschirm.
  const saved = { width: 1300, height: 800, x: 2200, y: 300 };
  const restored = resolveWindowBounds({
    saved, displays: [MACBOOK], primaryWorkArea: MACBOOK.workArea,
  });
  assert.deepEqual(restored, { width: 1300, height: 800, maximized: false, fullScreen: false });
  assert.equal('x' in restored, false, 'ohne Position zentriert Electron selbst');
});

test('ein zu grosses oder ueberstehendes Fenster rastet in die Arbeitsflaeche ein', () => {
  // Am externen Bildschirm aufgezogen, jetzt am kleineren Notebook — ein
  // Zipfel ragt noch herein, also gilt der Bildschirm als der richtige.
  const saved = { width: 2000, height: 1200, x: 1300, y: 600 };
  const restored = resolveWindowBounds({
    saved, displays: [MACBOOK], primaryWorkArea: MACBOOK.workArea,
  });
  assert.deepEqual([restored.width, restored.height], [1440, 850]);
  assert.deepEqual([restored.x, restored.y], [0, 25], 'buendig in der Arbeitsflaeche');
});

test('ein Fenster, von dem fast nichts mehr sichtbar waere, wird zentriert', () => {
  // Nur 75 px ragen in den sichtbaren Bereich — zu wenig, um es mit der Maus
  // zu greifen. Dann lieber Groesse behalten und zentrieren.
  const restored = resolveWindowBounds({
    saved: { width: 2000, height: 1200, x: 1300, y: 800 },
    displays: [MACBOOK],
    primaryWorkArea: MACBOOK.workArea,
  });
  assert.equal('x' in restored, false);
  assert.deepEqual([restored.width, restored.height], [1440, 850]);
});

test('ein angeschnittener Zustand faellt auf den Standard zurueck', () => {
  const primaryWorkArea = MACBOOK.workArea;
  const fallback = { width: 1440, height: 850, maximized: false, fullScreen: false };
  for (const saved of [null, {}, 'kaputt', { width: 0, height: 700 }, { width: 900 }]) {
    assert.deepEqual(resolveWindowBounds({ saved, displays: [MACBOOK], primaryWorkArea }), fallback);
  }
  assert.equal(normalizeWindowState({ width: 900, height: 600 }).maximized, false);
  assert.equal('x' in normalizeWindowState({ width: 900, height: 600 }), false);
  // Eine halbe Position ist keine Position.
  assert.equal('x' in normalizeWindowState({ width: 900, height: 600, x: 10 }), false);
});

test('die Ablage schreibt und liest denselben Zustand', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snotra-window-'));
  const filePath = path.join(dir, 'unterordner', 'window-state.json');
  const store = createWindowStateStore({ filePath });

  assert.equal(store.read(), null, 'ohne Datei gibt es keinen Zustand');
  const state = { x: 10, y: 20, width: 1200, height: 800, maximized: false, fullScreen: false };
  store.write(state);
  assert.deepEqual(store.read(), state);

  // Eine kaputte Datei darf den Start nicht kippen.
  fs.writeFileSync(filePath, '{ halb ge', 'utf8');
  assert.equal(store.read(), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ein fehlgeschlagener Schreibversuch bleibt folgenlos', () => {
  const errors = [];
  const store = createWindowStateStore({
    filePath: '/gibt/es/nicht/window-state.json',
    fs: {
      mkdirSync() { throw new Error('read-only'); },
      writeFileSync() { throw new Error('read-only'); },
      renameSync() {},
      unlinkSync() {},
      readFileSync() { throw new Error('weg'); },
    },
    log: { error: (...args) => errors.push(args) },
  });
  store.write({ width: 100, height: 100 });
  assert.equal(errors.length, 1, 'der Fehlschlag wird gemeldet, nicht verschluckt');
  assert.equal(store.read(), null);
});
