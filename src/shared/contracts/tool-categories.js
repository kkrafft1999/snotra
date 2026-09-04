/**
 * Tool-Kategorien (Issue #60, Codex-nahe Darstellung).
 *
 * Die Anzeige gruppiert erledigte Tool-Schritte („4 Dateien gelesen ·
 * 2 Suchen“) und zeigt je Zeile ein Symbol. Beides braucht die Art des
 * Aufrufs, nicht nur den fertigen Anzeigetext — deshalb liegt die Zuordnung
 * hier in der Contract-Schicht: Main schreibt sie in den Verlauf, der
 * Renderer leitet daraus Text und Symbol ab.
 */
'use strict';

const TOOL_CATEGORIES = Object.freeze({
  READ: 'read',
  SEARCH: 'search',
  LIST: 'list',
  CHECK: 'check',
  WRITE: 'write',
  WAIT: 'wait',
  /** Unbekannt — z. B. Einträge aus Sessions, die vor #60 gespeichert wurden. */
  OTHER: 'other',
});

const TOOL_CATEGORY_BY_TOOL = Object.freeze({
  read_file_text: TOOL_CATEGORIES.READ,
  read_file_lines: TOOL_CATEGORIES.READ,
  outline_file: TOOL_CATEGORIES.READ,
  search_in_files: TOOL_CATEGORIES.SEARCH,
  find_files: TOOL_CATEGORIES.SEARCH,
  list_directory: TOOL_CATEGORIES.LIST,
  list_directory_tree: TOOL_CATEGORIES.LIST,
  stat_path: TOOL_CATEGORIES.CHECK,
  write_file_text: TOOL_CATEGORIES.WRITE,
  edit_file: TOOL_CATEGORIES.WRITE,
  apply_patch: TOOL_CATEGORIES.WRITE,
  debug_wait: TOOL_CATEGORIES.WAIT,
});

/** Kategorie eines Tools; unbekannte und fehlende Namen ergeben OTHER. */
function toolCategory(toolName) {
  if (typeof toolName !== 'string' || !toolName) return TOOL_CATEGORIES.OTHER;
  return TOOL_CATEGORY_BY_TOOL[toolName] || TOOL_CATEGORIES.OTHER;
}

module.exports = { TOOL_CATEGORIES, TOOL_CATEGORY_BY_TOOL, toolCategory };
