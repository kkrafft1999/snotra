'use strict';

// What `createApplication` is handed (#1098). Types only, like a port file:
// the comments that used to sit between the destructured names live here, so
// the composition root stays wiring and inside its line budget.

/**
 * @typedef {Object} ApplicationOptions
 * @property {import('electron').App} app
 * @property {import('../ipc/trusted-sender').GuardedIpcMain} ipcMain
 * @property {import('electron').Dialog} dialog
 * @property {import('electron').SafeStorage} safeStorage
 * @property {import('../../shared/contracts/safe-storage-key').SafeStorageKeyDurability} [safeStorageKey]
 *   When ciphertext may reach the disk (#1060): on a fresh Windows profile,
 *   once the key behind `safeStorage` is in `Local State`. index.js hands in
 *   the real one; without it nothing waits.
 * @property {typeof import('fs/promises')} fs
 * @property {typeof import('path')} path
 * @property {typeof import('os')} [os]
 * @property {typeof import('crypto')} [crypto]
 * @property {typeof import('child_process')} [childProcess]
 * @property {typeof fetch} fetchImpl
 * @property {typeof import('../providers')} providersModule
 * @property {{ getActiveWorkspaceRoot: () => string | null, setActiveWorkspaceRoot: (folderPath: unknown) => void }} workspaceState
 * @property {() => import('electron').BrowserWindow | null} getMainWindow
 * @property {typeof import('electron').Menu | null} [Menu]
 * @property {import('electron').Shell | null} [shell]
 * @property {import('electron').Clipboard | null} [clipboard]
 * @property {Pick<import('electron').PowerSaveBlocker, 'start' | 'stop' | 'isStarted'> | null} [powerSaveBlocker]
 *   Electron's, to stay awake while the phone follows a working run (#1196); without it, never.
 * @property {typeof import('electron').Notification | null} [Notification]
 *   Electron's, for a card waiting out of sight (#792, step 5); without it,
 *   none.
 * @property {typeof import('../../shared/ipc-channels').REQUEST_CHANNELS} REQ
 * @property {typeof import('../../shared/ipc-channels').PUSH_CHANNELS} PUSH
 * @property {typeof import('../../shared/limits').LIMITS} LIMITS
 * @property {string} [defaultProviderId]
 * @property {string} [speechProviderId]
 * @property {ReturnType<typeof import('../services/update-service').createUpdateService>} [updates]
 * @property {string | null} [systemSkillsDir]
 *   Where the system skills are; by default next to the app (`system-skills`).
 * @property {typeof import('fs').watch | null} [watchFile]
 *   `fs.watch` from the synchronous fs module — `fs` here is fs/promises and
 *   lacks it. Without it everything runs without a skills watcher (#126).
 * @property {((path: string) => string) | null} [realpathNative]
 *   `fs.realpathSync.native`, handed in for the same reason. Only the file
 *   tree watcher needs it, to keep Windows from failing on an 8.3 short name
 *   (#158).
 * @property {ReturnType<typeof import('../services/manual-service').createManualService> | null} [manual]
 *   The bundled user manual. With it the model gets search_manual and
 *   read_manual_page (#947); without it, neither.
 * @property {(() => void) | null} [onAppLocaleChanged]
 *   Called when the user switches the language (epic #277). The caller
 *   rebuilds the menu bar from it — the menu belongs to them, not here.
 * @property {((show: boolean) => void) | null} [onShowHiddenFilesChanged]
 *   Called when hidden files in the tree are switched on or off, and at
 *   start-up when the stored value is on (#436). The caller ticks the checkbox
 *   in its View menu, which starts unticked.
 * @property {NodeJS.ProcessEnv} [env]
 *   The process environment. Only `SNOTRA_NO_UPDATE_CHECK` is read: set to
 *   `1`, the silent check at start-up does not ask GitHub (#407). The smoke
 *   test sets it, so a release published in the meantime cannot put the
 *   update dialog over the window it takes screenshots of.
 * @property {typeof import('electron').session | null} [session]
 *   Electron's `session` and `WebContentsView`, for HTML files as live pages
 *   (#479). Without them the channels stay unregistered and the HTML view
 *   says that the preview could not be started.
 * @property {typeof import('electron').WebContentsView | null} [WebContentsView]
 * @property {ReturnType<typeof import('../services/app-notices').createAppNotices> | null} [notices]
 *   The notices for the window (#1001). The caller may hand in its own, so
 *   that the error path it set up before the app was ready (#978) posts to
 *   the same list the window reads; without one a fresh list is made here.
 * @property {import('../../application/ports/remote-relay-port').RemoteRelayPort | null} [remoteRelay]
 *   The relay of the mobile remote (#1114). Without one, the Firebase relay of
 *   `src/main/remote/relay-endpoint.js`; tests hand in the in-memory relay.
 */

module.exports = {};
