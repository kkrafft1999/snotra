'use strict';

/**
 * The switch *Access from your phone* (#1195): what the settings read of the
 * release list (#1194) and how they change it.
 *
 * Opening a workspace is a loosening — its chats become readable on the
 * paired phone — so main asks the person at the desktop in the native dialog
 * of the user-confirmation port (#980) and hands the receipt to the store.
 * Closing one takes effect at once and asks nothing; the dispatcher then ends
 * the phone's subscriptions there and tells it the new list.
 *
 * The window names a folder, but never a new one: only the open workspace, a
 * folder Snotra has worked in, or one that is open to the phone already can
 * be switched — as on *Settings › Tools › Security* (#1119).
 */

const { CONFIRMATION_ACTIONS } = require('../../application/permissions/user-confirmation');
const { createMessage } = require('../../shared/contracts/message');
const { REMOTE_PAIRING_STATES } = require('../../shared/contracts/remote/pairing-state');
const { createSettingsError, createSettingsOk } = require('../../shared/contracts/settings');
const { createTranslator } = require('../../shared/i18n');

/**
 * @param {string} root
 * @param {ReturnType<typeof createTranslator>} t
 * @returns {import('../../application/ports/user-confirmation-port').ConfirmationPrompt}
 */
function releasePrompt(root, t) {
  return {
    type: 'question',
    message: t('remote.release.confirm.message'),
    detail: t('remote.release.confirm.detail', { root }),
    // Cancel is the default and the Escape answer: Enter opens nothing.
    buttons: [t('remote.release.confirm.allow'), t('permissionDialog.cancel')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/**
 * @typedef {{ available: boolean, paired: boolean, released: string[] }} RemoteReleaseView
 *   `available` whether releases can be kept here at all (#1012); `released` the roots open now
 */

/**
 * @param {{
 *   releases: import('../../application/ports/remote-release-port').RemoteReleasePort,
 *   pairing: { getState: () => Promise<unknown> },
 *   confirmations: import('../../application/ports/user-confirmation-port').UserConfirmationPort,
 *   normalizeRoot: (root: unknown) => string|null,
 *   getActiveWorkspaceRoot: () => string|null|undefined,
 *   listKnownWorkspaces: () => Promise<string[]>,
 *   getLocale: () => string,
 *   log?: { warn: (...args: unknown[]) => void },
 * }} deps  `normalizeRoot` the chat history's, the one the release list keeps its roots in
 */
function createRemoteReleaseSettings({
  releases,
  pairing,
  confirmations,
  normalizeRoot,
  getActiveWorkspaceRoot,
  listKnownWorkspaces,
  getLocale,
  log = console,
}) {
  async function isPaired() {
    try {
      const state = /** @type {{ state?: unknown } | null} */ (await pairing.getState());
      return state?.state === REMOTE_PAIRING_STATES.PAIRED;
    } catch {
      // A pairing that cannot be read pairs no phone.
      return false;
    }
  }

  /** @returns {Promise<RemoteReleaseView>} */
  async function getState() {
    const available = releases.isAvailable();
    const [paired, released] = await Promise.all([
      isPaired(),
      available ? releases.list().then((list) => list.map((entry) => entry.root)) : [],
    ]);
    return { available, paired, released };
  }

  /**
   * The folder the window named, when it may be switched; otherwise null.
   * @param {unknown} raw
   */
  async function knownRoot(raw) {
    const root = normalizeRoot(raw);
    if (!root) return null;
    if (normalizeRoot(getActiveWorkspaceRoot()) === root) return root;
    try {
      if ((await releases.list()).some((entry) => entry.root === root)) return root;
      const known = (await listKnownWorkspaces()) || [];
      return known.some((entry) => normalizeRoot(entry) === root) ? root : null;
    } catch (error) {
      log.warn(`[remote] the known workspaces could not be read (${error?.name || 'error'})`);
      return null;
    }
  }

  /**
   * @param {unknown} rawRoot
   * @param {unknown} open
   */
  async function setReleased(rawRoot, open) {
    if (typeof open !== 'boolean') return createSettingsError(createMessage('remote.release.error.invalid'));
    const root = await knownRoot(rawRoot);
    if (!root) return createSettingsError(createMessage('remote.release.error.unknownWorkspace'));
    try {
      if (!open) {
        await releases.withdraw(root);
        return { ...createSettingsOk(), released: false };
      }
      // Said before the dialog, so that no confirmation leads nowhere (#419).
      if (!releases.isAvailable()) return createSettingsError(createMessage('remote.release.error.encryption'));
      const outcome = await confirmations.confirm({
        action: CONFIRMATION_ACTIONS.REMOTE_WORKSPACE,
        subject: root,
        prompt: releasePrompt(root, createTranslator(getLocale())),
      });
      if (outcome?.confirmed !== true || !outcome.receipt) {
        return createSettingsError(createMessage('remote.release.error.notOpened'), 'cancelled');
      }
      const result = await releases.release(root, outcome.receipt);
      if (result.ok) return { ...createSettingsOk(), released: true };
      return createSettingsError(createMessage(result.reason === 'unavailable'
        ? 'remote.release.error.encryption'
        : 'remote.release.error.notOpened'));
    } catch (error) {
      log.warn(`[remote] the release list could not be written (${error?.name || 'error'})`);
      return createSettingsError(createMessage('remote.release.error.notSaved'));
    }
  }

  return {
    getState,
    setReleased,
    /** @param {() => void} listener */
    subscribe: (listener) => releases.subscribe(listener),
  };
}

module.exports = { createRemoteReleaseSettings, releasePrompt };
