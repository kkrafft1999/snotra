'use strict';

/**
 * Which skills are switched on, and what the settings' ticks become when
 * they are stored (#576, #982). The rule a second front end needs as it is:
 * finding the skills on disk is `src/main/services/skills-service.js`'s, and
 * it hands the scanned skills in.
 *
 * A switch-on is bound to where it was made: the global list switches on
 * system and global skills only, and a workspace skill only through its own
 * folder's list. A name alone would hand the user's choice to any skill that
 * happens to win the name — a cloned repository with `.agents/skills/<name>`
 * would take over the user's own global skill.
 *
 * The folder's key is the resolved workspace root, `''` without one; the
 * caller resolves it, since only it knows the platform's paths.
 */

const { SKILL_SOURCES, SKILL_STATUS } = require('../../shared/contracts/skills');

/**
 * A skill as the scan keeps it, with its body (the catalogue leaves it out).
 *
 * @typedef {Object} ScannedSkill
 * @property {string} name
 * @property {string} description
 * @property {import('../../shared/contracts/skills').SkillSource} source
 * @property {import('../../shared/contracts/skills').SkillStatus} status
 * @property {string} path  the skill's folder
 * @property {string|import('../../shared/contracts/message').Message} detail
 * @property {string} body
 * @property {boolean} [truncated]  the body was cut at the limit
 */

/**
 * Which skills are switched on: the global list and, per folder, that
 * folder's own.
 *
 * @typedef {Object} SkillSelection
 * @property {string} workspaceKey  the resolved workspace root; `''` without one
 * @property {string[]|null} [activeSkills]  `null` means the default set
 * @property {Record<string, string[]>|null} [activeWorkspaceSkills]
 */

/**
 * Voreinstellung: System-Skills sind an, Ordner-Skills nicht. Ordner-Skills
 * sind fremder Inhalt (Prompt-Injection) und werden nur nach ausdrücklicher
 * Auswahl in den Systemprompt übernommen.
 *
 * @param {ScannedSkill[]} skills
 */
function defaultActiveNames(skills) {
  return skills
    .filter((skill) => skill.source === SKILL_SOURCES.SYSTEM && skill.status !== SKILL_STATUS.INVALID)
    .map((skill) => skill.name);
}

/**
 * @param {ScannedSkill[]} skills
 * @param {string[]|null|undefined} activeSkills
 */
function resolveActiveNames(skills, activeSkills) {
  return Array.isArray(activeSkills) ? activeSkills : defaultActiveNames(skills);
}

/**
 * The names switched on for this folder's own skills (#576).
 *
 * @param {string} workspaceKey
 * @param {Record<string, string[]>|null|undefined} activeWorkspaceSkills
 */
function workspaceActiveNames(workspaceKey, activeWorkspaceSkills) {
  if (!workspaceKey || !activeWorkspaceSkills || typeof activeWorkspaceSkills !== 'object') return [];
  if (!Object.prototype.hasOwnProperty.call(activeWorkspaceSkills, workspaceKey)) return [];
  const names = activeWorkspaceSkills[workspaceKey];
  return Array.isArray(names) ? names : [];
}

/**
 * Which skills are switched on here.
 *
 * @param {ScannedSkill[]} skills
 * @param {SkillSelection} selection
 * @returns {(skill: ScannedSkill) => boolean}
 */
function switchedOn(skills, { workspaceKey, activeSkills, activeWorkspaceSkills }) {
  const global = new Set(resolveActiveNames(skills, activeSkills));
  const workspace = new Set(workspaceActiveNames(workspaceKey, activeWorkspaceSkills));
  return (skill) =>
    skill.status === SKILL_STATUS.AVAILABLE
    && (skill.source === SKILL_SOURCES.WORKSPACE_AGENTS ? workspace : global).has(skill.name);
}

/**
 * The skills whose bodies go into the prompt — in the order of the scan,
 * which is the order of source priority. `invokedSkills` are the ones called
 * with `/name` in the chat (#124): they come on top of the lasting selection,
 * for this conversation only, and say so.
 *
 * @param {ScannedSkill[]} skills
 * @param {SkillSelection & { invokedSkills?: string[]|null }} selection
 * @returns {Array<{ skill: ScannedSkill, invoked: boolean }>}
 */
