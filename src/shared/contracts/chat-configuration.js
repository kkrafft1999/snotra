'use strict';

/**
 * Which skills and tools a chat has (#773): the indicator at the composer and
 * the model's `get_configuration` read the same description, so both name the
 * same reason and point to the same settings page.
 */

const { SKILL_SOURCES } = require('./skills');
const { isRecord } = require('../runtime/is-record');

/**
 * Where the user changes a setting: a `{menu:…}` name of `ui-quotes.js`, the
 * settings panel, and the heading it opens on.
 *
 * @typedef {Object} SettingsPlace
 * @property {string} menu
 * @property {string} panel
 * @property {string|null} target
 */

/**
 * One switch a proposal asks for.
 *
 * @typedef {Object} ConfigProposalChange
 * @property {string} kind  a `CONFIG_PROPOSAL_KINDS` value
 * @property {string} name
 * @property {boolean} enable
 */

/** The model's read-only view of the configuration. */
const GET_CONFIGURATION_TOOL = 'get_configuration';

/**
 * The model's way to ask for a change (#774): a card the user confirms, for
 * the one chat. The model never switches anything itself.
 */
const PROPOSE_CONFIG_CHANGE_TOOL = 'propose_config_change';

/** What a proposal can switch. */
const CONFIG_PROPOSAL_KINDS = Object.freeze({ SKILL: 'skill', TOOL: 'tool' });

/** The model's reason travels to the card as its own text, cut to this. */
const MAX_PROPOSAL_REASON_CHARS = 300;

/** A chat holds at most this many names per list — a bound, not a budget. */
const MAX_CHAT_OVERRIDE_NAMES = 64;

/**
 * Descriptions are cut to this length, like in the skill suggestion: a folder
 * skill's description is third-party text and goes to the model as data.
 */
const MAX_CONFIG_DESCRIPTION_CHARS = 200;

const CONFIG_SKILL_STATES = Object.freeze({
  ON: 'on',
  OFF: 'off',
  /** Its SKILL.md cannot be read; the settings say why. */
  INVALID: 'invalid',
});

/** Why a tool is not offered to the model. `null` means it is. */
const TOOL_OFFER_REASONS = Object.freeze({
  /** Unticked under Settings › Tools › Autonomy. */
  SWITCHED_OFF: 'switchedOff',
  /** Something it needs is missing — see its setup. */
  NOT_CONFIGURED: 'notConfigured',
  /** A file tool without an open folder. */
  NO_FOLDER: 'noFolder',
  /** `load_skill` with no skill switched on. */
  NO_SKILL: 'noSkill',
  /** `load_rule` with no rules file to load (#1275). */
  NO_RULE: 'noRule',
  /** Outside a caller's allowlist — a test or a mode, never a setting. */
  NOT_ALLOWED: 'notAllowed',
});

/** What a tool that is not configured needs. */
const TOOL_SETUPS = Object.freeze({
  PYTHON_SWITCH: 'pythonSwitch',
  PYTHON: 'python',
  SHELL_SWITCH: 'shellSwitch',
  SHELL: 'shell',
  WEB_SEARCH: 'webSearch',
  IMAGE_GENERATION: 'imageGeneration',
  MCP: 'mcp',
});

/**
 * Where the user changes it, as a `{menu:…}` name of `ui-quotes.js` plus the
 * heading the settings open on. Setups that no setting fixes (no shell on
 * the system) have none.
 *
 * @type {Readonly<Record<string, SettingsPlace>>}
 */
const SETUP_PLACES = Object.freeze({
  [TOOL_SETUPS.PYTHON_SWITCH]: { menu: 'settings.security', panel: 'security', target: null },
  [TOOL_SETUPS.SHELL_SWITCH]: { menu: 'settings.security', panel: 'security', target: null },
  [TOOL_SETUPS.PYTHON]: { menu: 'settings.tools', panel: 'tools', target: 'heading-python' },
  [TOOL_SETUPS.WEB_SEARCH]: { menu: 'settings.tools', panel: 'tools', target: 'heading-web-search' },
  [TOOL_SETUPS.IMAGE_GENERATION]: { menu: 'settings.tools', panel: 'tools', target: 'heading-image-generation' },
  [TOOL_SETUPS.MCP]: { menu: 'settings.tools', panel: 'tools', target: 'heading-mcp-servers' },
});

/** @type {SettingsPlace} */
const SWITCHED_OFF_PLACE = Object.freeze({ menu: 'settings.security', panel: 'security', target: null });
/** @type {SettingsPlace} */
const SKILLS_PLACE = Object.freeze({ menu: 'settings.skills', panel: 'skills', target: null });

/**
 * The settings page that changes a tool's state, or `null` when no setting
 * does — a missing folder is opened, not configured.
 *
 * @param {{ reason?: string | null, setup?: string | null }} [offer]
 * @returns {SettingsPlace|null}
 */
function toolSettingsPlace({ reason = null, setup = null } = {}) {
  if (reason === TOOL_OFFER_REASONS.SWITCHED_OFF) return SWITCHED_OFF_PLACE;
  if (reason === TOOL_OFFER_REASONS.NOT_CONFIGURED) return (setup && SETUP_PLACES[setup]) || null;
  return null;
}

/** The groups the tools that are on are summed up in. */
const CONFIG_TOOL_GROUPS = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  EXEC: 'exec',
  WEB: 'web',
  IMAGE: 'image',
  MCP: 'mcp',
  OTHER: 'other',
});

/**
 * Whether a value is one of the groups; a descriptor names its own (#1008).
 *
 * @param {unknown} value
 */
