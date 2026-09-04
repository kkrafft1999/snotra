/**
 * Diagnose für den Tool-Log (Issue #87): Ein Ring-Puffer merkt sich die letzten
 * Tool-Ereignisse, Phasenwechsel, Zustände der Einzeiler-Zeile und Fehler im
 * Renderer. Hintergrund: Im Feld blieb die Einzeiler-Zeile einmal leer, ohne
 * dass sich das nachstellen ließ. Ein einziger Fehler im Ereignis-Handler
 * würde alle weiteren Aktualisierungen der Zeile stoppen — deshalb laufen die
 * Handler über `guard`, das den Fehler festhält statt ihn durchzureichen.
 *
 * Bewusst ohne DOM, damit das Modul mit `node:test` prüfbar bleibt.
 */

const DEFAULT_CAPACITY = 200;
const LINE_PREVIEW_MAX = 120;

function truncate(text, max = LINE_PREVIEW_MAX) {
  const s = typeof text === 'string' ? text : '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Kompakte Form eines chat:tool-line-Payloads — ohne Argumente (Dateiinhalte). */
export function compactToolLinePayload(payload) {
  if (typeof payload === 'string') return { line: truncate(payload) };
  if (!payload || typeof payload !== 'object') return { raw: String(payload) };
  const out = {};
  if (payload.phase !== undefined) out.phase = payload.phase;
  if (payload.callIndex !== undefined) out.callIndex = payload.callIndex;
  if (typeof payload.tool === 'string') out.tool = payload.tool;
  if (typeof payload.skill === 'string') out.skill = payload.skill;
  out.line = truncate(typeof payload.line === 'string' ? payload.line : '');
  return out;
}

/**
 * @param {{ capacity?: number, now?: () => number, logger?: { error?: Function } }} [options]
 */
export function createToolLogDebug({ capacity = DEFAULT_CAPACITY, now = () => Date.now(), logger = console } = {}) {
  const entries = [];
  const lastByKind = new Map();
  let seq = 0;
  let errorCount = 0;

  function record(kind, data) {
    seq += 1;
    const entry = { seq, t: now(), kind, data };
    entries.push(entry);
    if (entries.length > capacity) entries.splice(0, entries.length - capacity);
    lastByKind.set(kind, safeKey(data));
    return entry;
  }

  /** Wie record, überspringt aber Wiederholungen desselben Zustands (z. B. Sekundentakt). */
  function recordIfChanged(kind, data) {
    const key = safeKey(data);
    if (lastByKind.get(kind) === key) return null;
    return record(kind, data);
  }

  /**
   * Führt `fn` aus; ein Fehler landet im Puffer und in der Konsole statt den
   * Ereignis-Handler abzubrechen. Gibt das Ergebnis von `fn` zurück, bei
   * Fehler `undefined`.
   */
  function guard(label, fn, context) {
    try {
      return fn();
    } catch (error) {
      errorCount += 1;
      record('error', {
        label,
        message: error?.message || String(error),
        stack: typeof error?.stack === 'string' ? truncate(error.stack, 1200) : '',
        context: context === undefined ? undefined : context,
      });
      if (logger && typeof logger.error === 'function') {
        logger.error(`[tool-log] Fehler in ${label}:`, error, context);
      }
      return undefined;
    }
  }

  function snapshot() {
    return entries.slice();
  }

  function serialize() {
    return JSON.stringify({ exportedAt: now(), errorCount, entries }, null, 2);
  }

  function clear() {
    entries.length = 0;
    lastByKind.clear();
    errorCount = 0;
  }

  return {
    record,
    recordIfChanged,
    guard,
    snapshot,
    serialize,
    clear,
    get errorCount() {
      return errorCount;
    },
    get size() {
      return entries.length;
    },
  };
}

function safeKey(data) {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
