/**
 * Notices in the app window (#1001, the notice channel of #978).
 *
 * Main posts a notice as a kind plus the facts it is about; the renderer words
 * it in the interface language. Main never sends text, so a notice posted
 * before the window exists reads the same as one posted later, in whatever
 * language the window is in.
 */
'use strict';

const { isRecord } = require('../runtime/is-record');

const NOTICE_KINDS = Object.freeze({
  /** A file Snotra could not understand was moved aside; the store started afresh. */
  STORE_SET_ASIDE: 'store-set-aside',
  /** A file Snotra could not read stays as it is, so changes to it are not saved. */
  STORE_NOT_SAVED: 'store-not-saved',
  /** Errors nobody caught, in main or in the window (#978); one notice counts them all. */
  BACKGROUND_ERROR: 'background-error',
  /** The phone opened another folder at the desktop (#1194): the folder's name, never its path. */
  REMOTE_WORKSPACE_SWITCHED: 'remote-workspace-switched',
  /** Developer mode was switched on or off with its shortcut (#1213). */
  DEVELOPER_MODE: 'developer-mode',
  /** A local chat was switched to a cloud model (#1315): its next turn takes the whole chat there. */
  LOCAL_CHAT_TO_CLOUD: 'local-chat-to-cloud',
});

/** The one id of the background-error notice: a second error counts up instead of stacking. */
const BACKGROUND_ERROR_NOTICE_ID = 'background-error';
/** The one id of the phone's switch notice: a second switch replaces the first. */
const REMOTE_WORKSPACE_SWITCHED_NOTICE_ID = 'remote-workspace-switched';
/** The one id of the developer mode notice: switching again replaces it. */
const DEVELOPER_MODE_NOTICE_ID = 'developer-mode';
/** The one id of the local-chat notice: another chat switched replaces it. */
const LOCAL_CHAT_TO_CLOUD_NOTICE_ID = 'local-chat-to-cloud';
/** How long a provider's name in a notice may be. */
const NOTICE_PROVIDER_MAX = 120;
/** How long a folder's name in a notice may be. */
const NOTICE_FOLDER_MAX = 255;

/**
 * The stores that keep an unreadable file aside (#473, #557, #561, #566), by
 * file name. The id names the store in the notice's wording.
 */
const NOTICE_STORES = /** @type {Readonly<Record<string, string>>} */ (Object.freeze({
  'llm-config.json': 'models',
  'web-search-config.json': 'webSearch',
  'mcp-servers.json': 'mcpServers',
  'ui-preferences.json': 'uiPreferences',
  'folder-history.json': 'folderHistory',
  'chat-history.json': 'chatHistory',
  // The history's folder since #985, when it is set aside as a whole.
  'chat-history': 'chatHistory',
}));

/**
 * One chat's file in the history folder (#985), set aside on its own. Its
 * name is a hash of the chat's id, so it has no entry above.
 */
const CHAT_SESSION_NOTICE_STORE = 'chatSession';

/** @type {readonly string[]} */
const NOTICE_STORE_IDS = Object.freeze([...new Set([...Object.values(NOTICE_STORES), CHAT_SESSION_NOTICE_STORE])]);

/**
 * A notice as it travels to the renderer.
 *
 * A store's notice is `{ id, kind, store, file, location, canReveal }`. `id`
 * is one per file, so a second set-aside of the same file replaces the first
 * notice rather than stacking up. `location` is the full path the user may
 * want to find: the kept copy after a set-aside, the file itself while it is
 * not saved. `canReveal` says whether there is one.
 *
 * The background-error notice is `{ id, kind, count, location, canReveal }`:
 * how many errors this start has caught so far, and the log file they went to.
 *
 * The developer mode notice is `{ id, kind, on, location: null, canReveal:
 * false }` (#1213).
 *
 * The phone's switch notice is `{ id, kind, folder, location: null,
 * canReveal: false }`: the name of the folder the phone opened (#1194).
 *
 * The local-chat notice is `{ id, kind, provider, location: null, canReveal:
 * false }`: the name of the provider the chat goes to with its next turn (#1315).
 *
 * @param {unknown} input
 */
function normalizeNotice(input) {
  if (!isRecord(input)) return null;
  const { id, kind, location } = input;
  if (typeof id !== 'string' || !id) return null;
  if (!Object.values(NOTICE_KINDS).some((known) => known === kind)) return null;
  const at = typeof location === 'string' && location ? location : null;
  if (kind === NOTICE_KINDS.DEVELOPER_MODE) {
    if (typeof input.on !== 'boolean') return null;
    return { id, kind, on: input.on, location: null, canReveal: false };
  }
  if (kind === NOTICE_KINDS.REMOTE_WORKSPACE_SWITCHED) {
    const { folder } = input;
    if (typeof folder !== 'string' || !folder || folder.length > NOTICE_FOLDER_MAX) return null;
    return { id, kind, folder, location: null, canReveal: false };
  }
  if (kind === NOTICE_KINDS.LOCAL_CHAT_TO_CLOUD) {
    const { provider } = input;
    if (typeof provider !== 'string' || !provider || provider.length > NOTICE_PROVIDER_MAX) return null;
    return { id, kind, provider, location: null, canReveal: false };
  }
  if (kind === NOTICE_KINDS.BACKGROUND_ERROR) {
    const { count } = input;
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1) return null;
    return { id, kind, count, location: at, canReveal: !!at };
  }
  const { store, file } = input;
  if (typeof store !== 'string' || !NOTICE_STORE_IDS.includes(store)) return null;
  if (typeof file !== 'string' || !file) return null;
  return { id, kind, store, file, location: at, canReveal: !!at };
}

module.exports = {
  NOTICE_KINDS,
  BACKGROUND_ERROR_NOTICE_ID,
  REMOTE_WORKSPACE_SWITCHED_NOTICE_ID,
  DEVELOPER_MODE_NOTICE_ID,
  LOCAL_CHAT_TO_CLOUD_NOTICE_ID,
  NOTICE_STORES,
  NOTICE_STORE_IDS,
  CHAT_SESSION_NOTICE_STORE,
  normalizeNotice,
};
