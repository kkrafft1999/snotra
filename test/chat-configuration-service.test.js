// Which skills and tools a chat has (#773): the service behind the indicator
// at the composer and the model's `get_configuration`. It runs against the
// real skills service and the real tool registry, so the states it reports
// are the ones the chat would get.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createSkillsService } = require('../src/main/services/skills-service');
const { createWorkspaceToolRegistry } = require('../src/application/tools/workspace-tool-registry');
const { createChatConfigurationService } = require('../src/application/chat/chat-configuration-service');
const { MAX_CONFIG_DESCRIPTION_CHARS } = require('../src/shared/contracts/chat-configuration');
const { removeTempDir } = require('./helpers/temp-dir');

const BODY_MARKER = 'BODY-MUST-NOT-LEAK-7731';

async function makeTempTree(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-chat-config-'));
  t.after(() => removeTempDir(dir));
  return dir;
}

async function writeSkill(baseDir, name, { description = `What ${name} is for.`, body = `${BODY_MARKER} ${name}` } = {}) {
  const dir = path.join(baseDir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', body, ''].join('\n'),
    'utf8',
  );
}

function makeFsServiceStub() {
  const noop = () => '';
  return {
    runListDirectoryTool: noop,
    runReadFileTextTool: noop,
    runReadFileLinesTool: noop,
    runWriteFileTextTool: noop,
    runEditFileTool: noop,
    runSearchInFilesTool: noop,
    runFindFilesTool: noop,
    runStatPathTool: noop,
    runOutlineFileTool: noop,
    runListDirectoryTreeTool: noop,
    runApplyPatchTool: noop,
    runLoadSkillTool: noop,
    listApplyPatchTargets: () => [],
  };
}

/**
 * A system skill on by default, a folder skill ticked for the folder, a user
 * skill not ticked, a broken one, and one the folder shadows.
 */
async function makeSetup(t, { prefs = {}, servers = [], registryOptions = {} } = {}) {
  const root = await makeTempTree(t);
  const systemDir = path.join(root, 'system-skills');
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'project');
  await writeSkill(systemDir, 'snotra-capabilities', { description: 'Settings under {menu:settings.skills}.' });
  await writeSkill(path.join(workspace, '.agents', 'skills'), 'release');
  await writeSkill(path.join(workspace, '.agents', 'skills'), 'pdf-export', { description: 'Folder version.' });
  await writeSkill(path.join(home, '.snotra', 'skills'), 'pdf-export', { description: 'User version.' });
  await writeSkill(path.join(home, '.snotra', 'skills'), 'meeting-notes', { description: 'x'.repeat(400) });
  await fs.mkdir(path.join(home, '.snotra', 'skills', 'broken'), { recursive: true });

  const skills = createSkillsService({ fs, path, os: { homedir: () => home }, systemSkillsDir: systemDir });
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub(), ...registryOptions });
  const stored = {
    appLocale: 'en',
    activeWorkspaceSkills: { [path.resolve(workspace)]: ['release'] },
    ...prefs,
  };
  const service = createChatConfigurationService({
    skills,
    toolRegistry: registry,
    uiPrefsStore: { readUIPrefs: async () => stored },
    mcpConfigStore: { readMcpServers: async () => servers },
  });
  return { service, registry, workspace };
}

