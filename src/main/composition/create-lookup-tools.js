'use strict';

const path = require('path');
const { readFileSync } = require('fs');
const { createManualLookup, loadVendoredMarkedLexer } = require('../services/manual-lookup');
const { createReleaseNotesService } = require('../services/release-notes-service');
const { createChatSearchService } = require('../services/chat-search-service');
const { createLocalChatNotice } = require('../services/local-chat-notice');

/** The marked the help window runs, which the model's look into the manual reuses (#947). */
const MARKED_VENDOR_FILE = path.join(__dirname, '..', '..', 'renderer', 'vendor', 'marked.umd.js');

/**
 * What the read tools look things up in, for `createCore()`: the manual
 * (#947), the release notes (#1191) and the earlier chats of the open folder
 * (#1315) — with the two pieces that keep a local chat local next to the
 * search: the marker at the first cloud turn and the notice at the switch.
 *
 * Wiring only; the rules live in the services.
 *
 * @param {object} deps
 * @param {ReturnType<typeof import('../services/manual-service').createManualService> | null} deps.manual  the bundled manual, if any
 * @param {typeof fetch} deps.fetchImpl
 * @param {() => string} deps.getAppVersion
 * @param {() => string} deps.getAppLocale
 * @param {import('../ports/chat-history-store-port').ChatHistoryStorePort} deps.chatHistoryStore
 * @param {Parameters<typeof createLocalChatNotice>[0]['notices']} deps.notices
 * @param {(presetId: string|null) => Promise<{ runsLocally: boolean, providerName?: unknown }|null>} deps.describeModel
 * @param {(name: unknown) => string} deps.providerLabel
 * @param {(chatId: string) => Promise<unknown>} deps.markCloudTurn  the history's marker (#1315)
 */
function createLookupTools({
  manual, fetchImpl, getAppVersion, getAppLocale, chatHistoryStore, notices, describeModel, providerLabel, markCloudTurn,
}) {
  const localChatNotice = createLocalChatNotice({ notices, chatHistoryStore, describeModel, providerLabel });
  return {
    manual: manual
      ? createManualLookup({ manual, loadLexer: () => loadVendoredMarkedLexer(MARKED_VENDOR_FILE, { readFileSync }) })
      : null,
    // What the releases changed for the user (#1191): the public list on GitHub.
    releaseNotes: createReleaseNotesService({ fetchImpl, getCurrentVersion: getAppVersion, getLocale: getAppLocale }),
    chats: createChatSearchService({ chatHistoryStore, describeModel }),
    localChatNotice,
    /**
     * A turn goes to a cloud model: the chat is marked first, then the notice
     * about it has done its job.
     *
     * @param {string} chatId
     */
    async cloudTurn(chatId) {
      await markCloudTurn(chatId);
      localChatNotice.chatChanged(chatId, { sent: true });
    },
  };
}

module.exports = { createLookupTools };
