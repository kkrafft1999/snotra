'use strict';

// What `createCore` is handed (#983). Types only, like a port file. No
// Electron in here: every value is a port, a Node module or a plain value,
// so a host other than the desktop can build the core as well.

/**
 * @typedef {Object} CoreOptions
 * @property {typeof import('fs/promises')} fs
 * @property {typeof import('path')} path
 * @property {typeof import('os')} [os]
 * @property {typeof import('crypto')} [crypto]
 * @property {typeof import('child_process')} [childProcess]
 * @property {typeof fetch} fetchImpl
 * @property {typeof import('../providers')} providersModule
 * @property {{ getActiveWorkspaceRoot: () => string | null, setActiveWorkspaceRoot: (folderPath: unknown) => void }} workspaceState
 * @property {typeof import('../../shared/ipc-channels').PUSH_CHANNELS} PUSH
 * @property {typeof import('../../shared/limits').LIMITS} LIMITS
 * @property {string} userDataPath
 *   Where every store file, the policy and the history live.
 * @property {() => string} [getAppVersion]
 *   For the system prompt, the MCP handshake and the feedback form; `0.0.0`
 *   without one.
 * @property {() => string} [getSystemLocale]
 *   The system's locale, read for the interface language of a first run.
 * @property {import('../../application/ports/secret-store-port').SecretStorePort} secretStore
 * @property {import('../../shared/contracts/safe-storage-key').SafeStorageKeyDurability} [safeStorageKey]
 *   When ciphertext may reach the disk (#1060); without it nothing waits.
 * @property {ReturnType<typeof import('../../application/permissions/user-confirmation').createConfirmationReceipts>} [confirmationReceipts]
 *   The registry the confirmation adapter issues receipts from and the stores
 *   redeem them at (#980). The host makes it when its adapter needs `issue`.
 * @property {import('../../application/ports/user-confirmation-port').UserConfirmationPort} [confirmations]
 *   Without one, nothing is ever confirmed (`createRefusingConfirmation`).
 * @property {import('../../application/ports/notification-port').NotificationPort | null} [notifications]
 *   Without them, no approval notification.
 * @property {import('../../application/ports/event-push-port').EventPushPort} [eventPush]
 *   Without one, every push is dropped.
 * @property {((absPath: string) => Promise<void>) | null} [trashItem]
 *   Moves a file to the trash, for the recovery copies of the file tools.
 *   Without it, they keep none.
 * @property {import('../../shared/contracts/platform-capabilities').PlatformCapabilities} [platformCapabilities]
 *   What this platform can do (#1149); by default resolved for this process.
 * @property {string} [defaultProviderId]
 * @property {string} [speechProviderId]
 * @property {string | null} [systemSkillsDir]
 * @property {typeof import('fs').watch | null} [watchFile]
 *   `fs.watch`; without it everything runs without the skills and tree watchers.
 * @property {((path: string) => string) | null} [realpathNative]
 * @property {ReturnType<typeof import('../services/manual-service').createManualService> | null} [manual]
 * @property {(() => void) | null} [onAppLocaleChanged]
 * @property {((show: boolean) => void) | null} [onShowHiddenFilesChanged]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {ReturnType<typeof import('../services/app-notices').createAppNotices> | null} [notices]
 * @property {import('../../application/ports/remote-relay-port').RemoteRelayPort | null} [remoteRelay]
 * @property {import('../../application/ports/power-save-port').PowerSavePort | null} [powerSave]
 *   Without one, the computer is never kept awake for the phone (#1196).
 */

module.exports = {};