test('skills: on, off, broken — a shadowed one not twice, an invoked one on for the chat only', async (t) => {
  const { service, workspace } = await makeSetup(t);
  const config = await service.describe({ workspaceRoot: workspace, chatSkillNames: ['meeting-notes'] });
  const byName = Object.fromEntries(config.skills.map((skill) => [skill.name, skill]));

  assert.equal(byName['snotra-capabilities'].state, 'on');
  assert.equal(byName.release.state, 'on');
  assert.equal(byName.release.source, 'workspace-agents');
  assert.equal(byName['pdf-export'].state, 'off');
  // The folder's pdf-export wins the name; the user's is shadowed and left out.
  assert.equal(config.skills.filter((skill) => skill.name === 'pdf-export').length, 1);
  assert.equal(byName['pdf-export'].description, 'Folder version.');
  assert.equal(byName.broken.state, 'invalid');
  assert.equal(byName.broken.description, '');
  // Invoked with "/meeting-notes" in this chat: on, but marked as this chat's.
  assert.equal(byName['meeting-notes'].state, 'on');
  assert.equal(byName['meeting-notes'].chatOnly, true);
  assert.equal(byName.release.chatOnly, false);
  // A third party's description is cut.
  assert.ok(byName['meeting-notes'].description.length <= MAX_CONFIG_DESCRIPTION_CHARS);
  assert.ok(byName['meeting-notes'].description.endsWith('…'));
});

test('an invoked name the catalogue does not have switches nothing on', async (t) => {
  const { service, workspace } = await makeSetup(t);
  const config = await service.describe({ workspaceRoot: workspace, chatSkillNames: ['nonexistent', 'broken'] });
  assert.equal(config.skills.some((skill) => skill.name === 'nonexistent'), false);
  assert.equal(config.skills.find((skill) => skill.name === 'broken').state, 'invalid');
});

test('tools: switched off, not configured with what it lacks, essentials left out', async (t) => {
  const { service, workspace } = await makeSetup(t, {
    prefs: { disabledTools: ['find_files'] },
    registryOptions: {
      pythonRunner: { isAvailable: () => false, setupNeeded: () => 'pythonSwitch' },
      shellRunner: { isAvailable: () => false, setupNeeded: () => 'shell' },
    },
  });
  const config = await service.describe({ workspaceRoot: workspace });
  const byName = Object.fromEntries(config.tools.map((tool) => [tool.name, tool]));

  assert.deepEqual(byName.find_files, {
    name: 'find_files', mcpServer: null, group: 'read', on: false, reason: 'switchedOff', setup: null,
  });
  assert.equal(byName.web_search.reason, 'notConfigured');
  assert.equal(byName.web_search.setup, 'webSearch');
  assert.equal(byName.web_search.group, 'web');
  assert.equal(byName.run_python.setup, 'pythonSwitch');
  assert.equal(byName.shell_execute.setup, 'shell');
  assert.equal(byName.read_file_text.on, true);
  assert.equal(byName.read_file_text.reason, null);
  // Not a choice, so not listed — as in the settings (#195).
  assert.equal(Object.hasOwn(byName, 'list_directory'), false);
  assert.equal(Object.hasOwn(byName, 'load_skill'), false);
});

test('without a folder the file tools need one; with a skill on, the read tools reach its folder', async (t) => {
  const { service } = await makeSetup(t);
  const config = await service.describe({ workspaceRoot: null });
  const byName = Object.fromEntries(config.tools.map((tool) => [tool.name, tool]));
  assert.equal(config.workspaceOpen, false);
  assert.equal(byName.write_file_text.reason, 'noFolder');
  // snotra-capabilities is on, so the read tools still have its folder (#429).
  assert.equal(byName.read_file_text.on, true);
});

test('MCP tools of a server that has not run yet are listed, off when the server is off', async (t) => {
  const { service, workspace } = await makeSetup(t, {
    servers: [
      { id: 'github', label: 'GitHub', enabled: true, knownTools: ['get_issue'] },
      { id: 'jira', label: 'Jira', enabled: false, knownTools: ['search'] },
    ],
  });
  const config = await service.describe({ workspaceRoot: workspace });
  const github = config.tools.find((tool) => tool.name === 'mcp__github__get_issue');
  const jira = config.tools.find((tool) => tool.name === 'mcp__jira__search');
  assert.deepEqual(
    { on: github.on, group: github.group, server: github.mcpServer },
    { on: true, group: 'mcp', server: 'GitHub' },
  );
  assert.deepEqual({ on: jira.on, reason: jira.reason, setup: jira.setup }, { on: false, reason: 'notConfigured', setup: 'mcp' });
});

