/**
 * EventPush port (#983, AR-08): an event from main to the front end that it
 * did not ask for — a file changed in the tree, the skills changed, an update
 * is there, the permission state must be read again. The channel names are
 * `PUSH_CHANNELS` of `src/shared/ipc-channels.js`; what a payload carries is
 * in the contracts.
 *
 * On the desktop a push goes to the app window over IPC, and is dropped
 * while there is no window (`src/main/electron/window-push.js`). A headless
 * host hands in its own, or one that drops everything.
 */

/**
 * @typedef {Object} EventPushPort
 * @property {(channel: string, payload?: unknown) => boolean} push  whether someone was there to receive it
 */

/**
 * One receiver, for a push addressed to the window that asked rather than to
 * the app window: an approval card goes back to the window that registered
 * for it. Electron's `webContents` is one.
 *
 * @typedef {Object} EventPushTarget
 * @property {(channel: string, payload?: unknown) => void} send
 * @property {() => boolean} [isDestroyed]
 * @property {(event: 'destroyed', listener: () => void) => unknown} [once]
 */

module.exports = {};
