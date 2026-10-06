// Snotra writes a skill into the open folder (#160): the write goes through
// the ordinary approval, the model gets the verdict on the SKILL.md back, the
// log names the skill, and the new skill turns up in the catalog by itself —
// switched off, like every folder skill.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SKILL = [
  '---',
  'name: release-notes',
  'description: Writes release notes from the merged pull requests. Use when asked for release notes.',
  '---',
  '',
  'Collect the merged pull requests since the last tag and group them by area.',
  '',
].join('\n');

test('a skill written by the model lands in the open folder, is checked and shows up in the catalog', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-skill-authoring-');
  const userDataDir = await makeTempDir('snotra-skill-authoring-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Project\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;
  const evidence = async () => [
    `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}`,
    `answers not taken: ${JSON.stringify(model.pendingAnswers())}`,
    `main:\n${snotra.mainOutput()}`,
  ].join('\n');

  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  // The workspace has no skills yet, and no `.agents` folder either: the
  // watcher has to find a source that only comes into being with the write.
  const before = await page.evaluate(() => window.electronAPI.getSkillCatalog());
  assert.equal(before.skills.some((skill) => skill.name === 'release-notes'), false);

  model.queueAnswer({
    match: 'Make a skill for release notes',
    toolCalls: [{
      name: 'write_file_text',
      arguments: { relative_path: '.agents/skills/release-notes/SKILL.md', content: SKILL },
    }],
  });
  model.queueAnswer({ text: 'Done — switch it on under Settings › Skills.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Make a skill for release notes.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });
  await poll(async () => {
    await page.evaluate(() => {
      document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])')?.click();
    });
    return page.evaluate(() =>
      !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
      && document.querySelector('#chat-messages > li:last-child')?.textContent.includes('switch it on'));
  }, { what: 'run through', timeoutMs: 60000, explain: evidence });

  assert.equal(await readFile(path.join(workspace, '.agents', 'skills', 'release-notes', 'SKILL.md'), 'utf8'), SKILL);

  // The model learnt that the skill is valid and still has to be switched on.
  const followUp = model.requests.find((r) => !r.isTitleRequest && JSON.stringify(r.body).includes('skill_check'));
  assert.ok(followUp, `no request carried the skill check\n${await evidence()}`);
  const toolMessage = followUp.body.messages.find((m) => m.role === 'tool');
  const result = JSON.parse(toolMessage.content);
  assert.equal(result.skill_check.skill, 'release-notes');
  assert.equal(result.skill_check.valid, true);
  assert.match(result.skill_check.note, /Settings › Skills/);

  // The log names the skill rather than an anonymous file.
  const lines = await page.evaluate(() =>
    [...document.querySelectorAll('.chat-tool-lines > .chat-tool-line')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(lines.some((line) => line.includes('File SKILL.md (skill release-notes) written')), JSON.stringify(lines));

  // Collapsed, the log still says that a skill was written, not just a file.
  const summary = await page.evaluate(() =>
    document.querySelector('.chat-tool-log .chat-tool-summary-line .chat-tool-line-text')?.textContent.replace(/\s+/g, ' ').trim() ?? null);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.chat-tool-line')].map((r) => r.dataset.category));
  assert.equal(summary, '1 skill file written', JSON.stringify(rows));
  assert.ok(rows.every((category) => category === 'skill-write'), JSON.stringify(rows));

  // The catalog follows without "Reload skills"; the skill is there, but off.
  const entry = await poll(async () => {
    const catalog = await page.evaluate(() => window.electronAPI.getSkillCatalog());
    return catalog.skills.find((skill) => skill.name === 'release-notes') ?? null;
  }, { what: 'new skill in the catalog', timeoutMs: 20000, explain: evidence });
  assert.equal(entry.source, 'workspace-agents');
  assert.equal(entry.status, 'available');
});
