// The skills and tools of a chat in the real app (#773): the pill at the
// composer counts what main reports, the popover leads into the settings, and
// the model reads the same state with get_configuration — without the
// instructions of a skill that is off ever reaching it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, sendChat } from './helpers/app.mjs';

const BODY_MARKER = 'PDF-EXPORT-BODY-7731';

async function writeSkill(dir, name, description, body) {
  await mkdir(path.join(dir, name), { recursive: true });
  await writeFile(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'utf8');
}

test('pill, popover and get_configuration report the same skills and tools', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-chat-config-');
  const userDataDir = await makeTempDir('snotra-chat-config-userdata-');
  const home = await makeTempDir('snotra-chat-config-home-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await writeSkill(path.join(workspace, '.agents', 'skills'), 'release', 'Cuts a release.', 'Release steps.');
  await writeSkill(path.join(home, '.snotra', 'skills'), 'pdf-export', 'Turns Markdown into a PDF.', BODY_MARKER);
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({
    appLocale: 'en',
    activeWorkspaceSkills: { [path.resolve(workspace)]: ['release'] },
    disabledTools: ['fetch_url'],
  }), 'utf8');

  const snotra = await launchApp({ userDataDir, home });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;
  const label = () => page.evaluate(() => document.getElementById('chat-config-label').textContent);

  // Three system skills and the folder's release; pdf-export is off.
  await poll(async () => (await label()) === '4 skills', {
    what: 'the pill counting four skills',
    explain: async () => `label: ${await label()}\nmain:\n${snotra.mainOutput()}`,
  });

  // The model asks what is on.
  model.queueAnswer({ match: 'What is switched on', toolCalls: [{ name: 'get_configuration', arguments: {} }] });
  model.queueAnswer({ text: 'pdf-export is off.' });
  await sendChat(page, 'What is switched on here?');
  const toolResult = () => {
    const request = model.requests.find((r) => !r.isTitleRequest && r.body.messages?.some((m) => m.role === 'tool'));
    const message = request?.body.messages.find((m) => m.role === 'tool');
    return message ? JSON.parse(message.content) : null;
  };
  await poll(() => toolResult() !== null, {
    what: 'the get_configuration result sent back to the model',
    explain: async () => JSON.stringify(model.describeRequests(), null, 1),
  });
  const answer = toolResult();
  const skill = (name) => answer.skills.find((entry) => entry.name === name);
  assert.equal(skill('release').state, 'on');
  assert.equal(skill('release').origin, 'folder');
  assert.equal(skill('pdf-export').state, 'off');
  assert.equal(skill('pdf-export').description, 'Turns Markdown into a PDF.');
  assert.equal(answer.skills_settings, 'Settings › Skills');
  assert.deepEqual(answer.tools_off.find((tool) => tool.name === 'fetch_url'),
    { name: 'fetch_url', reason: 'switched off by the user', settings: 'Settings › Tools & security' });
  assert.ok(answer.tools_on.includes('read_file_text'));
  // The instructions of a skill that is off reach the model nowhere — not in
  // this result, not in any prompt (#18).
  assert.equal(JSON.stringify(model.requests.map((r) => r.body)).includes(BODY_MARKER), false);

  // The popover shows the same, and its button leads to the setting.
  await page.click('#btn-chat-config');
  await poll(() => page.evaluate(() => document.querySelectorAll('#chat-config-popup .chat-config-row--tool').length > 0),
    { what: 'popover rows' });
  const rows = await page.evaluate(() => ({
    skills: [...document.querySelectorAll('#chat-config-popup .chat-config-row--skill')]
      .map((row) => `${row.querySelector('.chat-config-name').textContent}:${row.classList.contains('chat-config-row--off') ? 'off' : 'on'}`),
    tools: [...document.querySelectorAll('#chat-config-popup .chat-config-row--tool .chat-config-name')].map((node) => node.textContent),
  }));
  assert.ok(rows.skills.includes('release:on'), JSON.stringify(rows));
  assert.ok(rows.skills.includes('pdf-export:off'), JSON.stringify(rows));
  assert.ok(rows.tools.includes('fetch_url'), JSON.stringify(rows));
  assert.ok(rows.tools.includes('web_search'), JSON.stringify(rows));

  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#chat-config-popup .chat-config-row--tool')]
      .find((item) => item.querySelector('.chat-config-name').textContent === 'web_search');
    row.querySelector('.chat-config-action').click();
  });
  await poll(() => page.evaluate(() => document.activeElement?.id === 'heading-web-search'
    && !document.getElementById('panel-settings-tools').hidden), {
    what: 'Tool setup open on Web search',
    explain: async () => page.evaluate(() => `active: ${document.activeElement?.id || document.activeElement?.tagName}`),
  });
  await page.keyboard.press('Escape');
  await poll(() => page.evaluate(() => document.getElementById('modal-settings').classList.contains('hidden')),
    { what: 'settings closed' });

  // "/pdf-export" switches it on for this chat only.
  model.queueAnswer({ match: 'the changelog', text: 'Done.' });
  await sendChat(page, '/pdf-export the changelog');
  await poll(async () => (await label()) === '5 skills', {
    what: 'the pill counting the invoked skill',
    explain: async () => `label: ${await label()}`,
  });
  await page.click('#btn-chat-config');
  await poll(() => page.evaluate(() => [...document.querySelectorAll('#chat-config-popup .chat-config-row--skill')]
    .some((row) => row.textContent.includes('pdf-export') && row.querySelector('.chat-config-tag')?.textContent === 'this chat only')),
  { what: 'pdf-export marked for this chat only' });

  // A new chat starts without it.
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.getElementById('btn-chat-new').click());
  await poll(async () => (await label()) === '4 skills', {
    what: 'a new chat without the invoked skill',
    explain: async () => `label: ${await label()}`,
  });
});
