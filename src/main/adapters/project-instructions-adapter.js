'use strict';

/**
 * Project-Instructions-Port (Issue #212): liest die `AGENTS.md`-Kette vom
 * Dateisystem und liefert sie in der Reihenfolge, in der sie im Prompt stehen
 * soll — global vor Projekt, geteilt vor eigen.
 *
 * **Bewusst ohne Cache und ohne Watcher.** Vier `readFile`-Aufrufe je Anfrage
 * kosten gegen einen Modellaufruf nichts Messbares; der Skill-Katalog braucht
 * beides nur, weil er ganze Verzeichnisse scannt und Frontmatter parst
 * (`skills-service.js`). Ohne Cache gibt es hier auch nichts zu invalidieren —
 * eine geänderte `AGENTS.md` wirkt damit ab der nächsten Nachricht, ohne dass
 * die App neu starten oder ein Wächter anschlagen müsste.
 */

const {
  PROJECT_INSTRUCTIONS_FILE,
  PROJECT_INSTRUCTION_SOURCES,
  MAX_PROJECT_INSTRUCTION_CHARS,
} = require('../../shared/contracts/project-instructions');

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @param {number} [deps.maxChars] — Grenze je Datei
 */
function createProjectInstructionsAdapter({ fs, path, os, maxChars = MAX_PROJECT_INSTRUCTION_CHARS }) {
  if (!fs || !path) throw new TypeError('createProjectInstructionsAdapter benötigt fs und path.');

  function homeDir() {
    try {
      return os && typeof os.homedir === 'function' ? os.homedir() : null;
    } catch {
      return null;
    }
  }

  /** Die Kette als Paare aus Quelle und absolutem Pfad, in Prompt-Reihenfolge. */
  function chain(workspaceRoot) {
    const targets = [];
    const home = homeDir();
    if (home) {
      targets.push({
        source: PROJECT_INSTRUCTION_SOURCES.USER_AGENTS,
        file: path.join(home, '.agents', PROJECT_INSTRUCTIONS_FILE),
      });
      targets.push({
        source: PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA,
        file: path.join(home, '.snotra', PROJECT_INSTRUCTIONS_FILE),
      });
    }
    const root =
      typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : null;
    if (root) {
      targets.push({
        source: PROJECT_INSTRUCTION_SOURCES.WORKSPACE_ROOT,
        file: path.join(root, PROJECT_INSTRUCTIONS_FILE),
      });
      targets.push({
        source: PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS,
        file: path.join(root, '.agents', PROJECT_INSTRUCTIONS_FILE),
      });
    }
    // Liegt der geöffnete Ordner im Home, fallen Pfade zusammen — `~/.agents`
    // ist dann zugleich `<workspace>/.agents`. Dieselbe Datei zweimal im
    // Prompt wäre doppelt bezahlt und läse sich wie zwei Anweisungen; es
    // gewinnt der erste Treffer, also die allgemeinere Quelle.
    const seen = new Set();
    return targets.filter(({ file }) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    });
  }

  async function readInstructionFile(source, file) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      // Fehlend, unlesbar, ein Verzeichnis statt einer Datei: alles derselbe
      // Normalfall. Eine Anweisungsdatei, die es nicht gibt, ist kein Fehler.
      return null;
    }
    if (typeof raw !== 'string' || !raw.trim()) return null;
    const truncated = raw.length > maxChars;
    return { source, text: truncated ? raw.slice(0, maxChars) : raw, truncated };
  }

  return {
    async load({ workspaceRoot = null } = {}) {
      const targets = chain(workspaceRoot);
      const results = await Promise.all(
        targets.map(({ source, file }) => readInstructionFile(source, file))
      );
      return results.filter(Boolean);
    },
  };
}

module.exports = {
  createProjectInstructionsAdapter,
};
