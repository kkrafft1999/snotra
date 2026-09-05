// Planer (Issue #66, Konzept §2/§4/§5/§9): Ziele, Klassen, Sensitivität,
// harte Grenzen, Wiederherstellungskopie, Versionsbindung, Vorschau.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { createFsService } = require('../src/main/services/fs-service');
const { createWorkspaceToolRegistry } = require('../src/main/tools/workspace-tool-registry');
const { createToolCallPlanner, validateArguments, buildPreview } = require('../src/main/tools/tool-call-planner');

async function makeFixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'snotra-planner-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'projekt');
  const userData = path.join(base, 'userData');
  const skillDir = path.join(base, 'skills', 'demo');
  await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
  await fs.mkdir(path.join(workspace, '.ssh'), { recursive: true });
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(path.join(skillDir, 'references'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'src', 'a.js'), 'const a = 1;\n', 'utf8');
  await fs.writeFile(path.join(workspace, '.env'), 'X=1\n', 'utf8');
  await fs.writeFile(path.join(workspace, '.ssh', 'id_rsa'), 'key\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'personal.md'), 'privat\n', 'utf8');
  await fs.writeFile(path.join(userData, 'llm-config.json'), '{}', 'utf8');
  await fs.writeFile(path.join(skillDir, 'references', 'x.md'), '# x\n', 'utf8');
  const fsService = createFsService({ fs, path, maxReadFileBytes: 1024 * 1024, maxWriteFileBytes: 1024 * 1024 });
  const registry = createWorkspaceToolRegistry({ fsService });
  const make = (opts = {}) =>
    createToolCallPlanner({ fsService, fs, path, protectedRoots: [userData], canTrash: false, ...opts });
  return { base, workspace, userData, skillDir, fsService, registry, make, skillRoots: [{ name: 'demo', dir: skillDir }] };
}

test('Lesetool: Klasse read, Ziel mit Version, stabiler planKey', async (t) => {
  const { workspace, registry, make } = await makeFixture(t);
  const planner = make();
  const plan = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: 'src/a.js' }, { workspaceRoot: workspace });
  assert.deepEqual(plan.riskClasses, ['read']);
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].path, 'src/a.js');
  assert.equal(plan.targets[0].kind, 'file');
  assert.equal(plan.targets[0].exists, true);
  assert.match(plan.targets[0].version, /^\d+:\d+$/);
  assert.equal(plan.targets[0].sensitive, false);
  assert.equal(plan.hardLimit, undefined);
  assert.equal(plan.preview, undefined);
  const again = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: 'src/a.js' }, { workspaceRoot: workspace });
  assert.equal(again.planKey, plan.planKey);
  const other = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: 'src/a.js', max_characters: 5 }, { workspaceRoot: workspace });
  assert.notEqual(other.planKey, plan.planKey, 'andere Argumente → anderer Plan');
});

test('gezielt adressierte sensible Pfade werden zu read-sensitive, auch bei Metadaten und unter skill:', async (t) => {
  const { workspace, registry, make, skillDir, skillRoots } = await makeFixture(t);
  const planner = make();
  const env = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: '.env' }, { workspaceRoot: workspace });
  assert.deepEqual(env.riskClasses, ['read', 'read-sensitive']);
  assert.equal(env.targets[0].sensitiveReason, '.env*');

  const stat = await planner.plan(registry.getDefinition('stat_path'), { relative_path: '.ssh/id_rsa' }, { workspaceRoot: workspace });
  assert.deepEqual(stat.riskClasses, ['read', 'read-sensitive']);

  const listSsh = await planner.plan(registry.getDefinition('list_directory'), { relative_path: '.ssh' }, { workspaceRoot: workspace });
  assert.deepEqual(listSsh.riskClasses, ['read', 'read-sensitive'], 'Verzeichnis gezielt adressiert');

  const broad = await planner.plan(registry.getDefinition('list_directory'), { relative_path: '.' }, { workspaceRoot: workspace });
  assert.deepEqual(broad.riskClasses, ['read'], 'breite Auflistung bleibt read; Einträge werden ausgelassen');

  await fs.writeFile(path.join(skillDir, 'references', '.env'), 'S=1\n', 'utf8');
  const skill = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: 'skill:demo/references/.env' }, { workspaceRoot: workspace, skillRoots });
  assert.deepEqual(skill.riskClasses, ['read', 'read-sensitive']);
  assert.equal(skill.targets[0].skillName, 'demo');

  const user = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: 'personal.md' }, { workspaceRoot: workspace, sensitivePathPatterns: ['personal*'] });
  assert.deepEqual(user.riskClasses, ['read', 'read-sensitive']);
});

