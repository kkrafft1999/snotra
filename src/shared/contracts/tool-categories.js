/**
 * Tool-Kategorien (Issue #60, Codex-nahe Darstellung).
 *
 * Die Anzeige gruppiert erledigte Tool-Schritte („4 Dateien gelesen ·
 * 2 Suchen“) und zeigt je Zeile ein Symbol. Beides braucht die Art des
 * Aufrufs, nicht nur den fertigen Anzeigetext. Which category a tool has is
 * part of its descriptor (#1008); main writes it on the trace entry, and the
 * renderer only reads that field.
 */
'use strict';

const TOOL_CATEGORIES = Object.freeze({
  /** Zugriff auf Dateien eines eingeschalteten Skills („skill:<name>/…“, #61). */
  SKILL: 'skill',
  /**
   * A file of a skill in the open folder written by a file tool (#160). Its
   * own category so that the collapsed log says "skill file written" — as
   * one more "file written" the skill would disappear from the summary.
   */
  SKILL_WRITE: 'skill-write',
  /** A rule fetched from the rules files with `load_rule` (#1275). */
  RULE: 'rule',
  READ: 'read',
  SEARCH: 'search',
  LIST: 'list',
  CHECK: 'check',
  WRITE: 'write',
  /**
   * A generated image (#85). It is a write as well, but "1 file written" would
   * hide the one thing that cost money and is worth looking at.
   */
  IMAGE: 'image',
  /**
   * A look into Snotra's own manual (#947). Not "file read": no file of the
   * user is touched, and the log should say where the answer came from.
   */
  MANUAL: 'manual',
  /** Ausgefuehrter Code und Shell-Befehle (#86/#102) — eigene Kategorie, weil beides die Workspace-Grenze umgeht. */
  EXEC: 'exec',
  /** Unbekannt — z. B. Einträge aus Sessions, die vor #60 gespeichert wurden. */
  OTHER: 'other',
});

/** @type {Set<unknown>} */
const CATEGORY_VALUES = new Set(Object.values(TOOL_CATEGORIES));

/**
 * @typedef {(typeof TOOL_CATEGORIES)[keyof typeof TOOL_CATEGORIES]} ToolCategory
 */

/**
 * @param {unknown} value
 * @returns {value is ToolCategory}
 */
function isToolCategory(value) {
  return CATEGORY_VALUES.has(value);
}

/**
 * The category a trace entry is shown with, from the tool's own category (its
 * descriptor, #1008) and the skill the call touched. Skill goes before the
 * kind of tool: that a file came out of a skill folder matters more to the
 * user than which read tool fetched it.
 *
 * @param {unknown} toolCategory
 * @param {unknown} skill
 * @returns {ToolCategory}
 */
function entryToolCategory(toolCategory, skill) {
  const category = isToolCategory(toolCategory) ? toolCategory : TOOL_CATEGORIES.OTHER;
  if (typeof skill === 'string' && skill) {
    return category === TOOL_CATEGORIES.WRITE ? TOOL_CATEGORIES.SKILL_WRITE : TOOL_CATEGORIES.SKILL;
  }
  return category;
}

/**
 * Category of a trace entry as the renderer shows it. `category` is the tool's
 * own, written by main from the descriptor (#1008) on every new entry and
 * filled in on entries loaded from before; the skill is combined with it here
 * because the engine may learn it after the entry was made (#427). Without
 * tool and skill an entry has none (sessions stored before #60).
 *
 * @param {{ tool?: unknown, skill?: unknown, category?: unknown } | null | undefined} entry
 * @returns {ToolCategory | null}
 */
function toolCategoryForEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const named = (typeof entry.tool === 'string' && entry.tool) || (typeof entry.skill === 'string' && entry.skill);
  return named ? entryToolCategory(entry.category, entry.skill) : null;
}

module.exports = {
  TOOL_CATEGORIES,
  isToolCategory,
  entryToolCategory,
  toolCategoryForEntry,
};
