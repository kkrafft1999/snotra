import contracts from '../generated/contracts.js';
import { t, tPlural } from '../i18n.js';

const {
  CONFIG_SKILL_STATES,
  CONFIG_TOOL_GROUPS,
  SKILLS_PLACE,
  SKILL_SOURCES,
  SKILL_SOURCE_LABEL_KEYS,
  TOOL_OFFER_REASONS,
  TOOL_SETUPS,
  extractInvokedSkillNames,
  toolSettingsPlace,
} = contracts;

/**
 * What the indicator at the composer shows (#773), worked out from the
 * description main sends (`chat-configuration-service.js`). Kept apart from
 * the DOM so that the wording and the order can be tested on their own.
 */

/** The order the groups of switched-on tools are listed in. */
const GROUP_ORDER = [
  CONFIG_TOOL_GROUPS.READ,
  CONFIG_TOOL_GROUPS.WRITE,
  CONFIG_TOOL_GROUPS.EXEC,
  CONFIG_TOOL_GROUPS.WEB,
  CONFIG_TOOL_GROUPS.IMAGE,
  CONFIG_TOOL_GROUPS.MCP,
  CONFIG_TOOL_GROUPS.OTHER,
];

/** `Settings › Skills` in the interface language, built from the nav labels themselves. */
export function settingsPath(panel) {
  return `${t('settings.title')} › ${t(`settings.nav.${panel}`)}`;
}

/**
 * Skills the chat invoked with "/name" (#124). Only what the user wrote
 * counts, as in the engine: a name in an answer switches nothing on.
 */
export function invokedSkillNames(messages) {
  const names = new Set();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user') continue;
    for (const name of extractInvokedSkillNames(message.content)) names.add(name);
  }
  return [...names];
}

function skillsOf(config) {
  return Array.isArray(config?.skills) ? config.skills : [];
}

function toolsOf(config) {
  return Array.isArray(config?.tools) ? config.tools : [];
}

/**
 * Whether the chat's model is sent any tools (#1013). An OpenAI-compatible
 * entry can switch them off for a server that chokes on the schemas; every
 * other entry, and a state from before the switch, sends them.
 */
export function activeEntrySendsTools(llmState) {
  const presets = Array.isArray(llmState?.presets) ? llmState.presets : [];
  const preset = presets.find((entry) => entry.id === llmState?.activePresetId);
  return preset?.connection?.sendTools !== false;
}

/**
 * The pill: it counts skills only — the tools are nearly always all on. The
 * exception is a model that gets no tools at all: then that is what it says,
 * since neither a tool nor a skill reaches the model.
 */
export function describeConfigPill(config, { sendsTools = true } = {}) {
  const count = skillsOf(config).filter((skill) => skill.state === CONFIG_SKILL_STATES.ON).length;
  if (!sendsTools) {
    const label = t('chat.config.pill.noTools');
    const pill = t('chat.config.pill.noTools.long');
    return {
      count,
      label,
      noTools: true,
      title: t('chat.config.button.title', { pill }),
      ariaLabel: t('chat.config.button.label', { pill }),
    };
  }
  const label = count === 0 ? t('chat.config.pill.none') : tPlural('chat.config.pill', count, { count });
  return {
    count,
    label,
    noTools: false,
    title: t('chat.config.button.title', { pill: label }),
    ariaLabel: t('chat.config.button.label', { pill: label }),
  };
}

/** What the tools section says instead of its lists when the model gets none. */
export function describeNoTools() {
  const place = settingsPath('models');
  return {
    text: t('chat.config.tools.notSent'),
    link: { label: t('chat.config.tools.notSent.link', { place }), panel: 'models' },
  };
}

function sourceLabel(source) {
  if (source === SKILL_SOURCES.SYSTEM) return t('chat.config.source.system');
  const key = SKILL_SOURCE_LABEL_KEYS[source];
  return key ? t(key) : '';
}

/**
 * The skills, those that are on first; within each state the catalogue's
 * order, which is the order of the sources.
 */
/** Why a skill is on or off in this chat only: called by name, or switched on a card (#774). */
function chatOnlyTitle(skill) {
  if (!skill.chatOnly) return '';
  if (skill.chatCard) {
    return skill.state === CONFIG_SKILL_STATES.ON
      ? t('chat.config.chatOnly.cardOn')
      : t('chat.config.chatOnly.cardOff');
  }
  return t('chat.config.chatOnly.title', { name: skill.name });
}

export function describeSkillRows(config) {
  const skills = skillsOf(config);
  const rank = (skill) => (skill.state === CONFIG_SKILL_STATES.ON ? 0 : skill.state === CONFIG_SKILL_STATES.OFF ? 1 : 2);
  const rows = skills
    .map((skill, index) => ({ skill, index }))
    .sort((a, b) => rank(a.skill) - rank(b.skill) || a.index - b.index)
    .map(({ skill }) => ({
      name: skill.name,
      on: skill.state === CONFIG_SKILL_STATES.ON,
      state: skill.state,
      stateLabel: t(`chat.config.state.${skill.state === CONFIG_SKILL_STATES.INVALID ? 'invalid' : skill.state === CONFIG_SKILL_STATES.ON ? 'on' : 'off'}`),
      chatOnly: skill.chatOnly === true,
      chatOnlyTitle: chatOnlyTitle(skill),
      source: sourceLabel(skill.source),
      description: typeof skill.description === 'string' ? skill.description : '',
    }));
  const on = rows.filter((row) => row.on).length;
  return {
    rows,
    on,
    total: rows.length,
    count: t('chat.config.count', { on, total: rows.length }),
    empty: rows.length === 0 ? t('chat.config.skills.none') : on === 0 ? t('chat.config.skills.empty') : '',
  };
}

