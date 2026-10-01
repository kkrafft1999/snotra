/**
 * Enums der Contract-Schicht (Roadmap-Etappe 1).
 *
 * Diese Werte sind der gemeinsame Wortschatz zwischen Main und Renderer für
 * Chat, Streaming und Tools. Sie MÜSSEN mit den bisher an der IPC-Grenze
 * verwendeten String-Literalen übereinstimmen — beim Ändern eines Werts hier
 * ändert sich das Wire-Format.
 *
 * There is no version number to raise with it (#509): main and renderer
 * always ship together, so there is nothing to negotiate. What is stored on
 * disk carries its own file version where a migration needs one.
 *
 * CommonJS, damit Main (require) und die node:test-Suite die Datei direkt
 * nutzen können. Der Renderer erhält dieselben Werte über das aus dieser
 * Schicht generierte ESM-Bundle (siehe scripts/sync-renderer-vendor.js).
 */
'use strict';

// Fehlercodes eines Chat-Ergebnisses (result.code).
const CHAT_ERROR_CODES = Object.freeze({
  INVALID: 'INVALID',
  NO_API_KEY: 'NO_API_KEY',
  NO_BASE_URL: 'NO_BASE_URL',
  API: 'API',
  NETWORK: 'NETWORK',
  TOOL_LIMIT: 'TOOL_LIMIT',
  /** Lauf endete durch verfallene Freigabe (Issue #66): kein weiterer Provider-Request. */
  PERMISSION: 'PERMISSION',
  /** The app's own error — a tool, a port or the engine threw, not the provider (#527). */
  INTERNAL: 'INTERNAL',
  /** The provider's round was cut off — output limit, content filter or a dropped stream (#538). */
  INCOMPLETE: 'INCOMPLETE',
});

// Phasen der laufenden Antwort (chat:progress, type='phase').
const CHAT_PHASES = Object.freeze({
  IDLE: 'idle',
  WAITING: 'waiting',
  GENERATING: 'generating',
});

// Zustand einer Tool-Zeile (chat:tool-line, phase).
const TOOL_LINE_PHASES = Object.freeze({
  /** Das Modell streamt den Aufruf noch (Argumente ggf. unvollständig); Tool noch nicht ausgeführt. */
  PENDING: 'pending',
  START: 'start',
  DONE: 'done',
});

// Typ eines Fortschritts-Events (chat:progress, type).
const CHAT_PROGRESS_TYPES = Object.freeze({
  PHASE: 'phase',
  REASONING: 'reasoning',
  /** Semantisches Anwendungs-/Workspace-Ereignis (z. B. Datei geschrieben). */
  WORKSPACE: 'workspace',
  /** Berechtigungsereignis (Issue #66): Freigabe ausstehend, entschieden, Inhalt redigiert. */
  PERMISSION: 'permission',
});

/** Untertyp eines chat:progress-Events mit type='permission'. */
const PERMISSION_PROGRESS_EVENTS = Object.freeze({
  /** Eine Freigabe-Karte wartet auf den Nutzer. */
  AWAITING: 'awaiting',
  /** Die Anfrage wurde beantwortet oder ist verfallen. */
  RESOLVED: 'resolved',
  /** Sensibler Tool-Inhalt wurde vor dem Provider-Request zurückgehalten. */
  REDACTED: 'redacted',
});

/** Untertyp eines chat:progress-Events mit type='workspace'. */
const WORKSPACE_PROGRESS_EVENTS = Object.freeze({
  FILE_WRITTEN: 'fileWritten',
});

// App-Sprache (ui-preferences.json, Einstellungen).
const APP_LOCALES = Object.freeze({
  DE: 'de',
  EN: 'en',
});

/**
 * Woher die Skill-Vorschläge kommen (Issue #125).
 *
 * `LEXICAL` rechnet im Renderer und kostet nichts; `MODEL` fragt das Modell
 * und versteht dafür auch Fachkürzel, die in keiner Beschreibung stehen. In
 * beiden Fällen bleibt das Übernehmen eine Nutzeraktion — vorgeschlagen wird,
 * nie eingeschaltet (Prompt-Injection, siehe #18).
 */
const SKILL_SUGGESTION_MODES = Object.freeze({
  OFF: 'off',
  LEXICAL: 'lexical',
  MODEL: 'model',
});

const DEFAULT_SKILL_SUGGESTION_MODE = SKILL_SUGGESTION_MODES.LEXICAL;

function isSkillSuggestionMode(value) {
  return Object.values(SKILL_SUGGESTION_MODES).includes(value);
}

// CSS-Klasse für Preset-Sublabels in der UI.
const PRESET_DETAIL_STYLES = Object.freeze({
  DEFAULT: 'default',
  MONO: 'mono',
});

// Typ eines dynamischen Preset-Felds im Add-Model-Dialog.
const PRESET_FIELD_TYPES = Object.freeze({
  SELECT: 'select',
});

// How a select field is drawn (#414). The value stays one of its options
// either way: a dropdown by default, a segmented control for a few short
// choices, a switch for exactly two — the first option is off, the second on.
const PRESET_FIELD_CONTROLS = Object.freeze({
  DROPDOWN: 'dropdown',
  SEGMENTED: 'segmented',
  SWITCH: 'switch',
});

module.exports = {
  CHAT_ERROR_CODES,
  CHAT_PHASES,
  TOOL_LINE_PHASES,
  CHAT_PROGRESS_TYPES,
  WORKSPACE_PROGRESS_EVENTS,
  PERMISSION_PROGRESS_EVENTS,
  APP_LOCALES,
  SKILL_SUGGESTION_MODES,
  DEFAULT_SKILL_SUGGESTION_MODE,
  isSkillSuggestionMode,
  PRESET_DETAIL_STYLES,
  PRESET_FIELD_TYPES,
  PRESET_FIELD_CONTROLS,
};
