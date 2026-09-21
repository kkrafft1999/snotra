/**
 * Memory-Port: das Gedächtnis, aus dem der Chat-Core seinen Block baut und in
 * das `remember` schreibt (Issue #166).
 *
 * Der Core darf nicht wissen, wo die Dateien liegen — `os.homedir()` und das
 * Dateisystem sind Laufzeitwissen und gehören deshalb hinter diesen Port. Aus
 * demselben Grund nimmt `remember` **keinen Pfad** entgegen, sondern nur die
 * Ebene: So gibt es nichts, wohin ein Modell zeigen könnte, und die
 * Workspace-Grenze der Datei-Tools bleibt unangetastet.
 *
 * Fehlende Dateien sind der Normalfall und kein Fehler: `load` liefert dann
 * eine leere Liste, nicht einen abgelehnten Aufruf.
 */

/**
 * @typedef {Object} MemoryFile
 * @property {string} scope — eine der `MEMORY_SCOPES`
 * @property {string} file — absoluter Pfad, für Anzeige und Tool-Ergebnis
 * @property {string} text — Inhalt der Datei, ggf. bereits gekürzt
 * @property {boolean} truncated — ob der Inhalt an der Grenze abgeschnitten wurde
 */

/**
 * @typedef {Object} MemoryPort
 * @property {(options: { workspaceRoot?: string|null }) => Promise<MemoryFile[]>} load
 * @property {(request: { scope: string, text: string, origin: string, workspaceRoot?: string|null }) => Promise<{scope: string, file: string, text: string}>} remember
 * @property {(request: { scope: string, line: number, workspaceRoot?: string|null }) => Promise<{removed: boolean}>} forget
 * @property {(options: { workspaceRoot?: string|null }) => Record<string, string|null>} paths
 */

module.exports = {};
