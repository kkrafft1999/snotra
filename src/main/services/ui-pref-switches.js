'use strict';

/**
 * A preference that is on until the user switches it off — self-memory
 * (#166), the notification for a waiting card (#792) and the update check at
 * start-up (#987). Each is read when it is needed rather than remembered, so
 * the switch takes effect without a restart.
 *
 * @param {{ readUIPrefs: () => Promise<Object> }} uiPrefsStore
 * @param {string} key
 * @returns {() => Promise<boolean>}
 */
function defaultOnSwitch(uiPrefsStore, key) {
  return async () => (await uiPrefsStore.readUIPrefs())?.[key] !== false;
}

module.exports = { defaultOnSwitch };
