/**
 * Notification port (#983, AR-08): a message from the operating system, for
 * something that waits while the app is out of sight — an approval card
 * (#792, step 5). The rules — when one goes up, how long its text may be,
 * how many at once — are the caller's (`src/main/services/approval-notifier.js`);
 * the port only shows and takes away.
 *
 * On the desktop it is Electron's `Notification`, and a click brings the app
 * window to the front before `onClick` runs
 * (`src/main/electron/system-notification-adapter.js`). A host without one
 * answers `isSupported()` with false, and nothing is shown.
 */

/**
 * @typedef {Object} NotificationRequest
 * @property {string} title
 * @property {string} body
 * @property {() => void} onClick  the user clicked it; the app is in front by then
 * @property {() => void} onClose  it went away without a click
 */

/**
 * @typedef {Object} ShownNotification
 * @property {() => void} close  takes it away; nothing when it is gone already
 */

/**
 * @typedef {Object} NotificationPort
 * @property {() => boolean} isSupported  whether this system shows notifications at all
 * @property {(request: NotificationRequest) => ShownNotification} show  throws when the system refused it
 */

module.exports = {};
