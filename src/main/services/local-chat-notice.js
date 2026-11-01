'use strict';

/**
 * The notice when a local chat is switched to a cloud model (#1315,
 * decision 13). A chat whose turns all ran on this computer stays local; its
 * first turn on a cloud model sends the whole history to that provider and
 * opens the chat for good. Snotra says so once, at the switch, before
 * anything is sent — in the notice strip, like the other things that happen
 * once (`app-notices.js`).
 *
 * One notice at a time, for the chat on screen: switching that chat back to a
 * local model, opening another chat or sending the turn takes it back.
 */

const { NOTICE_KINDS, LOCAL_CHAT_TO_CLOUD_NOTICE_ID } = require('../../shared/contracts/notices');
const { CHAT_LOCALITY } = require('./chat-history-normalization');

/**
 * @param {object} deps
 * @param {{ post: (input: unknown) => unknown, withdraw: (id: string) => boolean }} deps.notices
 * @param {{ getSessionMeta: (id: string) => Promise<{ locality?: string }|null> }} deps.chatHistoryStore
 * @param {(presetId: string|null) => Promise<{ runsLocally: boolean, providerName?: unknown }|null>} deps.describeModel
 * @param {(name: unknown) => string} deps.providerLabel  the provider's name in the interface language
 * @param {{ warn?: (message: string) => void }|null} [deps.log]
 */
function createLocalChatNotice({ notices, chatHistoryStore, describeModel, providerLabel, log = console }) {
  /** The chat the notice is up for, if any. */
  /** @type {string|null} */
  let shownFor = null;

  function withdraw() {
    if (shownFor === null) return;
    shownFor = null;
    notices.withdraw(LOCAL_CHAT_TO_CLOUD_NOTICE_ID);
  }

  /**
   * Whether the chat has run on this computer alone so far. A chat saved
   * before #1315 has no marker: it was local when the model it is switched
   * away from is.
   *
   * @param {{ locality?: string }|null} meta
   * @param {string|null} previousPresetId
   */
  async function wasLocal(meta, previousPresetId) {
    // Not saved yet: nothing has been said, so nothing goes anywhere.
    if (!meta || meta.locality === CHAT_LOCALITY.CLOUD) return false;
    if (meta.locality === CHAT_LOCALITY.LOCAL) return true;
    if (!previousPresetId) return false;
    return (await describeModel(previousPresetId))?.runsLocally === true;
  }

  /**
   * The chat on screen got another model entry by an explicit choice.
   *
   * @param {{ chatId: string|null, presetId: string, previousPresetId: string|null }} change
   */
  async function presetChosen({ chatId, presetId, previousPresetId }) {
    if (!chatId || !presetId || presetId === previousPresetId) return;
    try {
      const next = await describeModel(presetId);
      if (!next || next.runsLocally) {
        if (shownFor === chatId) withdraw();
        return;
      }
      if (!(await wasLocal(await chatHistoryStore.getSessionMeta(chatId), previousPresetId))) return;
      const provider = providerLabel(next.providerName).trim();
      if (!provider) return;
      notices.post({ id: LOCAL_CHAT_TO_CLOUD_NOTICE_ID, kind: NOTICE_KINDS.LOCAL_CHAT_TO_CLOUD, provider });
      shownFor = chatId;
    } catch (error) {
      // The switch stands; only the notice is missing.
      log?.warn?.(`[local-chat-notice] could not tell whether the chat was local: ${error?.message || error}`);
    }
  }

  /**
   * Another chat came on screen, or this one's turn went out: the notice is
   * no longer about what is in front of the user.
   *
   * @param {string|null} chatId  the chat on screen now, or the one whose turn went out
   * @param {{ sent?: boolean }} [options]
   */
  function chatChanged(chatId, { sent = false } = {}) {
    if (shownFor === null) return;
    if (sent ? shownFor === chatId : shownFor !== chatId) withdraw();
  }

  return { presetChosen, chatChanged };
}

module.exports = { createLocalChatNotice };
