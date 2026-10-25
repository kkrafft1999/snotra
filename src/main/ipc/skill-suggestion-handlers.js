'use strict';

const { SKILL_SUGGESTION_MODES } = require('../../shared/contracts/enums');

/**
 * A skill suggested by the model (#125, mode `model`). It runs next to the
 * chat and must never get in its way: every failure ends as "no suggestion".
 *
 * @param {object} deps
 * @param {import('./trusted-sender').GuardedIpcMain} deps.ipcMain
 * @param {Pick<ReturnType<typeof import('../../application/skills/skill-suggestion-service').createSkillSuggestionService>, 'suggest'>} deps.skillSuggestionService
 * @param {import('../ports/ui-prefs-store-port').UiPrefsStorePort} deps.uiPrefsStore
 * @param {Record<string, string>} deps.REQ
 */
function registerSkillSuggestionHandlers({ ipcMain, skillSuggestionService, uiPrefsStore, REQ }) {
  ipcMain.handle(REQ.SKILLS_SUGGEST, async (_event, text, chatId) => {
    // Only in the mode switched on for it does this reach the provider at
    // all — the renderer could claim the opposite.
    const prefs = await uiPrefsStore.readUIPrefs();
    if (prefs.skillSuggestionMode !== SKILL_SUGGESTION_MODES.MODEL) return { name: '' };
    try {
      const match = await skillSuggestionService.suggest(
        typeof text === 'string' ? text : '',
        // The chat the question is typed in pays for the round (#1266).
        { chatId: typeof chatId === 'string' && chatId ? chatId : undefined }
      );
      return { name: match?.name || '' };
    } catch {
      return { name: '' };
    }
  });
}

module.exports = { registerSkillSuggestionHandlers };
