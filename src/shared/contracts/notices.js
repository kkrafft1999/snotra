/**
 * Notices in the app window (#1001, the notice channel of #978).
 *
 * Main posts a notice as a kind plus the facts it is about; the renderer words
 * it in the interface language. Main never sends text, so a notice posted
 * before the window exists reads the same as one posted later, in whatever
 * language the window is in.
 */
'use strict';

const NOTICE_KINDS = Object.freeze({
  /** A file Snotra could not understand was moved aside; the store started afresh. */
  STORE_SET_ASIDE: 'store-set-aside',
  /** A file Snotra could not read stays as it is, so changes to it are not saved. */
  STORE_NOT_SAVED: 'store-not-saved',
});

/**
 * The stores that keep an unreadable file aside (#473, #557, #561, #566), by
 * file name. The id names the store in the notice's wording.
 */
const NOTICE_STORES = Object.freeze({
  'llm-config.json': 'models',
  'web-search-config.json': 'webSearch',
  'mcp-servers.json': 'mcpServers',
  'ui-preferences.json': 'uiPreferences',
  'folder-history.json': 'folderHistory',
  'chat-history.json': 'chatHistory',
});

const NOTICE_STORE_IDS = Object.freeze([...new Set(Object.values(NOTICE_STORES))]);

/**
 * A notice as it travels to the renderer: `{ id, kind, store, file, location,
 * canReveal }`. `id` is one per file, so a second set-aside of the same file
 * replaces the first notice rather than stacking up. `location` is the full
 * path the user may want to find: the kept copy after a set-aside, the file
 * itself while it is not saved. `canReveal` says whether there is one.
 */
function normalizeNotice(input) {
  if (!input || typeof input !== 'object') return null;
  const { id, kind, store, file, location } = input;
  if (typeof id !== 'string' || !id) return null;
  if (!Object.values(NOTICE_KINDS).includes(kind)) return null;
  if (!NOTICE_STORE_IDS.includes(store)) return null;
  if (typeof file !== 'string' || !file) return null;
  const at = typeof location === 'string' && location ? location : null;
  return { id, kind, store, file, location: at, canReveal: !!at };
}

module.exports = {
  NOTICE_KINDS,
  NOTICE_STORES,
  NOTICE_STORE_IDS,
  normalizeNotice,
};