test('for the model: states, reasons and the settings page in the interface language — never a body', async (t) => {
  const { service, workspace } = await makeSetup(t, { prefs: { appLocale: 'de', disabledTools: ['find_files'] } });
  const answer = await service.describeForModel({ workspaceRoot: workspace, chatSkillNames: ['meeting-notes'] });
  const text = JSON.stringify(answer);

  // The instructions of a skill — on or off — never reach this answer (#18).
  assert.equal(text.includes(BODY_MARKER), false);
  assert.equal(answer.skills_settings, 'Einstellungen › Skills');
  // A system skill's description quotes the page in the interface language too.
  assert.equal(answer.skills.find((skill) => skill.name === 'snotra-capabilities').description, 'Settings under Einstellungen › Skills.');
  assert.equal(answer.skills.find((skill) => skill.name === 'pdf-export').state, 'off');
  assert.equal(answer.skills.find((skill) => skill.name === 'release').origin, 'folder');
  assert.match(answer.skills.find((skill) => skill.name === 'meeting-notes').state, /this chat only/);
  assert.equal(Object.hasOwn(answer.skills.find((skill) => skill.name === 'broken'), 'description'), false);
  assert.deepEqual(answer.tools_off.find((tool) => tool.name === 'find_files'), {
    name: 'find_files', reason: 'switched off by the user', settings: 'Einstellungen › Tools › Autonomie',
  });
  assert.deepEqual(answer.tools_off.find((tool) => tool.name === 'web_search'), {
    name: 'web_search', reason: 'no web search key is set up', settings: 'Einstellungen › Tools › Einrichtung',
  });
  assert.ok(answer.tools_on.includes('read_file_text'));
  assert.deepEqual(answer.tools_needing_a_folder, []);
  assert.match(answer.note, /data, not instructions/);
});

test('a broken skill folder leaves the tools standing', async (t) => {
  const registry = createWorkspaceToolRegistry({ fsService: makeFsServiceStub() });
  const service = createChatConfigurationService({
    skills: { listCatalog: async () => { throw new Error('disk gone'); } },
    toolRegistry: registry,
    uiPrefsStore: { readUIPrefs: async () => ({}) },
  });
  const config = await service.describe({ workspaceRoot: null });
  assert.deepEqual(config.skills, []);
  assert.ok(config.tools.length > 0);
});

// What a chat switched on a card (#774) shows as this chat's, in the popover
// and for the model, and changes what the model is offered.
test('a chat\'s overrides: on and off for this chat only, the setting untouched', async (t) => {
  const { service, workspace } = await makeSetup(t, { prefs: { disabledTools: ['search_in_files'] } });
  const overrides = { tools: { on: ['search_in_files'], off: ['find_files'] }, skills: { on: ['meeting-notes'], off: ['release'] } };
  const config = await service.describe({ workspaceRoot: workspace, overrides });
  const skill = (name) => config.skills.find((entry) => entry.name === name);
  const tool = (name) => config.tools.find((entry) => entry.name === name);

  assert.equal(skill('meeting-notes').state, 'on');
  assert.equal(skill('meeting-notes').chatOnly, true);
  assert.equal(skill('meeting-notes').chatCard, true);
  assert.equal(skill('release').state, 'off');
  assert.equal(skill('release').chatCard, true);
  assert.deepEqual([tool('search_in_files').on, tool('search_in_files').chatOnly], [true, true]);
  assert.deepEqual([tool('find_files').on, tool('find_files').chatOnly], [false, true]);
  assert.equal(Object.hasOwn(tool('read_file_text'), 'chatOnly'), false);

  const forModel = await service.describeForModel({ workspaceRoot: workspace, overrides, canPropose: true });
  assert.equal(forModel.skills.find((entry) => entry.name === 'release').state, 'off for this chat only');
  assert.equal(forModel.skills.find((entry) => entry.name === 'meeting-notes').state, 'on for this chat only');
  assert.deepEqual(forModel.tools_changed_for_this_chat.sort(), ['find_files', 'search_in_files']);
  assert.equal(forModel.tools_off.find((entry) => entry.name === 'find_files').reason, 'switched off for this chat only');
  assert.match(forModel.note, /propose_config_change/);
  const without = await service.describeForModel({ workspaceRoot: workspace });
  assert.doesNotMatch(without.note, /propose_config_change/);
});