function reasonLabel(tool) {
  if (tool.reason === TOOL_OFFER_REASONS.SWITCHED_OFF) return t('chat.config.reason.switchedOff');
  if (tool.reason === TOOL_OFFER_REASONS.NOT_CONFIGURED && Object.values(TOOL_SETUPS).includes(tool.setup)) {
    return t(`chat.config.reason.${tool.setup}`);
  }
  return t('chat.config.reason.unavailable');
}

/** A switch is switched on, anything else is set up. */
function actionFor(tool, place) {
  if (!place) return null;
  const switchOn = tool.reason === TOOL_OFFER_REASONS.SWITCHED_OFF
    || tool.setup === TOOL_SETUPS.PYTHON_SWITCH
    || tool.setup === TOOL_SETUPS.SHELL_SWITCH;
  const label = t(switchOn ? 'chat.config.action.switchOn' : 'chat.config.action.setUp');
  return {
    label,
    ariaLabel: t('chat.config.action.label', { action: label, tool: tool.name, place: settingsPath(place.panel) }),
    panel: place.panel,
    target: place.target || null,
  };
}

/**
 * The tools: what is missing first, with its reason and the way to the
 * setting — that is the question the indicator answers. The tools that only
 * lack a folder are one line; those that are on are summed up by group.
 */
export function describeToolSections(config) {
  const tools = toolsOf(config);
  const on = tools.filter((tool) => tool.on);
  const off = tools.filter((tool) => !tool.on);
  // Switched on a card for this chat (#774): their own rows on top, so that
  // a tool on here and off in the settings is not read as a setting.
  const changed = tools
    .filter((tool) => tool.chatOnly === true)
    .map((tool) => ({
      name: tool.name,
      on: tool.on,
      reason: t(tool.on ? 'chat.config.reason.chatOn' : 'chat.config.reason.chatOff'),
      tag: t('chat.config.chatOnly'),
      tagTitle: t(tool.on ? 'chat.config.chatOnly.cardOn' : 'chat.config.chatOnly.cardOff'),
    }));
  const changedNames = new Set(changed.map((tool) => tool.name));
  const missing = off
    .filter((tool) => !changedNames.has(tool.name))
    .filter((tool) => tool.reason !== TOOL_OFFER_REASONS.NO_FOLDER)
    .map((tool) => ({
      name: tool.name,
      reason: reasonLabel(tool),
      action: actionFor(tool, toolSettingsPlace(tool)),
    }));
  const noFolderCount = off.length - missing.length;

  const byGroup = new Map();
  for (const tool of on.filter((entry) => !changedNames.has(entry.name))) {
    const key = tool.group === CONFIG_TOOL_GROUPS.MCP ? `mcp:${tool.mcpServer || ''}` : tool.group;
    if (!byGroup.has(key)) byGroup.set(key, { group: tool.group, server: tool.mcpServer || '', names: [] });
    byGroup.get(key).names.push(tool.name);
  }
  const groupRank = (group) => {
    const index = GROUP_ORDER.indexOf(group);
    return index === -1 ? GROUP_ORDER.length : index;
  };
  const groups = [...byGroup.values()]
    .sort((a, b) => groupRank(a.group) - groupRank(b.group) || a.server.localeCompare(b.server))
    .map((entry) => ({
      key: entry.group === CONFIG_TOOL_GROUPS.MCP ? `mcp-${entry.server}` : entry.group,
      label: entry.group === CONFIG_TOOL_GROUPS.MCP
        ? t('chat.config.group.mcp', { server: entry.server })
        : t(`chat.config.group.${GROUP_ORDER.includes(entry.group) ? entry.group : 'other'}`),
      names: entry.names,
    }));

  return {
    on: on.length,
    total: tools.length,
    count: t('chat.config.count', { on: on.length, total: tools.length }),
    changed,
    missing,
    noFolder: noFolderCount > 0 ? tPlural('chat.config.noFolder', noFolderCount, { count: noFolderCount }) : '',
    onSummary: t('chat.config.tools.onSummary', { count: on.length }),
    groups,
  };
}

/**
 * The two ways into the settings under the lists: the label's key and the
 * menu path that fills its `{place}`.
 */
export function describeConfigLinks() {
  return {
    skills: { key: 'chat.config.link.skills', place: settingsPath(SKILLS_PLACE.panel), panel: SKILLS_PLACE.panel },
    tools: { key: 'chat.config.link.tools', place: settingsPath('security'), panel: 'security' },
  };
}