function selectActiveSkills(skills, { invokedSkills = null, ...selection }) {
  const isOn = switchedOn(skills, selection);
  const invoked = new Set(Array.isArray(invokedSkills) ? invokedSkills : []);
  return skills
    .filter((skill) => skill.status === SKILL_STATUS.AVAILABLE && (isOn(skill) || invoked.has(skill.name)))
    .map((skill) => ({ skill, invoked: invoked.has(skill.name) && !isOn(skill) }));
}

/**
 * Turn the ticks the settings show for the open folder into what is stored
 * (#576). `selected` is the names ticked in this catalogue; each is bound to
 * the skill that is usable here — a workspace skill to this folder's list,
 * anything else to the global one.
 *
 * What this catalogue cannot see stays as it was: another folder's list,
 * and a global name whose skill is shadowed or missing here. Otherwise
 * saving in a folder whose own skill shadows a global one would switch the
 * global one off everywhere.
 *
 * @param {ScannedSkill[]} skills
 * @param {SkillSelection & { selected?: string[] }} selection
 * @returns {{ activeSkills: string[], activeWorkspaceSkills: Record<string, string[]> }}
 */
function bindSkillSelection(skills, { workspaceKey, selected = [], activeSkills = null, activeWorkspaceSkills = null }) {
  const chosen = new Set(Array.isArray(selected) ? selected : []);
  const usable = skills.filter((skill) => skill.status === SKILL_STATUS.AVAILABLE);
  const isWorkspace = (/** @type {ScannedSkill} */ skill) => skill.source === SKILL_SOURCES.WORKSPACE_AGENTS;
  const decidedHere = new Set(usable.filter((skill) => !isWorkspace(skill)).map((skill) => skill.name));

  const global = resolveActiveNames(skills, activeSkills).filter((name) => !decidedHere.has(name));
  for (const skill of usable) {
    if (!isWorkspace(skill) && chosen.has(skill.name)) global.push(skill.name);
  }

  /** @type {Record<string, string[]>} */
  const perFolder = {};
  if (activeWorkspaceSkills && typeof activeWorkspaceSkills === 'object') {
    for (const [root, names] of Object.entries(activeWorkspaceSkills)) perFolder[root] = names;
  }
  if (workspaceKey) {
    const names = usable.filter((skill) => isWorkspace(skill) && chosen.has(skill.name)).map((skill) => skill.name);
    if (names.length > 0) perFolder[workspaceKey] = names;
    else delete perFolder[workspaceKey];
  }
  return { activeSkills: [...new Set(global)], activeWorkspaceSkills: perFolder };
}

/**
 * The switch-on of a skill that left the open folder (#764). A workspace
 * skill is switched on per folder (#576); once global, its switch is the
 * global list. A skill that was on here stays on — now everywhere, which is
 * what making it global asks for. One that was off stays off. `null` when
 * nothing changes.
 *
 * @param {ScannedSkill[]} skills
 * @param {SkillSelection & { name?: string }} selection
 * @returns {{ activeSkills: string[], activeWorkspaceSkills: Record<string, string[]> } | null}
 */
function switchOnGlobally(skills, { workspaceKey, name, activeSkills = null, activeWorkspaceSkills = null }) {
  if (!workspaceKey || typeof name !== 'string' || !workspaceActiveNames(workspaceKey, activeWorkspaceSkills).includes(name)) return null;
  const perFolder = { ...activeWorkspaceSkills };
  const rest = perFolder[workspaceKey].filter((entry) => entry !== name);
  if (rest.length > 0) perFolder[workspaceKey] = rest;
  else delete perFolder[workspaceKey];
  const global = [...new Set([...resolveActiveNames(skills, activeSkills), name])];
  return { activeSkills: global, activeWorkspaceSkills: perFolder };
}

module.exports = {
  defaultActiveNames,
  workspaceActiveNames,
  switchedOn,
  selectActiveSkills,
  bindSkillSelection,
  switchOnGlobally,
};
