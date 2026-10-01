'use strict';

const { SKILL_SUGGESTION_MODES } = require('../../shared/contracts/enums');

/**
 * A skill suggested by the model (#125, mode `model`). It runs next to the
 * chat and must never get in its way: every failure ends as "no suggestion".
 */
function registerSkillSuggestionHandlers({ ipcMain, skillSuggestionService, uiPrefsStore, REQ }) {
  ipcMain.handle(REQ.SKILLS_SUGGEST, async (_event, text) => {
    // Only in the mode switched on for it does this reach the provider at
    // all — the renderer could claim the opposite.
    const prefs = await uiPrefsStore.readUIPrefs();
    if (prefs.skillSuggestionMode !== SKILL_SUGGESTION_MODES.MODEL) return { name: '' };
    try {
      const match = await skillSuggestionService.suggest(typeof text === 'string' ? text : '');
      return { name: match?.name || '' };
    } catch {
      return { name: '' };
    }
  });
}

module.exports = { registerSkillSuggestionHandlers };
