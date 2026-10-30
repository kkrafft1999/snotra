'use strict';

/**
 * The usage report (#1258), built from the history's index alone: every
 * chat's cost with its days sits in its index entry (#985), so no chat file
 * is opened, however long the history. The report is the history as it is —
 * a deleted chat, or one dropped beyond the limit, no longer counts.
 */

const { buildUsageReport } = require('../../shared/contracts/usage-report');

/**
 * @param {object} deps
 * @param {Pick<import('../ports/chat-history-store-port').ChatHistoryStorePort, 'listSessions' | 'MAX_CHAT_SESSIONS'>} deps.chatHistoryStore
 * @param {(providerId: string) => string|import('../../shared/contracts/message').Message|null|undefined} [deps.providerName]
 *   the provider's name as the settings show it; a descriptor where it is translated
 */
function createUsageReportService({ chatHistoryStore, providerName = () => null }) {
  /**
   * @param {{ providerId: string, providerName?: string|import('../../shared/contracts/message').Message }} part
   */
  function name(part) {
    part.providerName = providerName(part.providerId) || part.providerId;
  }

  /**
   * @param {{ from: string|null, to: string|null }} period
   * @returns {Promise<import('../../shared/contracts/usage-report').UsageReport>}
   */
  async function report(period) {
    const chats = await chatHistoryStore.listSessions();
    const result = buildUsageReport(chats, period, { maxChats: chatHistoryStore.MAX_CHAT_SESSIONS });
    for (const model of result.models) name(model);
    for (const workspace of result.workspaces) workspace.models.forEach(name);
    for (const kind of result.taskKinds) kind.models.forEach(name);
    for (const chat of result.chats) chat.models.forEach(name);
    return result;
  }

  return { report };
}

module.exports = { createUsageReportService };
