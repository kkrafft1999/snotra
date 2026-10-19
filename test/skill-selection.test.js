'use strict';

// The skill selection as a rule of the core (#982): which skills are on, what
// a tick becomes when stored, and what making a skill global does to its
// switch. The scan behind it is skills-service's, tested there.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  selectActiveSkills,
  bindSkillSelection,
  switchOnGlobally,
} = require('../src/application/skills/skill-selection');
const { SKILL_SOURCES, SKILL_STATUS } = require('../src/shared/contracts/skills');

const skill = (name, source, status = SKILL_STATUS.AVAILABLE) => ({
  name, source, status, description: '', path: `/skills/${name}`, detail: '', body: `# ${name}`,
});

const SKILLS = [
  skill('system-a', SKILL_SOURCES.SYSTEM),
  skill('broken', SKILL_SOURCES.SYSTEM, SKILL_STATUS.INVALID),
  skill('global-b', SKILL_SOURCES.USER_SNOTRA),
  skill('folder-c', SKILL_SOURCES.WORKSPACE_AGENTS),
];
const names = (selected) => selected.map(({ skill: s }) => s.name);

test('by default only the usable system skills are on', () => {
  assert.deepEqual(names(selectActiveSkills(SKILLS, { workspaceKey: '/ws' })), ['system-a']);
});

test('a folder skill is on only through its own folder\'s list (#576)', () => {
  const selection = { workspaceKey: '/ws', activeSkills: ['folder-c', 'global-b'], activeWorkspaceSkills: {} };
  assert.deepEqual(names(selectActiveSkills(SKILLS, selection)), ['global-b'], 'the global list cannot switch it on');
  const own = { ...selection, activeWorkspaceSkills: { '/ws': ['folder-c'] } };
  assert.deepEqual(names(selectActiveSkills(SKILLS, own)), ['global-b', 'folder-c']);
  assert.deepEqual(names(selectActiveSkills(SKILLS, { ...own, workspaceKey: '/other' })), ['global-b']);
});

test('a skill called with /name comes on top and says so (#124)', () => {
  const selected = selectActiveSkills(SKILLS, { workspaceKey: '', activeSkills: [], invokedSkills: ['global-b', 'broken'] });
  assert.deepEqual(selected.map(({ skill: s, invoked }) => [s.name, invoked]), [['global-b', true]]);
});

test('storing the ticks binds each to where it was made, and keeps what this folder cannot see', () => {
  const bound = bindSkillSelection(SKILLS, {
    workspaceKey: '/ws',
    selected: ['global-b', 'folder-c'],
    activeSkills: ['system-a', 'elsewhere-only'],
    activeWorkspaceSkills: { '/other': ['x'] },
  });
  assert.deepEqual(bound, {
    activeSkills: ['elsewhere-only', 'global-b'],
    activeWorkspaceSkills: { '/other': ['x'], '/ws': ['folder-c'] },
  });
});

test('a folder skill made global keeps its switch, now in the global list (#764)', () => {
  const moved = switchOnGlobally(SKILLS, {
    workspaceKey: '/ws', name: 'folder-c', activeSkills: null, activeWorkspaceSkills: { '/ws': ['folder-c'] },
  });
  assert.deepEqual(moved, { activeSkills: ['system-a', 'folder-c'], activeWorkspaceSkills: {} });
  assert.equal(switchOnGlobally(SKILLS, { workspaceKey: '/ws', name: 'folder-c', activeWorkspaceSkills: {} }), null, 'off stays off');
});
