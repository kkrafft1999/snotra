// DOM-Test-Stack fuer die Renderer-Komponenten (Issue #78).
//
// Bis hierher liefen Renderer-Tests ueber vier Umwege: DOM-freie Extraktion,
// handgeschnitzte Stubs im `vm`, Regex ueber Quelltext — oder gar nicht. Die
// Verdrahtung selbst (welcher Handler an welchem Element haengt, was ein Klick
// tatsaechlich am Baum aendert) war damit nicht pruefbar. happy-dom schliesst
// genau diese Luecke: `node --test` bleibt, die Laufzeit liegt im
// Millisekundenbereich, und die CI auf macOS/Windows/Linux braucht nichts
// weiter als die devDependency.
//
// Bewusste Grenzen des Stacks — wichtiger als seine Moeglichkeiten, weil eine
// gruene Zeile sonst mehr verspricht, als sie haelt:
//   * Kein echtes Chromium. Layout gibt es nicht — `offsetParent`,
//     `getBoundingClientRect()` und alles, was daran haengt, ist ohne Aussage.
//   * Das Markup kommt aus der echten `index.html`, die Skripte daraus werden
//     bewusst **nicht** ausgefuehrt (siehe loadRendererMarkup).
//   * DataTransfer/DragEvent baut dieser Helfer selbst nach, siehe unten.
//   * **Kein Sanitizing.** DOMPurify arbeitet unter happy-dom nachweislich
//     falsch: Das erste Element einer Eingabe wird immer entfernt
//     (`<p>a</p>` wird zu `a`), und nach einem entfernten Knoten bricht die
//     Traversierung ab, sodass gefaehrliche Attribute stehen bleiben
//     (`<p>a</p><img src=x onerror=y>` behaelt das onerror). Geprueft am
//     2026-09-14 mit happy-dom 20.14.5 und DOMPurify 3.4.14. Deshalb haengt
//     dieser Helfer `marked`/`DOMPurify` gar nicht erst als Globals ein:
//     markdownToSafeHtml() faellt dann auf reines Escapen zurueck, was
//     berechenbar ist. Das echte Sanitizing prueft `e2e/smoke.test.mjs` in der
//     laufenden App (`npm run test:e2e`).

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Window } = require('happy-dom');

const RENDERER_DIR = path.join(__dirname, '..', '..', 'src', 'renderer');

/** Importiert ein Renderer-Modul (natives ESM) aus einem CJS-Test heraus. */
function importRenderer(...segments) {
  return import(pathToFileURL(path.join(RENDERER_DIR, ...segments)).href);
}

/**
 * Das echte Markup laden, aber ohne die Skript-Tags: `app.js` wuerde die
 * gesamte App starten, und die UMD-Bundles im vendor-Ordner bleiben aussen vor
 * (siehe Grenzen oben). Ein Test gegen die echte index.html haelt Markup und
 * Code zusammen; faellt eine ID weg, faellt der Test und nicht erst die App.
 */
function loadRendererMarkup() {
  const html = fs.readFileSync(path.join(RENDERER_DIR, 'index.html'), 'utf8');
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

// Globale Namen, die die Renderer-Module ohne `window.`-Praefix benutzen.
const GLOBAL_KEYS = [
  'window', 'document', 'navigator', 'location', 'history', 'CSS',
  'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
  'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent',
  'InputEvent', 'ClipboardEvent', 'File', 'FileList', 'Blob', 'FormData',
  'DOMParser', 'NodeFilter', 'getComputedStyle', 'requestAnimationFrame',
  'cancelAnimationFrame', 'getSelection', 'MutationObserver', 'ResizeObserver',
];

/**
 * Baut ein Window mit dem echten Renderer-Markup auf und legt die ueblichen
 * Browser-Globals auf `globalThis`. node:test fuehrt Testdateien in eigenen
 * Prozessen aus, deshalb ist das Setzen globaler Namen hier unkritisch;
 * innerhalb einer Datei raeumt cleanup() wieder auf.
 *
 * @returns {{ window: object, document: object, cleanup: () => void }}
 */
function setupRendererDom({ markup = loadRendererMarkup() } = {}) {
  const window = new Window({ url: 'http://localhost/' });
  window.document.write(markup);

  const saved = new Map();
  for (const key of GLOBAL_KEYS) {
    if (!(key in window)) continue;
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = window[key];
    globalThis[key] = typeof value === 'function' && !/^[A-Z]/.test(key)
      ? value.bind(window)
      : value;
  }

  let closed = false;
  function cleanup() {
    if (closed) return;
    closed = true;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    window.close();
  }

  return { window, document: window.document, cleanup };
}

/**
 * Nachbau des DataTransfer aus der Drag-&-Drop-Spezifikation.
 *
 * happy-dom bringt zwar DataTransfer mit, meldet in `types` aber den MIME-Typ
 * der Datei statt des Eintrags `'Files'` — und genau daran entscheidet
 * `isExternalFileDrop()`, ob ein Drop von aussen kommt (#101). Der Nachbau ist
 * klein genug, um ihn statt dessen zu benutzen, und macht sichtbar, worauf der
 * Produktionscode sich verlaesst.
 */
function createDataTransfer({ files = [], data = {} } = {}) {
  const store = new Map(Object.entries(data));
  const transfer = {
    dropEffect: 'none',
    effectAllowed: 'all',
    files: [...files],
    get types() {
      const types = [...store.keys()];
      if (transfer.files.length > 0) types.push('Files');
      return types;
    },
    getData: (type) => store.get(type) ?? '',
    setData: (type, value) => { store.set(type, String(value)); },
    clearData: () => { store.clear(); },
  };
  return transfer;
}

/**
 * Drag-Event mit DataTransfer. happy-dom nimmt `dataTransfer` nicht aus dem
 * Init-Objekt entgegen und kennt `relatedTarget` an DragEvent nicht, deshalb
 * werden beide hier gesetzt.
 */
function dispatchDragEvent(target, type, { dataTransfer, relatedTarget = null } = {}) {
  const event = new target.ownerDocument.defaultView.Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer, configurable: true });
  Object.defineProperty(event, 'relatedTarget', { value: relatedTarget, configurable: true });
  target.dispatchEvent(event);
  return event;
}

/** Wartet, bis die Microtask-Queue leer ist (async Handler ohne Rueckgabewert). */
const flush = () => new Promise((resolve) => setImmediate(resolve));

module.exports = {
  RENDERER_DIR,
  importRenderer,
  loadRendererMarkup,
  setupRendererDom,
  createDataTransfer,
  dispatchDragEvent,
  flush,
};
