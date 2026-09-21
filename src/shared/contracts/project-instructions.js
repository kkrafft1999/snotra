'use strict';

/**
 * Projektanweisungen aus `AGENTS.md` (Issue #212, nachgeschärft in #253).
 *
 * `AGENTS.md` trägt „so arbeitet man hier“ — Paketmanager, Testbefehle,
 * Konventionen, tabu-Ordner. Snotra liest die Datei aus drei Quellen und hängt
 * alle gefundenen an den Systemprompt:
 *
 * | # | Pfad                            | Geltung                     |
 * |---|---------------------------------|-----------------------------|
 * | 1 | `<workspace>/.agents/AGENTS.md` | Projekt                     |
 * | 2 | `~/.snotra/AGENTS.md`           | global, Standardort         |
 * | 3 | `~/.agents/AGENTS.md`           | global, kompatibler Alt-Ort |
 *
 * **Die Dateien ergänzen einander, sie überschreiben sich nicht.** Alle
 * gefundenen gelten gemeinsam; keine schlägt eine andere. Es gibt hier also
 * nichts zu entscheiden und deshalb auch keine Rangfolge — anders als bei den
 * Skills, wo zwei Verzeichnisse denselben Namen tragen können und der erste
 * Treffer gewinnt.
 *
 * Die Reihenfolge ist trotzdem **dieselbe Liste wie bei den Skills**
 * (Issue #251: Workspace, dann `~/.snotra`, dann `~/.agents`). Sie ist hier
 * reine Lesereihenfolge; gleich bleibt sie, damit man sich nicht zwei
 * Ordnungen merken muss.
 *
 * Im Projekt zählt allein `.agents/` — eine `AGENTS.md` in der Ordnerwurzel
 * liest Snotra bewusst **nicht** (Issue #253), auch wenn sie außerhalb dieses
 * Projekts die verbreitetere Form ist. Ebenso bewusst nur dieser eine
 * Dateiname: kein `CLAUDE.md`, kein `.cursorrules`. Verzeichnisse anderer
 * Werkzeuge liest Snotra nicht (Issue #103), und eine Datei mit drei erlaubten
 * Namen ist schwerer zu erklären als eine mit einem.
 *
 * CommonJS, damit Main (require) und Renderer (generiertes ESM-Bundle)
 * dieselben Werte benutzen.
 */

const PROJECT_INSTRUCTIONS_FILE = 'AGENTS.md';

const PROJECT_INSTRUCTION_SOURCES = Object.freeze({
  WORKSPACE_AGENTS: 'workspace-agents',
  USER_SNOTRA: 'user-snotra',
  USER_AGENTS: 'user-agents',
});

/** Lesereihenfolge, gleich der Quellenliste für Skills (#251). */
const PROJECT_INSTRUCTION_SOURCE_ORDER = Object.freeze([
  PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS,
  PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA,
  PROJECT_INSTRUCTION_SOURCES.USER_AGENTS,
]);

/**
 * Überschrift im Prompt und Zeile in der Kontext-Aufschlüsselung (#174).
 * `~/.snotra` ist der Standardort und heißt deshalb schlicht „global";
 * `~/.agents` wird weiter gelesen, trägt aber den Zusatz (#251).
 */
const PROJECT_INSTRUCTION_SOURCE_LABELS = Object.freeze({
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS]: 'AGENTS.md (Projekt)',
  [PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA]: 'AGENTS.md (global)',
  [PROJECT_INSTRUCTION_SOURCES.USER_AGENTS]: 'AGENTS.md (global, Alt-Ort)',
});

/**
 * Kurzform des Pfads für die Anzeige. Bewusst ohne aufgelöstes Home und ohne
 * Ordnernamen: Der absolute Pfad enthält den Benutzernamen, und diese Zeichen
 * gehen mit dem Prompt an den Anbieter (siehe `environmentInfoEnabled`, #138).
 */
const PROJECT_INSTRUCTION_SOURCE_PATHS = Object.freeze({
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS]: '<Ordner>/.agents/AGENTS.md',
  [PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA]: '~/.snotra/AGENTS.md',
  [PROJECT_INSTRUCTION_SOURCES.USER_AGENTS]: '~/.agents/AGENTS.md',
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
 * Mehrere Dateien normalisieren und in die Lesereihenfolge bringen. Doppelte
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
