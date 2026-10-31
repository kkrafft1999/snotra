'use strict';

/**
 * Projektanweisungen aus `AGENTS.md` (Issue #212, nachgeschärft in #253 und #432).
 *
 * `AGENTS.md` trägt „so arbeitet man hier“ — Paketmanager, Testbefehle,
 * Konventionen, tabu-Ordner. Snotra liest die Datei aus drei Quellen und hängt
 * alle gefundenen an den Systemprompt:
 *
 * | # | Pfad                    | Geltung                     |
 * |---|-------------------------|-----------------------------|
 * | 1 | `<workspace>/AGENTS.md` | Projekt                     |
 * | 2 | `~/.snotra/AGENTS.md`   | global, Standardort         |
 * | 3 | `~/.agents/AGENTS.md`   | global, kompatibler Alt-Ort |
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
 * In the project only the root-level file counts, where most repositories keep
 * it (#432, reversing the `.agents/`-only rule of #253); `.agents/AGENTS.md`
 * is not read. Just as deliberately only this one file name: no `CLAUDE.md`,
 * no `.cursorrules`. Snotra does not read other tools' directories (#103), and
 * a file with three allowed names is harder to explain than one with one.
 *
 * CommonJS, damit Main (require) und Renderer (generiertes ESM-Bundle)
 * dieselben Werte benutzen.
 */

const { isRecord } = require('../runtime/is-record');

/** @typedef {typeof PROJECT_INSTRUCTION_SOURCES[keyof typeof PROJECT_INSTRUCTION_SOURCES]} ProjectInstructionSource */

/**
 * @typedef {Object} NormalizedProjectInstructionFile
 * @property {ProjectInstructionSource} source
 * @property {string} text
 * @property {boolean} truncated
 * @property {'masked'|'withheld'} [guard]  what the secret protection did to it (#528)
 * @property {Array<{kind: string, excerpt: string}>} [covertSignals]  what the covert-signal check found (#1280)
 */

const PROJECT_INSTRUCTIONS_FILE = 'AGENTS.md';

const PROJECT_INSTRUCTION_SOURCES = Object.freeze({
  WORKSPACE_AGENTS: 'workspace-agents',
  USER_SNOTRA: 'user-snotra',
  USER_AGENTS: 'user-agents',
});

/**
 * Lesereihenfolge, gleich der Quellenliste für Skills (#251).
 *
 * @type {readonly ProjectInstructionSource[]}
 */
const PROJECT_INSTRUCTION_SOURCE_ORDER = Object.freeze([
  PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS,
  PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA,
  PROJECT_INSTRUCTION_SOURCES.USER_AGENTS,
]);

/**
 * Überschrift im Prompt und Zeile in der Kontext-Aufschlüsselung (#174).
 * `~/.snotra` ist der Standardort und heißt deshalb schlicht „global";
 * `~/.agents` wird weiter gelesen, trägt aber den Zusatz (#251).
 *
 * @type {Readonly<Record<string, string>>}
 */
const PROJECT_INSTRUCTION_SOURCE_LABEL_KEYS = Object.freeze({
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS]: 'context.part.agents.workspace',
  [PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA]: 'context.part.agents.user',
  [PROJECT_INSTRUCTION_SOURCES.USER_AGENTS]: 'context.part.agents.userLegacy',
});

/**
 * Dieselben Quellen als Zwischenueberschrift **im System-Prompt** — englisch,
 * weil sie dort beim Modell landen (Issue #276). Die Tabelle darueber bleibt
 * die der Oberflaeche: sie beschriftet die Kontext-Aufschluesselung.
 *
 * @type {Readonly<Record<string, string>>}
 */
const PROJECT_INSTRUCTION_SOURCE_PROMPT_LABELS = Object.freeze({
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS]: 'AGENTS.md (project)',
  [PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA]: 'AGENTS.md (global)',
  [PROJECT_INSTRUCTION_SOURCES.USER_AGENTS]: 'AGENTS.md (global, legacy location)',
});

/**
 * Kurzform des Pfads für die Anzeige. Bewusst ohne aufgelöstes Home und ohne
 * Ordnernamen: Der absolute Pfad enthält den Benutzernamen, und diese Zeichen
 * gehen mit dem Prompt an den Anbieter (siehe `environmentInfoEnabled`, #138).
 *
 * @type {Readonly<Record<string, string>>}
 */
const PROJECT_INSTRUCTION_SOURCE_PATHS = Object.freeze({
  // Relative to the open folder; `<folder>/` comes from the catalogue (#353).
  [PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS]: 'AGENTS.md',
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

/**
 * @param {unknown} value
 * @returns {value is ProjectInstructionSource}
 */
function isProjectInstructionSource(value) {
  return PROJECT_INSTRUCTION_SOURCE_ORDER.some((source) => source === value);
}

/**
 * Eine gelesene Datei in die Form bringen, mit der Prompt und Anzeige rechnen.
 * Leeres, Unbekanntes und Kaputtes fällt hier weg — der Prompt bekommt sonst
 * eine Überschrift ohne Text darunter.
 *
 * @param {unknown} raw
 * @returns {NormalizedProjectInstructionFile|null}
 */
function normalizeProjectInstructionFile(raw) {
  if (!isRecord(raw)) return null;
  const data = raw;
  if (!isProjectInstructionSource(data.source)) return null;
  const text = typeof data.text === 'string' ? data.text.trim() : '';
  if (!text) return null;
  /** @type {NormalizedProjectInstructionFile} */
  const file = { source: data.source, text, truncated: data.truncated === true };
  // What the secret protection did to it (#528), for the context breakdown.
  if (data.guard === 'masked' || data.guard === 'withheld') file.guard = data.guard;
  // What the covert-signal check found in it (#1280), for the same.
  if (Array.isArray(data.covertSignals) && data.covertSignals.length > 0) file.covertSignals = data.covertSignals;
  return file;
}

/**
 * Mehrere Dateien normalisieren und in die Lesereihenfolge bringen. Doppelte
 * Quellen kommen nicht vor — der Adapter liest jede Stufe einmal —, ein
 * zweiter Eintrag derselben Quelle wird deshalb verworfen statt verdoppelt.
 *
 * @param {unknown} raw
 * @returns {NormalizedProjectInstructionFile[]}
 */
function normalizeProjectInstructionFiles(raw) {
  const list = Array.isArray(raw) ? raw : [];
  /** @type {Map<string, NormalizedProjectInstructionFile>} */
  const bySource = new Map();
  for (const entry of list) {
    const file = normalizeProjectInstructionFile(entry);
    if (file && !bySource.has(file.source)) bySource.set(file.source, file);
  }
  /** @type {NormalizedProjectInstructionFile[]} */
  const ordered = [];
  for (const source of PROJECT_INSTRUCTION_SOURCE_ORDER) {
    const file = bySource.get(source);
    if (file) ordered.push(file);
  }
  return ordered;
}

module.exports = {
  PROJECT_INSTRUCTIONS_FILE,
  PROJECT_INSTRUCTION_SOURCES,
  PROJECT_INSTRUCTION_SOURCE_ORDER,
  PROJECT_INSTRUCTION_SOURCE_LABEL_KEYS,
  PROJECT_INSTRUCTION_SOURCE_PROMPT_LABELS,
  PROJECT_INSTRUCTION_SOURCE_PATHS,
  MAX_PROJECT_INSTRUCTION_CHARS,
  isProjectInstructionSource,
  normalizeProjectInstructionFile,
  normalizeProjectInstructionFiles,
};
