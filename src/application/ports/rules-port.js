/**
 * Rules port (#1275): the rules files the chat core lists in the prompt and
 * `load_rule` reads. Where they lie — the open folder, the home folder — is
 * runtime knowledge and stays behind this port.
 *
 * Missing folders are the normal case, not an error: the adapter answers with
 * an empty list.
 */

/**
 * @typedef {Object} RulesListing
 * @property {import('../../shared/contracts/rules').RuleFile[]} files  in reading order
 * @property {Partial<Record<import('../../shared/contracts/rules').RuleSource, number>>} inSubfolders
 *   `.md` files in subfolders, which are not read — reported in the settings
 * @property {Partial<Record<import('../../shared/contracts/rules').RuleSource, number>>} overLimit
 *   files past the limit of a source, not read either
 */

/**
 * @typedef {Object} RulesPort
 * @property {(options: { workspaceRoot?: string|null }) => Promise<RulesListing>} load
 * @property {(options: { workspaceRoot?: string|null, name: string, level: string }) =>
 *   Promise<import('../../shared/contracts/rules').RuleFile|null>} loadRule
 *   the rule of that name at that level, the first hit of the level's sources
 */

module.exports = {};
