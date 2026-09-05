/**
 * Chat-DTO- und Event-Contract (Roadmap-Etappe 1).
 *
 * Factories für die Ergebnis-Objekte von CHAT_SEND und für die Push-Events
 * (chat:delta, chat:tool-line, chat:progress). Sie erzeugen exakt die Formen,
 * die vom Chat-Core erzeugt und vom IPC-Adapter an den Renderer weitergeleitet
 * werden — so bleibt das Wire-Format stabil, während Erzeugung und Validierung
 * zentral liegen.
 */
'use strict';

const {
  CHAT_ERROR_CODES,
  CHAT_PHASES,
  TOOL_LINE_PHASES,
  CHAT_PROGRESS_TYPES,
  WORKSPACE_PROGRESS_EVENTS,
} = require('./enums');

// --- Ergebnis-DTOs (Rückgabe von CHAT_SEND) --------------------------------

/*
 * Zwei Usage-Felder mit unterschiedlicher Bedeutung:
 *   usage         Summe ueber alle LLM-Runden dieses Zugs (Verbrauch).
 *   contextUsage  Usage der letzten LLM-Runde. Deren `prompt` ist die Groesse
 *                 des Kontextfensters, das zuletzt tatsaechlich an das Modell
 *                 ging — das zeigt der Token-Zaehler im Composer.
 * contextUsage wird nur aufgenommen, wenn es uebergeben wurde, damit die
 * bestehenden Wire-Formen unveraendert bleiben.
 */

/** Erfolgreiches Chat-Ergebnis (Modell hat geantwortet, keine Tools mehr offen). */
function createChatResult({ content = '', toolTrace = [], usage = null, contextUsage } = {}) {
  const result = { content, toolTrace, usage };
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  return result;
}

/** Vom Nutzer bzw. per AbortSignal abgebrochenes Chat-Ergebnis. */
function createCancelledChatResult({ content = '', toolTrace = [], usage = null, contextUsage } = {}) {
  const result = { cancelled: true, content, toolTrace, usage };
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  return result;
}

/**
 * Fehler-Ergebnis. usage/contextUsage werden nur aufgenommen, wenn sie
 * übergeben wurden — Frühabbrüche (z. B. leere Nachricht) bleiben so bei der
 * schlanken Form { error, code }, wie sie der Renderer erwartet.
 */
function createChatErrorResult({ error, code = CHAT_ERROR_CODES.INVALID, usage, contextUsage } = {}) {
  const result = { error, code };
  if (usage !== undefined) result.usage = usage;
  if (contextUsage !== undefined) result.contextUsage = contextUsage;
  return result;
}

// --- Push-Events (Main -> Renderer) ----------------------------------------

/** chat:delta — ein Stück Antwort-Text. */
function createDeltaEvent(text) {
  return { text: String(text ?? '') };
}

/**
 * chat:tool-line — Tool-Ereignis mit Anzeige-Zeile und optionalen Rohdaten.
 * entry = { line, tool?, args?, waitMs?, noWorkspace? }.
 * `line` ist die fertige UI-Zeile; tool/args bleiben für Debugging/Kompatibilität.
 */
function createToolLineEvent(phase, entry) {
  return { phase, ...entry };
}

/** chat:progress mit type='workspace' nach erfolgreichem Dateischreiben. */
function createWorkspaceFileWrittenEvent(relativePath) {
  return {
    type: CHAT_PROGRESS_TYPES.WORKSPACE,
    event: WORKSPACE_PROGRESS_EVENTS.FILE_WRITTEN,
    relativePath: String(relativePath ?? ''),
  };
}

/** chat:progress mit type='phase'. */
function createPhaseEvent(phase) {
  return { type: CHAT_PROGRESS_TYPES.PHASE, phase };
}

/** chat:progress mit type='reasoning'. */
function createReasoningEvent(text) {
  return { type: CHAT_PROGRESS_TYPES.REASONING, text };
}

// --- Validatoren ------------------------------------------------------------

function isChatErrorCode(code) {
  return Object.values(CHAT_ERROR_CODES).includes(code);
}

function isChatPhase(phase) {
  return Object.values(CHAT_PHASES).includes(phase);
}

function isToolLinePhase(phase) {
  return Object.values(TOOL_LINE_PHASES).includes(phase);
}

module.exports = {
  createChatResult,
  createCancelledChatResult,
  createChatErrorResult,
  createDeltaEvent,
  createToolLineEvent,
  createPhaseEvent,
  createReasoningEvent,
  createWorkspaceFileWrittenEvent,
  isChatErrorCode,
  isChatPhase,
  isToolLinePhase,
};
