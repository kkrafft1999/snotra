'use strict';

/**
 * Which skills and tools a chat has (#773): the indicator at the composer and
 * the model's `get_configuration` read the same description, so both name the
 * same reason and point to the same settings page.
 */

const { SKILL_SOURCES } = require('./skills');
const { TOOL_CATEGORIES, toolCategory } = require('./tool-categories');

/** The model's read-only view of the configuration. */
const GET_CONFIGURATION_TOOL = 'get_configuration';

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
  /** Unticked under Settings › Tools & security. */
  SWITCHED_OFF: 'switchedOff',
  /** Something it needs is missing — see its setup. */
  NOT_CONFIGURED: 'notConfigured',
  /** A file tool without an open folder. */
  NO_FOLDER: 'noFolder',
  /** `load_skill` with no skill switched on. */
  NO_SKILL: 'noSkill',
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
 */
const SETUP_PLACES = Object.freeze({
  [TOOL_SETUPS.PYTHON_SWITCH]: { menu: 'settings.security', panel: 'security', target: null },
  [TOOL_SETUPS.SHELL_SWITCH]: { menu: 'settings.security', panel: 'security', target: null },
  [TOOL_SETUPS.PYTHON]: { menu: 'settings.tools', panel: 'tools', target: 'heading-python' },
  [TOOL_SETUPS.WEB_SEARCH]: { menu: 'settings.tools', panel: 'tools', target: 'heading-web-search' },
  [TOOL_SETUPS.IMAGE_GENERATION]: { menu: 'settings.tools', panel: 'tools', target: 'heading-image-generation' },
  [TOOL_SETUPS.MCP]: { menu: 'settings.tools', panel: 'tools', target: 'heading-mcp-servers' },
});

const SWITCHED_OFF_PLACE = Object.freeze({ menu: 'settings.security', panel: 'security', target: null });
const SKILLS_PLACE = Object.freeze({ menu: 'settings.skills', panel: 'skills', target: null });

/**
 * The settings page that changes a tool's state, or `null` when no setting
 * does — a missing folder is opened, not configured.
 */
function toolSettingsPlace({ reason = null, setup = null } = {}) {
  if (reason === TOOL_OFFER_REASONS.SWITCHED_OFF) return SWITCHED_OFF_PLACE;
  if (reason === TOOL_OFFER_REASONS.NOT_CONFIGURED) return SETUP_PLACES[setup] || null;
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

const GROUP_BY_CATEGORY = Object.freeze({
  [TOOL_CATEGORIES.READ]: CONFIG_TOOL_GROUPS.READ,
  [TOOL_CATEGORIES.SEARCH]: CONFIG_TOOL_GROUPS.READ,
  [TOOL_CATEGORIES.LIST]: CONFIG_TOOL_GROUPS.READ,
  [TOOL_CATEGORIES.CHECK]: CONFIG_TOOL_GROUPS.READ,
  [TOOL_CATEGORIES.WRITE]: CONFIG_TOOL_GROUPS.WRITE,
  [TOOL_CATEGORIES.EXEC]: CONFIG_TOOL_GROUPS.EXEC,
  [TOOL_CATEGORIES.IMAGE]: CONFIG_TOOL_GROUPS.IMAGE,
});

/** The tool log files these under "other"; here they are what they are. */
const GROUP_BY_TOOL = Object.freeze({
  web_search: CONFIG_TOOL_GROUPS.WEB,
  fetch_url: CONFIG_TOOL_GROUPS.WEB,
  [GET_CONFIGURATION_TOOL]: CONFIG_TOOL_GROUPS.READ,
});

/** The group a tool is summed up in; an MCP tool goes by its server. */
function toolConfigGroup(name, { mcpServer = null } = {}) {
  if (mcpServer) return CONFIG_TOOL_GROUPS.MCP;
  return GROUP_BY_TOOL[name] || GROUP_BY_CATEGORY[toolCategory(name)] || CONFIG_TOOL_GROUPS.OTHER;
}

/** The three places a skill comes from, as the model is told. */
function skillOrigin(source) {
  if (source === SKILL_SOURCES.SYSTEM) return 'system';
  if (source === SKILL_SOURCES.WORKSPACE_AGENTS) return 'folder';
  return 'user';
}

/** Cut a description for the model and the popover, at a word where one is near. */
function clipConfigDescription(text, max = MAX_CONFIG_DESCRIPTION_CHARS) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

module.exports = {
  GET_CONFIGURATION_TOOL,
  MAX_CONFIG_DESCRIPTION_CHARS,
  CONFIG_SKILL_STATES,
  TOOL_OFFER_REASONS,
  TOOL_SETUPS,
  CONFIG_TOOL_GROUPS,
  SKILLS_PLACE,
  toolSettingsPlace,
  toolConfigGroup,
  skillOrigin,
  clipConfigDescription,
};