function isConfigToolGroup(value) {
  return Object.values(CONFIG_TOOL_GROUPS).some((group) => group === value);
}

/**
 * The three places a skill comes from, as the model is told.
 *
 * @param {unknown} source
 * @returns {'system'|'folder'|'user'}
 */
function skillOrigin(source) {
  if (source === SKILL_SOURCES.SYSTEM) return 'system';
  if (source === SKILL_SOURCES.WORKSPACE_AGENTS) return 'folder';
  return 'user';
}

/**
 * Cut a description for the model and the popover, at a word where one is near.
 *
 * @param {unknown} text
 * @param {number} [max]
 */
function clipConfigDescription(text, max = MAX_CONFIG_DESCRIPTION_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** @type {Array<'tools'|'skills'>} */
const OVERRIDE_KINDS = ['tools', 'skills'];

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function cleanOverrideNames(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {string[]} */
  const names = raw
    .filter((name) => typeof name === 'string' && name.trim() && name.length <= 128)
    .map((name) => name.trim());
  return [...new Set(names)].slice(0, MAX_CHAT_OVERRIDE_NAMES);
}

/**
 * What one chat switched beyond the settings (#774): skills and tools on or
 * off for this chat only, and the proposals the user declined in it. Empty
 * lists are left out, and an empty result is `null` — a chat without
 * changes carries nothing.
 *
 * @typedef {Object} ChatConfigOverrides
 * @property {{ on?: string[], off?: string[] }} [tools]
 * @property {{ on?: string[], off?: string[] }} [skills]
 * @property {string[]} [declined]  `proposalKey`s of the proposals the user declined
 *
 * @param {unknown} raw  anything; only an object can pass
 * @returns {ChatConfigOverrides|null}
 */
function normalizeChatConfigOverrides(raw) {
  if (!isRecord(raw)) return null;
  /** @type {ChatConfigOverrides} */
  const out = {};
  for (const kind of OVERRIDE_KINDS) {
    const lists = isRecord(raw[kind]) ? raw[kind] : {};
    const on = cleanOverrideNames(lists.on);
    const off = cleanOverrideNames(lists.off).filter((name) => !on.includes(name));
    if (on.length || off.length) {
      /** @type {{ on?: string[], off?: string[] }} */
      const entry = {};
      if (on.length) entry.on = on;
      if (off.length) entry.off = off;
      out[kind] = entry;
    }
  }
  const declined = cleanOverrideNames(raw.declined);
  if (declined.length) out.declined = declined;
  return Object.keys(out).length ? out : null;
}

/**
 * The key a declined proposal is remembered by: same kind, name and direction.
 *
 * @param {ConfigProposalChange} proposal
 */
function proposalKey({ kind, name, enable }) {
  return `${kind}:${enable ? 'on' : 'off'}:${name}`;
}

/**
 * The tools switched off in a chat: the settings' list, without what the chat
 * switched on and with what it switched off.
 *
 * @param {unknown} disabledTools
 * @param {ChatConfigOverrides|null|undefined} overrides
 * @returns {string[]}
 */
function effectiveDisabledTools(disabledTools, overrides) {
  const base = Array.isArray(disabledTools) ? disabledTools : [];
  const on = new Set(overrides?.tools?.on || []);
  const off = overrides?.tools?.off || [];
  return [...new Set([...base.filter((name) => !on.has(name)), ...off])];
}

/**
 * The overrides after one accepted proposal. Switching back to what the
 * settings say drops the entry instead of recording it twice.
 *
 * @param {unknown} overrides
 * @param {ConfigProposalChange} proposal
 * @returns {ChatConfigOverrides|null}
 */
function applyConfigProposal(overrides, { kind, name, enable }) {
  const key = kind === CONFIG_PROPOSAL_KINDS.SKILL ? 'skills' : 'tools';
  const current = normalizeChatConfigOverrides(overrides) || {};
  const lists = { on: [...(current[key]?.on || [])], off: [...(current[key]?.off || [])] };
  const add = enable ? 'on' : 'off';
  const drop = enable ? 'off' : 'on';
  if (lists[drop].includes(name)) lists[drop] = lists[drop].filter((entry) => entry !== name);
  else if (!lists[add].includes(name)) lists[add].push(name);
  return normalizeChatConfigOverrides({ ...current, [key]: lists });
}

/**
 * The overrides with one more declined proposal.
 *
 * @param {unknown} overrides
 * @param {ConfigProposalChange} proposal
 * @returns {ChatConfigOverrides|null}
 */
function declineConfigProposal(overrides, proposal) {
  const current = normalizeChatConfigOverrides(overrides) || {};
  return normalizeChatConfigOverrides({ ...current, declined: [...(current.declined || []), proposalKey(proposal)] });
}

module.exports = {
  GET_CONFIGURATION_TOOL,
  PROPOSE_CONFIG_CHANGE_TOOL,
  CONFIG_PROPOSAL_KINDS,
  MAX_PROPOSAL_REASON_CHARS,
  MAX_CHAT_OVERRIDE_NAMES,
  normalizeChatConfigOverrides,
  proposalKey,
  effectiveDisabledTools,
  applyConfigProposal,
  declineConfigProposal,
  MAX_CONFIG_DESCRIPTION_CHARS,
  CONFIG_SKILL_STATES,
  TOOL_OFFER_REASONS,
  TOOL_SETUPS,
  CONFIG_TOOL_GROUPS,
  SKILLS_PLACE,
  toolSettingsPlace,
  isConfigToolGroup,
  skillOrigin,
  clipConfigDescription,
};
