/**
 * Versionierte Enums der Contract-Schicht (Roadmap-Etappe 1).
 *
 * Diese Werte sind der gemeinsame Wortschatz zwischen Main und Renderer für
 * Chat, Streaming und Tools. Sie MÜSSEN mit den bisher an der IPC-Grenze
 * verwendeten String-Literalen übereinstimmen — beim Ändern eines Werts hier
 * ändert sich das Wire-Format, daher CONTRACT_VERSION mitziehen.
 *
 * CommonJS, damit Main (require) und die node:test-Suite die Datei direkt
 * nutzen können. Der Renderer erhält dieselben Werte über das aus dieser
 * Schicht generierte ESM-Bundle (siehe scripts/sync-renderer-vendor.js).
 */
'use strict';

// Erhöhen, sobald sich Form oder Bedeutung eines Contracts unverträglich ändert.
const CONTRACT_VERSION = 1;

// Fehlercodes eines Chat-Ergebnisses (result.code).
const CHAT_ERROR_CODES = Object.freeze({
  INVALID: 'INVALID',
  NO_API_KEY: 'NO_API_KEY',
  NO_BASE_URL: 'NO_BASE_URL',
  API: 'API',
  NETWORK: 'NETWORK',
  TOOL_LIMIT: 'TOOL_LIMIT',
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
  /** Welche Skills für diese Antwort aktiv sind (Issue #60). */
  SKILLS: 'skills',
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

// CSS-Klasse für Preset-Sublabels in der UI.
const PRESET_DETAIL_STYLES = Object.freeze({
  DEFAULT: 'default',
  MONO: 'mono',
});

// Typ eines dynamischen Preset-Felds im Add-Model-Dialog.
const PRESET_FIELD_TYPES = Object.freeze({
  SELECT: 'select',
});

module.exports = {
  CONTRACT_VERSION,
  CHAT_ERROR_CODES,
  CHAT_PHASES,
  TOOL_LINE_PHASES,
  CHAT_PROGRESS_TYPES,
  WORKSPACE_PROGRESS_EVENTS,
  APP_LOCALES,
  PRESET_DETAIL_STYLES,
  PRESET_FIELD_TYPES,
};
