/**
 * Project-Instructions-Port: die `AGENTS.md`-Dateien, aus denen der Chat-Core
 * den Block mit den Projektanweisungen baut (Issue #212).
 *
 * Der Core darf nicht wissen, wo diese Dateien liegen — `os.homedir()` und das
 * Dateisystem sind Laufzeitwissen und gehören deshalb hinter diesen Port. Er
 * bekommt nur, was gefunden wurde, in der Reihenfolge der Kette.
 *
 * Fehlende Dateien sind der Normalfall und kein Fehler: Der Adapter liefert
 * dann eine leere Liste, nicht einen abgelehnten Aufruf.
 */

/**
 * @typedef {Object} ProjectInstructionFile
 * @property {string} source — eine der `PROJECT_INSTRUCTION_SOURCES`
 * @property {string} text — Inhalt der Datei, ggf. bereits gekürzt
 * @property {boolean} truncated — ob der Inhalt an der Grenze abgeschnitten wurde
 */

/**
 * @typedef {Object} ProjectInstructionsPort
 * @property {(options: { workspaceRoot?: string|null }) => Promise<ProjectInstructionFile[]>} load
 */

module.exports = {};
