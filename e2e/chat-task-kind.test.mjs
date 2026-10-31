// The chat's kind of task in the header, in the real app (#1282): the pill
// shows the kind the model named with the title, a pick by keyboard is stored
// as the user's, and both the pick and its source come back after a restart.
//
// The fake model answers the title request with a title on the first line and
// the kind on the second, as the request asks (#1281).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat, sendChat } from './helpers/app.mjs';

function pill(page) {
  return page.evaluate(() => {
    const wrap = document.getElementById('chat-kind-wrap');
    const button = document.getElementById('btn-chat-kind');
    return {
      shown: !wrap.classList.contains('hidden'),
      text: button.textContent.trim(),
      name: button.getAttribute('aria-label'),
      unclassified: button.classList.contains('chat-kind-pill--unclassified'),
    };
  });
}

test('the kind of task shows in the header, is changed by keyboard and survives a restart', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-task-kind-');
  const userDataDir = await makeTempDir('snotra-task-kind-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  t.after(() => model.close());

  let snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  let { page } = snotra;
  const explain = async () => [
    `pill: ${JSON.stringify(await pill(page).catch(() => '?'))}`,
    `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}`,
    `main:\n${snotra.mainOutput()}`,
  ].join('\n');
  await waitForFolderChat(page, { explain });
  assert.equal((await pill(page)).shown, false, 'a chat without a question shows no kind');

  model.setTitle('Flaky sandbox test\ncoding');
  model.queueAnswer({ match: 'KIND-1', text: 'The test waits on a timer; poll instead.' });
  await sendChat(page, 'KIND-1 Why does the sandbox test fail now and then?', { explain, t });
  await poll(async () => (await pill(page)).text === 'Coding', { what: 'the kind the model named', explain });
  assert.equal((await pill(page)).name, 'Kind of task: Coding. Suggested by the model. Change kind');

  // By keyboard: focus the pill, open, walk to "Data & analysis", pick.
  await page.focus('#btn-chat-kind');
  await page.keyboard.press('Enter');
  await poll(() => page.evaluate(() => document.activeElement?.dataset.kind === 'coding'), { what: 'focus on the current kind', explain });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await poll(async () => (await pill(page)).text === 'Data & analysis', { what: 'the picked kind', explain });
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'btn-chat-kind', 'the focus is back on the pill');
  assert.equal(await page.evaluate(() => document.getElementById('chat-kind-menu').classList.contains('hidden')), true);

  // After a restart the chat comes back with the user's kind.
  await snotra.stop();
  snotra = await launchApp({ userDataDir });
  page = snotra.page;
  await waitForFolderChat(page, { explain });
  await poll(async () => (await pill(page)).text === 'Data & analysis', { what: 'the kind after the restart', explain });
  assert.equal((await pill(page)).name, 'Kind of task: Data & analysis. Set by you. Change kind');
});
