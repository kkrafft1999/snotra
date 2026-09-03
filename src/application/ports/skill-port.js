/**
 * Skill-Port: eingeschaltete Skills für den Systemprompt, ohne dass der Core
 * weiß, woher sie kommen (eingebaute System-Skills oder Verzeichnisse).
 */

/**
 * @typedef {Object} ActiveSkill
 * @property {string} name
 * @property {string} description
 * @property {string} source — Wert aus SKILL_SOURCES
 * @property {string} path — Skill-Verzeichnis (bei System-Skills nur informativ)
 * @property {string} body — Markdown-Anweisungen aus der SKILL.md
 */

/**
 * @typedef {Object} SkillPort
 * @property {(options: { workspaceRoot?: string | null, activeSkills?: string[] | null })
 *   => Promise<ActiveSkill[]>} getActiveSkills
 */

module.exports = {};