test('Windows-Trenner im Argument werden erkannt', async (t) => {
  const { workspace, registry, make } = await makeFixture(t);
  const planner = make();
  const plan = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: '.ssh\\id_rsa' }, { workspaceRoot: workspace });
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.riskClasses, ['read', 'read-sensitive']);
});

test('Schreiben: neue Datei ist write; Überschreiben ohne Papierkorb ist delete, mit Papierkorb write plus Rückweg', async (t) => {
  const { workspace, registry, make } = await makeFixture(t);
  const def = registry.getDefinition('write_file_text');
  const noTrash = make({ canTrash: false });
  const created = await noTrash.plan(def, { relative_path: 'src/neu.md', content: 'x' }, { workspaceRoot: workspace });
  assert.deepEqual(created.riskClasses, ['write']);
  assert.equal(created.targets[0].exists, false);
  assert.equal(created.targets[0].version, null);
  assert.equal(created.recovery, undefined);

  const overwrite = await noTrash.plan(def, { relative_path: 'src/a.js', content: 'neu' }, { workspaceRoot: workspace });
  assert.deepEqual(overwrite.riskClasses, ['delete']);

  const withTrash = make({ canTrash: true });
  const recoverable = await withTrash.plan(def, { relative_path: 'src/a.js', content: 'neu' }, { workspaceRoot: workspace });
  assert.deepEqual(recoverable.riskClasses, ['write']);
  assert.equal(recoverable.recovery, 'trash');
  assert.equal(recoverable.targets[0].recovery, 'trash');

  // Erzwungene Neubewertung nach fehlgeschlagener Kopie: delete trotz Papierkorb.
  const forced = await withTrash.plan(def, { relative_path: 'src/a.js', content: 'neu' }, { workspaceRoot: workspace, forcedClasses: ['delete'] });
  assert.deepEqual(forced.riskClasses, ['delete']);
  assert.equal(forced.recovery, undefined);

  const sensitiveWrite = await withTrash.plan(def, { relative_path: '.env', content: 'X=2' }, { workspaceRoot: workspace });
  assert.deepEqual(sensitiveWrite.riskClasses, ['read-sensitive', 'write'], 'Schreiben auf sensiblen Pfad trägt beide Merkmale');
});

test('Vorschau stammt aus den Argumenten, ist maskiert und gekürzt', async (t) => {
  const { workspace, registry, make } = await makeFixture(t);
  const planner = make({ canTrash: true });
  const plan = await planner.plan(
    registry.getDefinition('write_file_text'),
    { relative_path: 'src/neu.md', content: 'api_key = "abcdefgh12345678"\n' + 'z'.repeat(5000) },
    { workspaceRoot: workspace }
  );
  assert.equal(plan.preview.kind, 'text');
  assert.equal(plan.preview.masked, true);
  assert.equal(plan.preview.truncated, true);
  assert.equal(plan.preview.text.includes('abcdefgh12345678'), false);
  assert.match(plan.preview.text, /\[gekürzt\]$/);

  const edit = buildPreview('edit_file', { old_string: 'a', new_string: 'b', replace_all: true });
  assert.equal(edit.kind, 'replace');
  assert.match(edit.text, /--- alt \(alle Vorkommen\)\na\n\+\+\+ neu\nb/);
  const patch = buildPreview('apply_patch', { edits: [{ old_string: 'x', new_string: 'y' }] });
  assert.equal(patch.kind, 'diff');
  assert.match(patch.text, /# Schritt 1/);
  assert.equal(buildPreview('read_file_text', {}), null);
});

test('apply_patch: alle Ziele eines Mehrdatei-Patches werden geprüft, kaputte Patches nennen den Grund', async (t) => {
  const { workspace, registry, make } = await makeFixture(t);
  await fs.writeFile(path.join(workspace, 'src', 'b.js'), 'eins\n', 'utf8');
  const planner = make();
  const def = registry.getDefinition('apply_patch');
  const patch = ['--- a/src/a.js', '+++ b/src/a.js', '@@ -1,1 +1,1 @@', '-const a = 1;', '+const a = 2;', '--- a/src/b.js', '+++ b/src/b.js', '@@ -1,1 +1,1 @@', '-eins', '+zwei', ''].join('\n');
  const plan = await planner.plan(def, { patch }, { workspaceRoot: workspace });
  assert.deepEqual(plan.riskClasses, ['write']);
  assert.deepEqual(plan.targets.map((x) => x.path), ['src/a.js', 'src/b.js']);
  assert.equal(plan.preview.kind, 'diff');

  const broken = await planner.plan(def, { patch: 'kein diff' }, { workspaceRoot: workspace });
  assert.equal(broken.reason, 'invalid_arguments');
  assert.ok(broken.error);

  const edits = await planner.plan(def, { relative_path: 'src/a.js', edits: [{ old_string: 'a', new_string: 'b' }] }, { workspaceRoot: workspace });
  assert.deepEqual(edits.targets.map((x) => x.path), ['src/a.js']);

  const none = await planner.plan(def, { edits: [{ old_string: 'a', new_string: 'b' }] }, { workspaceRoot: workspace });
  assert.equal(none.reason, 'invalid_arguments', 'Schreibtool ohne Ziel');
});

test('harte Grenzen: Ausbruch, Skill-Schreiben, Snotra-eigener Speicher und Symlink dorthin', async (t) => {
  const { workspace, userData, registry, make, skillRoots } = await makeFixture(t);
  const planner = make();
  const outside = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: '../userData/llm-config.json' }, { workspaceRoot: workspace });
  assert.equal(outside.reason, 'hard_limit');
  assert.match(outside.error, /außerhalb/);

  const skillWrite = await planner.plan(registry.getDefinition('write_file_text'), { relative_path: 'skill:demo/references/x.md', content: 'x' }, { workspaceRoot: workspace, skillRoots });
  assert.equal(skillWrite.reason, 'hard_limit');
  assert.match(skillWrite.error, /schreibgeschützt/);

  const noWorkspace = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: 'a' }, { workspaceRoot: '' });
  assert.equal(noWorkspace.reason, 'hard_limit');

  // Wird der Snotra-Speicher selbst als Workspace geöffnet, bleibt er gesperrt.
  const inUserData = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: 'llm-config.json' }, { workspaceRoot: userData });
  assert.deepEqual(inUserData.hardLimit, { reason: 'hard_limit' });

  try {
    await fs.symlink(path.join(userData, 'llm-config.json'), path.join(workspace, 'link.json'));
  } catch (e) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) return t.skip('keine Symlinks');
    throw e;
  }
  const viaLink = await planner.plan(registry.getDefinition('read_file_text'), { relative_path: 'link.json' }, { workspaceRoot: workspace });
  // Der Realpfad verlässt den Workspace: das schlägt schon die Wurzelprüfung.
  assert.equal(viaLink.reason, 'hard_limit');
});