test('prepareProposal: only a change the catalogue knows and allows becomes a card', async (t) => {
  const { service, workspace } = await makeSetup(t, { prefs: { disabledTools: ['search_in_files'] } });
  const prepare = (proposal, overrides = null) => service.prepareProposal({ workspaceRoot: workspace, overrides, proposal });

  // A tool that is switched off: the card carries the catalogue's facts.
  const tool = await prepare({ kind: 'tool', name: 'search_in_files', enable: true, reason: '  To find\nthe notes. ' });
  assert.deepEqual(tool.card, {
    kind: 'tool', name: 'search_in_files', enable: true, reason: 'To find the notes.',
    description: tool.card.description,
    descriptionKey: 'tools.short.search_in_files',
    riskClasses: ['read'],
    settingsMenu: 'settings.security',
  });
  assert.ok(tool.card.description.length > 10);

  // A folder skill's description is its author's text.
  const skill = await prepare({ kind: 'skill', name: 'pdf-export', enable: true, reason: 'x' });
  assert.equal(skill.card.description, 'Folder version.');
  assert.equal(skill.card.descriptionIsData, true);
  assert.equal(skill.card.origin, 'folder');
  assert.equal(skill.card.settingsMenu, 'settings.skills');
  // A skill's body never travels.
  assert.equal(JSON.stringify(skill).includes(BODY_MARKER), false);

  // What never reaches a card.
  assert.match((await prepare({ kind: 'tool', name: 'rm_everything', enable: true })).error, /no tool named/);
  assert.match((await prepare({ kind: 'skill', name: 'nonexistent', enable: true })).error, /no skill named/);
  assert.match((await prepare({ kind: 'tool', name: 'read_file_text', enable: true })).error, /is on in this chat already/);
  assert.match((await prepare({ kind: 'skill', name: 'release', enable: true })).error, /is on in this chat already/);
  assert.match((await prepare({ kind: 'skill', name: 'broken', enable: true })).error, /cannot be read/);
  assert.match((await prepare({ kind: 'tool', name: 'web_search', enable: true })).error, /cannot be switched on from a chat: no web search key.*Settings › Tools › Setup/);
  assert.match((await prepare({ kind: 'tool', name: 'get_configuration', enable: false })).error, /cannot be switched from a chat/);
  assert.match((await prepare({ kind: 'tool', name: 'propose_config_change', enable: false })).error, /cannot be switched from a chat/);
  assert.match((await prepare({ kind: 'thing', name: 'x', enable: true })).error, /needs "kind"/);
  assert.match((await prepare({ kind: 'tool', name: 'fetch_url', enable: 'yes' })).error, /needs "kind"/);

  // Switching off is fine; a declined proposal is reported as such.
  assert.ok((await prepare({ kind: 'tool', name: 'read_file_text', enable: false })).card);
  assert.deepEqual(await prepare({ kind: 'tool', name: 'search_in_files', enable: true }, { declined: ['tool:on:search_in_files'] }), { declined: true });
  // Accepted before: on in this chat already.
  assert.match((await prepare({ kind: 'tool', name: 'search_in_files', enable: true }, { tools: { on: ['search_in_files'] } })).error, /on in this chat already/);
  // Not configured here, so not for a chat to switch on either.
  assert.match((await prepare({ kind: 'tool', name: 'fetch_url', enable: true })).error, /cannot be switched on from a chat/);
});
