'use strict';

/**
 * Datei-Watcher für die Skill-Verzeichnisse (Issue #126, Teil von #89).
 *
 * Bis dahin wurde nur beim Öffnen eines Ordners und auf Knopfdruck gescannt
 * — ein frisch angelegter oder per `skill-manager` installierter Skill tauchte
 * erst nach „Skills neu laden“ auf. Dieser Dienst beobachtet die Quellen und
 * meldet Änderungen, damit der Scan-Cache von selbst verfällt.
 *
 * Beobachtet werden die drei *Ordner*-Quellen: `<workspace>/.agents/skills`,
 * `~/.snotra/skills` und `~/.agents/skills`. Die System-Skills liegen im
 * App-Bundle und ändern sich zur Laufzeit nicht.
 *
 * Seit Issue #158 steckt die Mechanik in `directory-watcher.js` — dieselbe,
 * die auch den Dateibaum am Dateisystem hält. Hier bleibt nur, was an den
 * Skills eigen ist: welche Verzeichnisse gemeint sind, wie weit die Wächter
 * nach oben aufsteigen dürfen, und dass die Meldung ohne Nutzlast auskommt
 * (für den Scan-Cache zählt allein „irgendetwas hat sich geändert“).
 */

const {
  createDirectoryWatcher,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RETRY_MS,
} = require('./directory-watcher');

/**
 * Wie weit dürfen die Wächter aufsteigen? `.agents/skills` → `.agents` →
 * Workspace- bzw. Home-Wurzel, ebenso `~/.snotra/skills` → `~/.snotra` → `~`.
 * Weiter nicht: Darüber lägen fremde Verzeichnisse, die uns nichts angehen.
 */
const MAX_FALLBACK_LEVELS = 2;

function createSkillsWatcher({ watch, path, os = null, onChange, ...watcherOptions }) {
  if (typeof watch !== 'function') throw new TypeError('createSkillsWatcher benötigt watch.');
  if (!path) throw new TypeError('createSkillsWatcher benötigt path.');
  if (typeof onChange !== 'function') throw new TypeError('createSkillsWatcher benötigt onChange.');

  function homeDir() {
    try {
      return os && typeof os.homedir === 'function' ? os.homedir() : null;
    } catch {
      return null;
    }
  }

  /** Die zu beobachtenden Skill-Verzeichnisse — ohne die System-Quelle. */
  function targetDirectories(workspaceRoot) {
    const dirs = [];
    const root =
      typeof workspaceRoot === 'string' && workspaceRoot.trim() ? path.resolve(workspaceRoot) : null;
    if (root) dirs.push(path.join(root, '.agents', 'skills'));
    const home = homeDir();
    if (home) {
      dirs.push(path.join(home, '.snotra', 'skills'));
      dirs.push(path.join(home, '.agents', 'skills'));
    }
    // Liegt der Workspace im Home, fallen zwei der Pfade zusammen.
    return [...new Set(dirs)];
  }

  return createDirectoryWatcher({
    watch,
    path,
    resolveTargets: targetDirectories,
    fallbackLevels: MAX_FALLBACK_LEVELS,
    // Der Skill-Katalog wird ohnehin komplett neu gelesen — welche Datei sich
    // geändert hat, ändert daran nichts.
    onChange: () => onChange(),
    ...watcherOptions,
  });
}

module.exports = {
  createSkillsWatcher,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_MAX_WAIT_MS,
  DEFAULT_RETRY_MS,
  MAX_FALLBACK_LEVELS,
};
