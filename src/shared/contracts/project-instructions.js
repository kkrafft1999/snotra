'use strict';

/**
 * Projektanweisungen aus `AGENTS.md` (Issue #212).
 *
 * `AGENTS.md` ist die werkzeugübergreifende Konvention für „so arbeitet man in
 * diesem Projekt“ — Paketmanager, Testbefehle, Konventionen, tabu-Ordner.
 * Snotra liest die Datei aus einer vierstufigen Kette und hängt alle
 * gefundenen Dateien an den Systemprompt, von allgemein nach speziell:
 *
 * | # | Pfad                            | Geltung                        |
 * |---|---------------------------------|--------------------------------|
 * | 1 | `~/.agents/AGENTS.md`           | global, werkzeugübergreifend   |
 * | 2 | `~/.snotra/AGENTS.md`           | global, nur Snotra             |
 * | 3 | `<workspace>/AGENTS.md`         | Projekt, werkzeugübergreifend  |
 * | 4 | `<workspace>/.agents/AGENTS.md` | Projekt, Agenten-Tooling       |
 *
 * Zweimal dieselbe Logik: **global vor Projekt** und **geteilt vor eigen**.
 * Das Spezifischere steht damit näher am Ende und gewinnt bei widersprüchlichen
 * Angaben, ohne dass Snotra die Dateien inhaltlich zusammenführen muss.
 *
 * Bewusst nur dieser eine Dateiname — kein `CLAUDE.md`, kein `.cursorrules`:
 * Verzeichnisse anderer Werkzeuge liest Snotra nicht (Issue #103), und eine
 * Datei mit drei erlaubten Namen ist schwerer zu erklären als eine mit einem.
 *
 * CommonJS, damit Main (require) und Renderer (generiertes ESM-Bundle)
 * dieselben Werte benutzen.
 */

const PROJECT_INSTRUCTIONS_FILE = 'AGENTS.md';

const PROJECT_INSTRUCTION_SOURCES = Object.freeze({
  USER_AGENTS: 'user-agents',
  USER_SNOTRA: 'user-snotra',
  WORKSPACE_ROOT: 'workspace-root',
  WORKSPACE_AGENTS: 'workspace-agents',
});

/** Reihenfolge im Prompt. Die Liste ist die Quelle der Wahrheit dafür. */
const PROJECT_INSTRUCTION_SOURCE_ORDER = Object.freeze([
  PROJECT_INSTRUCTION_SOURCES.USER_AGENTS,
  PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA,
  PROJECT_INSTRUCTION_SOURCES.WORKSPACE_ROOT,
  PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS,
]);

/** Überschrift im Prompt und Zeile in der Kontext-Aufschlüsselung (#174). */
const PROJECT_INSTRUCTION_SOURCE_LABELS = Object.freeze({
  [PROJECT_INSTRUCTION_SOURCES.USER_AGENTS]: 'AGENTS.md (global)',
  [PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA]: 'AGENTS.md (global, .snotra)',
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_ROOT]: 'AGENTS.md (Projekt)',
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS]: 'AGENTS.md (Projekt, .agents)',
});

/**
 * Kurzform des Pfads für die Anzeige. Bewusst ohne aufgelöstes Home und ohne
 * Ordnernamen: Der absolute Pfad enthält den Benutzernamen, und diese Zeichen
 * gehen mit dem Prompt an den Anbieter (siehe `environmentInfoEnabled`, #138).
 */
const PROJECT_INSTRUCTION_SOURCE_PATHS = Object.freeze({
  [PROJECT_INSTRUCTION_SOURCES.USER_AGENTS]: '~/.agents/AGENTS.md',
  [PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA]: '~/.snotra/AGENTS.md',
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_ROOT]: '<Ordner>/AGENTS.md',
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS]: '<Ordner>/.agents/AGENTS.md',
});

/**
 * Grenze je Datei, gleich der für Skill-Bodies (`MAX_SKILL_BODY_CHARS`).
 * Übergroßes wird gekürzt statt verworfen — der Anfang einer Anweisungsdatei
 * ist meist der wichtige Teil, und ein stilles „gar nichts“ wäre schlechter
 * erklärbar als ein sichtbar abgeschnittener Text.
 */
const MAX_PROJECT_INSTRUCTION_CHARS = 20000;

function isProjectInstructionSource(value) {
  return PROJECT_INSTRUCTION_SOURCE_ORDER.includes(value);
}

/**
 * Eine gelesene Datei in die Form bringen, mit der Prompt und Anzeige rechnen.
 * Leeres, Unbekanntes und Kaputtes fällt hier weg — der Prompt bekommt sonst
 * eine Überschrift ohne Text darunter.
 *
 * @returns {{source: string, text: string, truncated: boolean}|null}
 */
function normalizeProjectInstructionFile(raw) {
  const data = raw && typeof raw === 'object' ? raw : null;
  if (!data) return null;
  if (!isProjectInstructionSource(data.source)) return null;
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) return null;
  return { source: data.source, text, truncated: data.truncated === true };
}

/**
 * Mehrere Dateien normalisieren und in die Kettenreihenfolge bringen. Doppelte
 * Quellen kommen nicht vor — der Adapter liest jede Stufe einmal —, ein
 * zweiter Eintrag derselben Quelle wird deshalb verworfen statt verdoppelt.
 */
function normalizeProjectInstructionFiles(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const bySource = new Map();
  for (const entry of list) {
    const file = normalizeProjectInstructionFile(entry);
    if (file && !bySource.has(file.source)) bySource.set(file.source, file);
  }
  return PROJECT_INSTRUCTION_SOURCE_ORDER.map((source) => bySource.get(source)).filter(Boolean);
}

module.exports = {
  PROJECT_INSTRUCTIONS_FILE,
  PROJECT_INSTRUCTION_SOURCES,
  PROJECT_INSTRUCTION_SOURCE_ORDER,
  PROJECT_INSTRUCTION_SOURCE_LABELS,
  PROJECT_INSTRUCTION_SOURCE_PATHS,
  MAX_PROJECT_INSTRUCTION_CHARS,
  isProjectInstructionSource,
  normalizeProjectInstructionFile,
  normalizeProjectInstructionFiles,
};
