'use strict';

/**
 * Environment-Port (Issue #138): traegt die Laufzeitangaben zusammen, aus
 * denen der Chat-Core den Environment-Block des Systemprompts baut.
 *
 * Die Shell kommt aus derselben Quelle wie `shell_execute` selbst
 * (`shellRunnerService.describe()`, Issue #102/#111) — damit stimmt der Prompt
 * per Konstruktion mit dem ueberein, was ein Befehl tatsaechlich startet.
 * Steht das Tool aus oder wurde keine Shell gefunden, bleibt die Angabe leer.
 */

/**
 * @param {Object} deps
 * @param {typeof import('fs/promises')} deps.fs
 * @param {typeof import('path')} deps.path
 * @param {typeof import('os')} deps.os
 * @param {string} [deps.appName]
 * @param {() => string} [deps.getAppVersion]
 * @param {() => { found?: boolean, enabled?: boolean, label?: string }} [deps.describeShell]
 * @param {string} [deps.platform]
 * @param {() => Date} [deps.now]
 */
function createEnvironmentAdapter({
  fs,
  path,
  os,
  appName = 'Snotra AI',
  getAppVersion = null,
  describeShell = null,
  platform = process.platform,
  now = () => new Date(),
}) {
  /**
   * Git ja/nein ohne `git`-Aufruf: `.git` ist im Normalfall ein Verzeichnis,
   * in einem Worktree oder Submodul eine Datei mit `gitdir:`. Beides zaehlt.
   */
  async function isGitRepository(root) {
    if (!root) return null;
    try {
      await fs.stat(path.join(root, '.git'));
      return true;
    } catch (e) {
      // Nur ein fehlender Eintrag heisst „kein Repo". Ein Rechtefehler oder
      // ein unerreichbarer Pfad heisst „unbekannt" — dann bleibt die Zeile weg,
      // statt eine falsche Auskunft in den Prompt zu schreiben.
      return e && e.code === 'ENOENT' ? false : null;
    }
  }

  function resolveShellLabel() {
    if (typeof describeShell !== 'function') return null;
    let state;
    try {
      state = describeShell();
    } catch {
      return null;
    }
    if (!state || state.found !== true || state.enabled !== true) return null;
    const label = typeof state.label === 'string' ? state.label.trim() : '';
    return label || null;
  }

  function resolveAppVersion() {
    if (typeof getAppVersion !== 'function') return '';
    try {
      const version = getAppVersion();
      return typeof version === 'string' ? version.trim() : '';
    } catch {
      return '';
    }
  }

  return {
    async describe({ workspaceRoot = null } = {}) {
      const root = typeof workspaceRoot === 'string' && workspaceRoot.trim()
        ? workspaceRoot.trim()
        : null;
      return {
        appName,
        appVersion: resolveAppVersion(),
        workspaceRoot: root,
        isGitRepository: await isGitRepository(root),
        platform,
        // `os.type()` nennt die Systemfamilie, `os.release()` die Kernel-
        // version — zusammen die Form, die auch Claude Code mitgibt.
        osVersion: `${os.type()} ${os.release()}`.trim(),
        shell: resolveShellLabel(),
        now: now(),
      };
    },
  };
}

module.exports = {
  createEnvironmentAdapter,
};
