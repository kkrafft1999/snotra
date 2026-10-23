'use strict';

/**
 * The power-save port on the desktop (#1196): Electron's `powerSaveBlocker`.
 * `prevent-app-suspension` keeps the system from sleeping, so a run the phone
 * follows goes on; the display may still turn off — nobody sits in front of it.
 */

/**
 * @param {object} deps
 * @param {Pick<import('electron').PowerSaveBlocker, 'start' | 'stop' | 'isStarted'> | null} deps.powerSaveBlocker  Electron's
 * @returns {import('../../application/ports/power-save-port').PowerSavePort | null}  null without one
 */
function createPowerSaveAdapter({ powerSaveBlocker }) {
  if (!powerSaveBlocker) return null;
  return {
    hold: () => powerSaveBlocker.start('prevent-app-suspension'),
    release(handle) {
      if (typeof handle === 'number' && powerSaveBlocker.isStarted(handle)) powerSaveBlocker.stop(handle);
    },
  };
}

module.exports = { createPowerSaveAdapter };
