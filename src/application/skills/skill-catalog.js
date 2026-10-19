'use strict';

// The skill catalogue as the core reads it (#1172). Types only: on the desktop
// `src/main/services/skills-service.js` is it, which scans the folders; the
// chat configuration and the model's skill suggestion take it as given.

/**
 * @typedef {Object} SkillCatalog
 * @property {(options: { workspaceRoot?: string | null, activeSkills?: string[] | null,
 *   activeWorkspaceSkills?: Record<string, string[]> | null, locale?: string | null }) =>
 *   Promise<{ skills: Array<Omit<import('../../shared/contracts/skills').SkillSummary, 'builtin'>> }>} listCatalog
 */

module.exports = {};
