/**
 * Workspace-Tool-Anzeigezeilen (Stage 5 — Tool-Präsentation).
 *
 * Single Source of Truth für deutschsprachige Tool-Zeilen im Chat. Wird vom
 * Main-seitigen ToolPort-Adapter genutzt; der Renderer zeigt nur noch `line`.
 */
'use strict';

const { resolveDebugWaitMs } = require('../contracts/debug-wait');
const { APP_LOCALES } = require('../contracts/enums');

function truncateToolLabel(s, max = 48) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function formatRelativePathForLabel(relativePath) {
  const raw = typeof relativePath === 'string' ? relativePath.trim() : '';
  if (!raw || raw === '.') return null;
  return truncateToolLabel(raw);
}

function formatPauseDurationLabel(ms, phase, locale = APP_LOCALES.DE) {
  const seconds = ms / 1000;
  const label = Number.isInteger(seconds)
    ? String(seconds)
    : seconds.toLocaleString(locale === APP_LOCALES.EN ? 'en-US' : 'de-DE', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
  const unit = seconds === 1 ? 'Sekunde' : 'Sekunden';
  if (phase === 'done') return `${label} ${unit} gewartet`;
  return `Warte ${label} ${unit} …`;
}

/**
 * Anzeige-Zeile für einen Tool-Aufruf. phase 'pending' (Aufruf wird noch vom
 * Modell gestreamt) nutzt bewusst dieselbe Formulierung wie 'start' — für den
 * Nutzer ist „Datei X wird geschrieben …“ ab dem ersten Token zutreffend.
 */
function summarizeToolCall(toolName, args, phase = 'start', locale = APP_LOCALES.DE) {
  const isDone = phase === 'done';
  if (toolName === 'list_directory') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    if (pathLabel) {
      return isDone ? `Ordner ${pathLabel} durchsucht` : `Ordner ${pathLabel} wird durchsucht …`;
    }
    return isDone ? 'Projektordner durchsucht' : 'Projektordner wird durchsucht …';
  }
  if (toolName === 'read_file_text') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    if (pathLabel) {
      return isDone ? `Datei ${pathLabel} gelesen` : `Datei ${pathLabel} wird gelesen …`;
    }
    return isDone ? 'Datei gelesen' : 'Datei wird gelesen …';
  }
  if (toolName === 'read_file_lines') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    const start = Number.isFinite(args?.start_line) ? Math.floor(args.start_line) : null;
    const end = Number.isFinite(args?.end_line) ? Math.floor(args.end_line) : null;
    let rangeLabel = null;
    if (start !== null && end !== null) rangeLabel = ` (Zeilen ${start}–${end})`;
    else if (start !== null) rangeLabel = ` (ab Zeile ${start})`;
    const target = `Datei${pathLabel ? ` ${pathLabel}` : ''}${rangeLabel || ''}`;
    return isDone ? `${target} gelesen` : `${target} wird gelesen …`;
  }
  if (toolName === 'write_file_text') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    if (pathLabel) {
      return isDone ? `Datei ${pathLabel} geschrieben` : `Datei ${pathLabel} wird geschrieben …`;
    }
    return isDone ? 'Datei geschrieben' : 'Datei wird geschrieben …';
  }
  if (toolName === 'edit_file') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    if (pathLabel) {
      return isDone ? `Datei ${pathLabel} geändert` : `Datei ${pathLabel} wird geändert …`;
    }
    return isDone ? 'Datei geändert' : 'Datei wird geändert …';
  }
  if (toolName === 'apply_patch') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    if (pathLabel) {
      return isDone ? `Datei ${pathLabel} gepatcht` : `Datei ${pathLabel} wird gepatcht …`;
    }
    return isDone ? 'Patch angewendet' : 'Patch wird angewendet …';
  }
  if (toolName === 'search_in_files') {
    const raw = typeof args?.query === 'string' ? args.query.trim() : '';
    if (raw) {
      const queryLabel = `„${truncateToolLabel(raw, 32)}“`;
      return isDone ? `Nach ${queryLabel} gesucht` : `Suche nach ${queryLabel} …`;
    }
    return isDone ? 'Dateien durchsucht' : 'Dateien werden durchsucht …';
  }
  if (toolName === 'find_files') {
    const raw = typeof args?.pattern === 'string' ? args.pattern.trim() : '';
    if (raw) {
      const patternLabel = `„${truncateToolLabel(raw, 32)}“`;
      return isDone ? `Dateien zu ${patternLabel} gesucht` : `Suche Dateien zu ${patternLabel} …`;
    }
    return isDone ? 'Dateien gesucht' : 'Dateien werden gesucht …';
  }
  if (toolName === 'stat_path') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    if (pathLabel) {
      return isDone ? `Pfad ${pathLabel} geprüft` : `Pfad ${pathLabel} wird geprüft …`;
    }
    return isDone ? 'Pfad geprüft' : 'Pfad wird geprüft …';
  }
  if (toolName === 'outline_file') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    if (pathLabel) {
      return isDone
        ? `Gliederung von ${pathLabel} ermittelt`
        : `Gliederung von ${pathLabel} wird ermittelt …`;
    }
    return isDone ? 'Gliederung ermittelt' : 'Gliederung wird ermittelt …';
  }
  if (toolName === 'list_directory_tree') {
    const pathLabel = formatRelativePathForLabel(args?.relative_path);
    if (pathLabel) {
      return isDone ? `Ordnerbaum ${pathLabel} gelesen` : `Ordnerbaum ${pathLabel} wird gelesen …`;
    }
    return isDone ? 'Ordnerbaum gelesen' : 'Ordnerbaum wird gelesen …';
  }
  if (toolName === 'debug_wait') {
    return formatPauseDurationLabel(resolveDebugWaitMs(args), phase, locale);
  }
  const name = truncateToolLabel(toolName || 'Tool');
  return isDone ? `${name} ausgeführt` : `${name} wird ausgeführt …`;
}

/**
 * Formatiert einen Tool-Trace-Eintrag zur Anzeige-Zeile.
 * Bereits formatierte Strings (persistierte Alt-Sessions) gehen unverändert durch.
 */
function formatToolDisplayLine(entry, phase = 'start', locale = APP_LOCALES.DE) {
  if (typeof entry === 'string') return entry;
  const line =
    entry?.tool === 'debug_wait' && Number.isFinite(entry?.waitMs)
      ? formatPauseDurationLabel(entry.waitMs, phase, locale)
      : summarizeToolCall(entry?.tool, entry?.args, phase, locale);
  return entry?.noWorkspace ? `${line} · kein Ordner geöffnet` : line;
}

module.exports = {
  truncateToolLabel,
  formatToolDisplayLine,
  summarizeToolCall,
};
