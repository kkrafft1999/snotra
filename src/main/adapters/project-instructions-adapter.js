'use strict';

/**
 * Project-Instructions-Port (Issue #212, nachgeschärft in #253): liest die
 * drei `AGENTS.md`-Quellen vom Dateisystem und liefert sie in der Reihenfolge,
 * in der sie im Prompt stehen sollen — dieselbe Liste wie bei den Skills
 * (Issue #251): Workspace, dann `~/.snotra`, dann `~/.agents`.
 *
 * **Bewusst ohne Cache und ohne Watcher.** Drei Lesezugriffe je Anfrage
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
const { createEmbeddedTextFiles } = require('../services/embedded-text-file');

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @param {number} [deps.maxChars] — Grenze je Datei
 */
function createProjectInstructionsAdapter({ fs, path, os, maxChars = MAX_PROJECT_INSTRUCTION_CHARS }) {
  if (!fs || !path) throw new TypeError('createProjectInstructionsAdapter benötigt fs und path.');

  // The folder's file comes with the folder: read only when its real path
  // stays inside it, and never further than the limit (#534).
  const textFiles = createEmbeddedTextFiles({ fs, path });

  function homeDir() {
    let home;
    try {
      home = os && typeof os.homedir === 'function' ? os.homedir() : null;
    } catch {
      return null;
    }
    // Aufgeloest wie der Workspace-Pfad weiter unten. `os.homedir()` liefert
    // ohnehin absolut, aber die Doppelt-Erkennung vergleicht beide Seiten als
    // Zeichenkette — da sollen sie in derselben Form entstehen.
    return typeof home === 'string' && home.trim() ? path.resolve(home) : null;
  }

  /** Die Quellen als Paare aus Quelle und absolutem Pfad, in Lesereihenfolge. */
  function chain(workspaceRoot) {
    const targets = [];
    const root =
      typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : null;
    // In the project only the root-level file counts (#432); `.agents/AGENTS.md`
    // stays unread.
    if (root) {
      targets.push({
        source: PROJECT_INSTRUCTION_SOURCES.WORKSPACE_AGENTS,
        file: path.join(root, PROJECT_INSTRUCTIONS_FILE),
        root,
      });
    }
    const home = homeDir();
    if (home) {
      targets.push({
        source: PROJECT_INSTRUCTION_SOURCES.USER_SNOTRA,
        file: path.join(home, '.snotra', PROJECT_INSTRUCTIONS_FILE),
      });
      targets.push({
        source: PROJECT_INSTRUCTION_SOURCES.USER_AGENTS,
        file: path.join(home, '.agents', PROJECT_INSTRUCTIONS_FILE),
      });
    }
    // Opening `~/.snotra` or `~/.agents` itself makes the project file and a
    // global one the same path. The same file twice in the prompt would be
    // paid twice and read like two instructions; the first hit stays.
    const seen = new Set();
    return targets.filter(({ file }) => {
      if (seen.has(file)) return false;
      seen.add(file);
      return true;
    });
  }

  async function readInstructionFile({ source, file, root = null }) {
    // Fehlend, unlesbar, ein Verzeichnis statt einer Datei, ein Symlink aus
    // dem Ordner hinaus: alles derselbe Normalfall. Eine Anweisungsdatei, die
    // es nicht gibt, ist kein Fehler. The global files have no root to stay
    // in — they are the user's own, and a dotfiles manager links them.
    const read = await textFiles.readForPrompt({ file, root, maxChars });
    if (!read || !read.text.trim()) return null;
    return { source, text: read.text, truncated: read.truncated };
  }

  return {
    async load({ workspaceRoot = null } = {}) {
      const targets = chain(workspaceRoot);
      const results = await Promise.all(targets.map(readInstructionFile));
      return results.filter(Boolean);
    },
  };
}

module.exports = {
  createProjectInstructionsAdapter,
};