test('ungültige Argumente blockieren vor jeder Pfadauflösung', async (t) => {
  const { workspace, registry, make } = await makeFixture(t);
  const planner = make();
  const def = registry.getDefinition('read_file_text');
  assert.equal((await planner.plan(def, {}, { workspaceRoot: workspace })).reason, 'invalid_arguments');
  assert.equal((await planner.plan(def, { relative_path: 42 }, { workspaceRoot: workspace })).reason, 'invalid_arguments');
  assert.equal((await planner.plan(def, { relative_path: 'a', max_characters: 'viele' }, { workspaceRoot: workspace })).reason, 'invalid_arguments');
  assert.equal((await planner.plan(def, [], { workspaceRoot: workspace })).reason, 'invalid_arguments');
  assert.equal(validateArguments({ parameters: { required: ['x'], properties: { x: { type: 'boolean' } } } }, { x: 'ja' }), 'Argument „x“ muss true/false sein.');
  assert.equal(validateArguments({ parameters: {} }, { extra: 1 }), null, 'unbekannte Felder stören nicht');
  const unknown = await planner.plan(null, {}, { workspaceRoot: workspace });
  assert.equal(unknown.reason, 'unknown_tool');
  assert.equal(unknown.unknownTool, true);
});

test('verifyTargets erkennt geänderte, gelöschte und neu entstandene Ziele', async (t) => {
  const { workspace, registry, make } = await makeFixture(t);
  const planner = make();
  const plan = await planner.plan(registry.getDefinition('edit_file'), { relative_path: 'src/a.js', old_string: 'a', new_string: 'b' }, { workspaceRoot: workspace });
  assert.deepEqual(await planner.verifyTargets(plan), { ok: true });

  await fs.writeFile(path.join(workspace, 'src', 'a.js'), 'const a = 1;\nconst b = 2;\n', 'utf8');
  const changed = await planner.verifyTargets(plan);
  assert.equal(changed.ok, false);
  assert.match(changed.error, /geändert/);

  const created = await planner.plan(registry.getDefinition('write_file_text'), { relative_path: 'src/neu.md', content: 'x' }, { workspaceRoot: workspace });
  await fs.writeFile(path.join(workspace, 'src', 'neu.md'), 'inzwischen da', 'utf8');
  assert.equal((await planner.verifyTargets(created)).ok, false, 'Ziel existiert plötzlich');

  const tree = await planner.plan(registry.getDefinition('list_directory'), { relative_path: 'src' }, { workspaceRoot: workspace });
  assert.deepEqual(await planner.verifyTargets(tree), { ok: true }, 'Baum-Ziele werden nicht versioniert');
});
