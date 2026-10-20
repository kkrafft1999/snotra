/**
 * RemoteRelease port (#1194): the release list of `docs/remote-interface.md`
 * §7.5 — which workspaces a remote front end may see, each under a
 * `workspaceId` that is stable for a known folder and gives nothing of its
 * path away.
 *
 * Opening a workspace is a loosening: its chats become readable on the
 * paired phone. The adapter takes a release only with a receipt of the
 * user-confirmation port (#980, action `remote-workspace`, subject the root);
 * withdrawing one needs none. The switch that asks for it is #1195.
 */

/**
 * @typedef {Object} RemoteRelease
 * @property {string} workspaceId  128 random bits, base64url; kept for the folder while it is known
 * @property {string} root  the folder, as the chat history names it
 */

/**
 * @typedef {{ ok: true, release: RemoteRelease } | { ok: false, reason: 'unconfirmed' | 'unavailable' | 'invalid' }} RemoteReleaseResult
 */

/**
 * @typedef {Object} RemoteReleasePort
 * @property {() => boolean} isAvailable  whether releases can be kept at all — not without real encryption
 * @property {() => Promise<RemoteRelease[]>} list  the workspaces opened, in the order they were opened
 * @property {(root: string, confirmation: unknown) => Promise<RemoteReleaseResult>} release
 *   opens a workspace; `confirmation` the receipt of the user-confirmation port
 * @property {(root: string) => Promise<void>} withdraw  closes a workspace again; its id stays for the folder
 * @property {(listener: () => void) => () => void} subscribe  told after every change
 */

module.exports = {};
