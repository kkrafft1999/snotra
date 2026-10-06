/**
 * Snotra writes skills into the open folder (#160): `.agents/skills/<name>/`
 * is an ordinary workspace path, the global and built-in skill folders stay
 * read-only (#548). What #160 adds on top is checked here — the path helper,
 * the one validation the catalog and the write share, the verdict a write
 * hands back to the model, the log line, and the system skill that explains
 * all of it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  SKILL_AUTHORING_SKILL,
  SKILL_FOLDER_READ_ONLY,
  WORKSPACE_SKILLS_DIR,
  workspaceSkillOfPath,
} = require('../src/shared/contracts/skills');
const { checkSkillDocument } = require('../src/shared/runtime/skill-frontmatter');
const { createWorkspaceToolAdapter } = require('../src/main/adapters/workspace-tool-adapter');
const { formatToolDisplayLine } = require('../src/shared/presentation/tool-display');
const { createSkillsService } = require('../src/main/services/skills-service');
const { TOOL_CATEGORIES, toolCategoryForEntry } = require('../src/shared/contracts/tool-categories');

const VALID = '---\nname: release-notes\ndescription: Writes release notes. Use when asked for them.\n---\n\nDo it.\n';

test('workspaceSkillOfPath recognises a file of a skill in the open folder', () => {
  assert.deepEqual(workspaceSkillOfPath('.agents/skills/release-notes/SKILL.md'), { name: 'release-notes', file: 'SKILL.md' });
  assert.deepEqual(workspaceSkillOfPath('./.agents/skills/a/references/x.md'), { name: 'a', file: 'references/x.md' });
  assert.deepEqual(workspaceSkillOfPath('.agents\\skills\\a\\SKILL.md'), { name: 'a', file: 'SKILL.md' });
  for (const other of [
    '.agents/skills/a',
    '.agents/skills',
    '.agents/memory.md',
    'docs/.agents/skills/a/SKILL.md',
    '.agents/skills/a/../../x.md',
    'skill:a/SKILL.md',
    '',
    null,
  ]) {
    assert.equal(workspaceSkillOfPath(other), null, String(other));
  }
});

test('the refusal of a skill-folder write names the place to write a skill instead', () => {
  assert.match(SKILL_FOLDER_READ_ONLY, new RegExp(`${WORKSPACE_SKILLS_DIR.replace('.', '\\.')}/<name>/`));
  assert.ok(SKILL_FOLDER_READ_ONLY.includes(SKILL_AUTHORING_SKILL));
});

test('checkSkillDocument accepts a valid SKILL.md and names each problem otherwise', () => {
  const ok = checkSkillDocument(VALID, 'release-notes');
  assert.equal(ok.ok, true);
  assert.equal(ok.name, 'release-notes');
  assert.equal(ok.body, 'Do it.');

  assert.deepEqual(checkSkillDocument('# no front matter', 'x'), { ok: false, key: 'skills.invalid.noFrontmatter' });
  assert.deepEqual(checkSkillDocument('---\ndescription: d\n---\n', 'x'), { ok: false, key: 'skills.invalid.noName' });
  assert.deepEqual(checkSkillDocument('---\nname: x\n---\n', 'x'), { ok: false, key: 'skills.invalid.noDescription' });
  assert.deepEqual(checkSkillDocument('---\nname: -x\ndescription: d\n---\n', '-x'), {
    ok: false,
    key: 'skills.invalid.badName',
    params: { name: '-x' },
  });
  assert.deepEqual(checkSkillDocument(VALID, 'notes'), {
    ok: false,
    key: 'skills.invalid.nameMismatch',
    params: { name: 'release-notes', dir: 'notes' },
  });
});

async function withWorkspace(files, run) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'snotra-skill-authoring-'));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, content);
    }
    return await run(root);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

function adapterReturning(result) {
  const registry = {
    getTools: () => [],
    buildSystemPrompt: () => '',
    execute: async () => JSON.stringify(result),
  };
  return createWorkspaceToolAdapter(registry, { fs: fsp, path });
}

test('a valid SKILL.md written into the open folder comes back with valid: true and where to switch it on', async () => {
  await withWorkspace({ '.agents/skills/release-notes/SKILL.md': VALID }, async (root) => {
    const adapter = adapterReturning({ ok: true, bytesWritten: VALID.length });
    const result = await adapter.execute(
      'write_file_text',
      { relative_path: '.agents/skills/release-notes/SKILL.md', content: VALID },
      { workspaceRoot: root, locale: 'de' }
    );
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.skill_check.skill, 'release-notes');
    assert.equal(parsed.skill_check.valid, true);
    // The menu path is quoted the way the user sees it, so the model can pass it on.
    assert.match(parsed.skill_check.note, /Einstellungen › Skills/);
  });
});

test('an invalid SKILL.md comes back with the problem, in English', async () => {
  const content = '---\nname: notes\ndescription: d\n---\n';
  await withWorkspace({ '.agents/skills/release-notes/SKILL.md': content }, async (root) => {
    const adapter = adapterReturning({ ok: true, relative_path: '.agents/skills/release-notes/SKILL.md' });
    const result = await adapter.execute(
      'edit_file',
      { relative_path: '.agents/skills/release-notes/SKILL.md', old_string: 'a', new_string: 'b' },
      { workspaceRoot: root, locale: 'de' }
    );
    const check = JSON.parse(result.output).skill_check;
    assert.equal(check.valid, false);
    assert.equal(check.problem, 'name “notes” ≠ folder “release-notes”');
  });
});

test('apply_patch over several skills reports each SKILL.md it touched', async () => {
  await withWorkspace(
    {
      '.agents/skills/a/SKILL.md': '---\nname: a\ndescription: d\n---\n',
      '.agents/skills/b/SKILL.md': '---\nname: b\n---\n',
      '.agents/skills/b/references/x.md': 'x',
    },
    async (root) => {
      const adapter = adapterReturning({
        ok: true,
        files: [
          { relative_path: '.agents/skills/a/SKILL.md' },
          { relative_path: '.agents/skills/b/SKILL.md' },
          { relative_path: '.agents/skills/b/references/x.md' },
        ],
      });
      const result = await adapter.execute('apply_patch', { patch: '…' }, { workspaceRoot: root });
      const checks = JSON.parse(result.output).skill_check;
      assert.deepEqual(checks.map((c) => [c.skill, c.valid]), [['a', true], ['b', false]]);
    }
  );
});

test('writes that are not a SKILL.md in the open folder get no skill_check', async () => {
  await withWorkspace({ 'docs/SKILL.md': VALID, '.agents/skills/a/notes.md': 'x' }, async (root) => {
    for (const [tool, args, result] of [
      ['write_file_text', { relative_path: 'docs/SKILL.md', content: VALID }, { ok: true }],
      ['write_file_text', { relative_path: '.agents/skills/a/notes.md', content: 'x' }, { ok: true }],
      ['write_file_text', { relative_path: '.agents/skills/a/SKILL.md', content: VALID }, { error: 'denied' }],
      ['read_file_text', { relative_path: '.agents/skills/a/SKILL.md' }, { ok: true, text: VALID }],
    ]) {
      const adapter = adapterReturning(result);
      const output = (await adapter.execute(tool, args, { workspaceRoot: root })).output;
      assert.equal(JSON.parse(output).skill_check, undefined, `${tool} ${args.relative_path}`);
      assert.equal(output, JSON.stringify(result));
    }
  });
});

test('the log shows a write into a skill of the open folder as part of that skill', () => {
  const line = (tool, phase, locale) =>
    formatToolDisplayLine({ tool, args: { relative_path: '.agents/skills/release-notes/SKILL.md' } }, phase, locale);
  assert.equal(line('write_file_text', 'done', 'en'), 'File SKILL.md (skill release-notes) written');
  assert.equal(line('write_file_text', 'done', 'de'), 'Datei SKILL.md (Skill release-notes) geschrieben');
  assert.match(line('edit_file', 'start', 'en'), /SKILL\.md \(skill release-notes\)/);
  assert.match(line('apply_patch', 'done', 'en'), /SKILL\.md \(skill release-notes\)/);
  // Reading keeps the plain path: it is a file of the folder like any other.
  assert.match(line('read_file_text', 'done', 'en'), /\.agents\/skills\/release-notes\/SKILL\.md/);
});

test('snotra-skill-authoring ships as a valid system skill and is named in snotra-capabilities', async () => {
  const systemSkillsDir = path.join(__dirname, '..', 'system-skills');
  const service = createSkillsService({ fs: fsp, path, os, systemSkillsDir });
  const catalog = await service.listCatalog({ workspaceRoot: null });
  const skill = catalog.skills.find((entry) => entry.name === SKILL_AUTHORING_SKILL);
  assert.ok(skill, 'snotra-skill-authoring is missing from the catalog');
  // Built-in skills are on by default; the user can switch this one off like any other.
  assert.equal(skill.status, 'active');
  assert.equal(skill.source, 'system');

  const capabilities = fs.readFileSync(path.join(systemSkillsDir, 'snotra-capabilities', 'SKILL.md'), 'utf8');
  assert.ok(capabilities.includes(SKILL_AUTHORING_SKILL));
});

test('a write into a skill of the open folder is its own log category, reading and images are not', () => {
  const adapter = createWorkspaceToolAdapter({ getTools: () => [], buildSystemPrompt: () => '', execute: async () => '{}' });
  const skillPath = '.agents/skills/release-notes/SKILL.md';
  for (const tool of ['write_file_text', 'edit_file', 'apply_patch']) {
    const entry = adapter.buildTraceEntry(tool, { relative_path: skillPath });
    assert.equal(entry.skill, 'release-notes', tool);
    assert.equal(toolCategoryForEntry(entry), TOOL_CATEGORIES.SKILL_WRITE, tool);
  }
  assert.equal(adapter.buildTraceEntry('write_file_text', { relative_path: 'docs/SKILL.md' }).skill, undefined);
  assert.equal(adapter.buildTraceEntry('read_file_text', { relative_path: skillPath }).skill, undefined);
  assert.equal(adapter.buildTraceEntry('generate_image', { relative_path: '.agents/skills/a/assets/x.png' }).skill, undefined);
  // A `skill:` read stays a skill access.
  assert.equal(toolCategoryForEntry({ tool: 'read_file_text', skill: 'a' }), TOOL_CATEGORIES.SKILL);
});
