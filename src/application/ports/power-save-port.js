'use strict';

/**
 * Power-save port (#1196): keeps the computer from going to sleep while a
 * phone follows a run that is still working. When it holds is the caller's
 * decision (`src/application/remote/remote-presence.js`); the port only
 * takes and gives back.
 *
 * On the desktop it is Electron's `powerSaveBlocker` with
 * `prevent-app-suspension` — the system stays awake, the display may still
 * turn off (`src/main/electron/power-save-adapter.js`).
 */

/**
 * @typedef {Object} PowerSavePort
 * @property {() => unknown} hold  keeps the system awake; the handle goes back to `release`. Throws when it could not
 * @property {(handle: unknown) => void} release  lets it sleep again; nothing for a handle already released
 */

module.exports = {};
