// Fensterzustand ueber den Neustart (Issue #209).
//
// Groesse, Position, maximiert und Vollbild landen als kleine JSON-Datei im
// userData-Ordner. Bewusst neben der Ablage aus storage-service: der Zustand
// gehoert dem Fenster allein, niemand sonst liest ihn, und er muss beim Start
// da sein, bevor irgendein Service steht.
//
// Die Entscheidung daraus ist heikler, als sie aussieht — zwischen zwei Starts
// koennen Bildschirme dazukommen, wegfallen oder ihre Aufloesung aendern. Ein
// roh uebernommener Zustand landet dann ausserhalb jedes sichtbaren Bereichs,
// und die App scheint nicht zu starten. Deshalb liegt die Pruefung als reine
// Funktion hier und nicht im Electron-Code.

const fsSync = require('fs');
const path = require('path');

// Erster Start ohne gespeicherten Zustand (Issue #208): 20 % mehr als die
// frueheren 1280 x 800. Drei Spalten brauchen Platz — kleiner faengt jedes
// frische Profil damit an, dass man das Fenster erst einmal aufzieht.
const DEFAULT_WINDOW_WIDTH = 1536;
const DEFAULT_WINDOW_HEIGHT = 960;

/**
 * So viel vom Fenster muss auf einem Bildschirm liegen, damit die gespeicherte
 * Position noch als brauchbar gilt. Ein Streifen von 100 px reicht, um das
 * Fenster mit der Maus wieder einzufangen.
 */
const MIN_VISIBLE_PX = 100;

const isPositive = (value) => Number.isFinite(value) && value > 0;

/**
 * Die Groesse darf nicht ueber die Arbeitsflaeche hinauswachsen: auf einem
 * 13-Zoll-Notebook ist der sichtbare Bereich keine 960 px hoch, und ein
 * Fenster, dessen Fuss unter der Bildschirmkante liegt, verdeckt die
 * Chat-Eingabe.
 */
function fitToWorkArea(
  workArea,
  { width = DEFAULT_WINDOW_WIDTH, height = DEFAULT_WINDOW_HEIGHT } = {}
) {
  const limit = (value) => (isPositive(value) ? value : Infinity);
  return {
    width: Math.round(Math.min(isPositive(width) ? width : DEFAULT_WINDOW_WIDTH, limit(workArea?.width))),
    height: Math.round(Math.min(isPositive(height) ? height : DEFAULT_WINDOW_HEIGHT, limit(workArea?.height))),
  };
}

/**
 * Aus der Datei wird nur uebernommen, was Hand und Fuss hat. Eine halb
 * geschriebene oder von Hand verbogene Datei darf den Start nicht kippen.
 */
function normalizeWindowState(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const size = {
    width: isPositive(raw.width) ? Math.round(raw.width) : null,
    height: isPositive(raw.height) ? Math.round(raw.height) : null,
  };
  if (!size.width || !size.height) return null;
  const hasPosition = Number.isFinite(raw.x) && Number.isFinite(raw.y);
  return {
    ...size,
    ...(hasPosition ? { x: Math.round(raw.x), y: Math.round(raw.y) } : {}),
    maximized: raw.maximized === true,
    fullScreen: raw.fullScreen === true,
  };
}

const clamp = (value, min, max) => Math.round(Math.min(Math.max(value, min), Math.max(min, max)));

/** Liegt genug vom Fenster auf dieser Arbeitsflaeche, um es noch zu treffen? */
function overlapsEnough(rect, workArea) {
  if (!workArea) return false;
  const overlapX = Math.min(rect.x + rect.width, workArea.x + workArea.width) - Math.max(rect.x, workArea.x);
  const overlapY = Math.min(rect.y + rect.height, workArea.y + workArea.height) - Math.max(rect.y, workArea.y);
  return overlapX >= Math.min(MIN_VISIBLE_PX, rect.width)
    && overlapY >= Math.min(MIN_VISIBLE_PX, rect.height);
}

/**
 * Welche Bildschirmgrenzen gelten fuer den gespeicherten Zustand? Der
 * Bildschirm, auf dem das Fenster zuletzt lag — und wenn es den nicht mehr
 * gibt, keiner.
 */
function displayWorkAreaFor(state, displays) {
  if (!Array.isArray(displays)) return null;
  const rect = { x: state.x, y: state.y, width: state.width, height: state.height };
  for (const display of displays) {
    if (overlapsEnough(rect, display?.workArea)) return display.workArea;
  }
  return null;
}

/**
 * Der Fensterzustand fuer den naechsten Start.
 *
 * @param {object}   options
 * @param {object?}  options.saved           Inhalt der gespeicherten Datei (roh).
 * @param {object[]} options.displays        `screen.getAllDisplays()`.
 * @param {object?}  options.primaryWorkArea Arbeitsflaeche des Hauptbildschirms.
 * @returns {{ width: number, height: number, x?: number, y?: number,
 *             maximized: boolean, fullScreen: boolean }}
 *          Ohne `x`/`y` zentriert Electron das Fenster selbst.
 */
function resolveWindowBounds({ saved = null, displays = [], primaryWorkArea = null } = {}) {
  const state = normalizeWindowState(saved);
  if (!state) {
    return { ...fitToWorkArea(primaryWorkArea), maximized: false, fullScreen: false };
  }

  const hasPosition = Number.isFinite(state.x) && Number.isFinite(state.y);
  const workArea = (hasPosition ? displayWorkAreaFor(state, displays) : null) || primaryWorkArea;
  const size = fitToWorkArea(workArea, { width: state.width, height: state.height });
  const flags = { maximized: state.maximized, fullScreen: state.fullScreen };

  // Kein Bildschirm mehr unter dem Fenster (Monitor abgezogen, Aufloesung
  // geaendert): die Groesse bleibt, die Position faellt weg — sonst startet die
  // App irgendwo im Nichts.
  if (!hasPosition || !displayWorkAreaFor(state, displays)) {
    return { ...size, ...flags };
  }

  return {
    ...size,
    x: clamp(state.x, workArea.x, workArea.x + workArea.width - size.width),
    y: clamp(state.y, workArea.y, workArea.y + workArea.height - size.height),
    ...flags,
  };
}

/**
 * Die Ablage selbst. `fs` ist injizierbar, damit der Test ohne echtes
 * Dateisystem auskommt; geschrieben wird synchron, weil der letzte Stand beim
 * Schliessen des Fensters faellig ist und der Prozess danach nicht mehr wartet.
 */
function createWindowStateStore({ filePath, fs = fsSync, log = console } = {}) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        // Fehlt die Datei oder ist sie unlesbar, gilt der Standard.
        return null;
      }
    },
    write(state) {
      const tmp = `${filePath}.tmp`;
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // Erst daneben schreiben, dann umbenennen: ein Absturz mitten im
        // Schreiben laesst sonst eine halbe Datei zurueck.
        fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
        fs.renameSync(tmp, filePath);
      } catch (err) {
        log.error?.('Fensterzustand konnte nicht gesichert werden:', err);
        try { fs.unlinkSync(tmp); } catch { /* dann eben nicht */ }
      }
    },
  };
}

module.exports = {
  DEFAULT_WINDOW_WIDTH,
  DEFAULT_WINDOW_HEIGHT,
  MIN_VISIBLE_PX,
  fitToWorkArea,
  normalizeWindowState,
  resolveWindowBounds,
  createWindowStateStore,
};
