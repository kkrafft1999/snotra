'use strict';

/**
 * Vertrag für `fs:tree-changed` (Issue #158): Der Workspace-Watcher im Main
 * meldet dem Renderer, welche Ordner sich im Projektordner geändert haben.
 *
 * Zwei Felder, und das zweite trägt die eigentliche Aussage:
 *
 * - `directories` — betroffene **Ordner** in nativer Schreibweise (Windows mit
 *   Backslash, #73), nie Dateipfade. Der Empfänger liest genau diese Ordner
 *   neu ein, sofern sie gerade sichtbar sind.
 * - `complete` — ob die Liste alles abdeckt. `false` heißt: Da war mehr, das
 *   sich keinem Ordner zuordnen ließ (fehlender Dateiname, `git checkout`,
 *   zu viele Ordner auf einmal). Dann lädt der Empfänger gröber neu, statt
 *   sich auf die Liste zu verlassen.
 */

/**
 * Obergrenze der Liste. Ein `git checkout` über einen großen Baum beträfe
 * sonst Hunderte Ordner — damit kann der Empfänger nichts Besseres anfangen
 * als mit „alles Sichtbare neu lesen“, und die Liste wanderte für nichts durch
 * die IPC-Grenze. Wird sie überschritten, gilt die Meldung als unvollständig.
 */
const MAX_TREE_CHANGED_DIRECTORIES = 200;

function createWorkspaceTreeChangedEvent({ directories = [], complete = true } = {}) {
  const list = [
    ...new Set(
      (Array.isArray(directories) ? directories : []).filter(
        (dir) => typeof dir === 'string' && dir.length > 0
      )
    ),
  ];
  const zuViele = list.length > MAX_TREE_CHANGED_DIRECTORIES;
  return {
    directories: zuViele ? list.slice(0, MAX_TREE_CHANGED_DIRECTORIES) : list,
    complete: Boolean(complete) && !zuViele,
  };
}

module.exports = {
  createWorkspaceTreeChangedEvent,
  MAX_TREE_CHANGED_DIRECTORIES,
};
