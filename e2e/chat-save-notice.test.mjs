// A chat that cannot be saved says so, in the real app (#977).
//
// `chat-history.json` is made a folder: it is there, and reading it fails on
// every platform. Main then skips each save rather than write an empty history
// over it (#473) — and the chat has to say that its chats are not being kept.
// Once the file can be read again, the next save goes through and the banner goes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat, sendChat } from './helpers/app.mjs';

function banner(page) {
  return page.evaluate(() => {
    const el = document.getElementById('chat-save-notice');
    return el && !el.hidden ? el.textContent.replace(/\s+/g, ' ').trim() : null;
  });
}

test('an unreadable chat history shows the banner until a save goes through again', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-save-notice-');
  const userDataDir = await makeTempDir('snotra-save-notice-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  const historyFile = path.join(userDataDir, 'chat-history.json');
  await mkdir(historyFile);
  t.after(() => model.close());

  const snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  const { page } = snotra;
  const explain = async () => [
    `banner: ${await banner(page).catch(() => '?')}`,
    `main:\n${snotra.mainOutput()}`,
  ].join('\n');
  await waitForFolderChat(page, { explain });
  assert.equal(await banner(page), null, 'nothing to say before anything was to be saved');

  model.queueAnswer({ match: 'SAVE-1', text: 'Rows 20 cm apart.' });
  await sendChat(page, 'How far apart do the radishes go? SAVE-1', { explain });
  await poll(() => banner(page), { what: 'the banner', explain });
  const text = await banner(page);
  assert.match(text, /This chat is not being saved\./);
  assert.match(text, /could not read the chat history/);
  assert.match(text, /What can I do\?/);
  await poll(() => page.evaluate(() => /Rows 20 cm apart/.test(document.getElementById('chat-messages').textContent)),
    { what: 'the answer', explain });
  assert.ok((await stat(historyFile)).isDirectory(), 'the unreadable file is left as it was');
  assert.ok(await banner(page), 'still there after the answer was not saved either');

  // Readable again: the next save goes through and takes the whole chat along.
  await rm(historyFile, { recursive: true, force: true });
  model.queueAnswer({ match: 'SAVE-2', text: 'About 2 cm deep.' });
  await sendChat(page, 'And how deep? SAVE-2', { explain });
  await poll(async () => (await banner(page)) === null, { what: 'the banner to go', explain });
  await poll(async () => {
    const saved = await readFile(historyFile, 'utf8').catch(() => '');
    return saved.length > 0;
  }, { what: 'a saved history', explain });
  const history = await page.evaluate(() => window.electronAPI.getChatHistory());
  const contents = history.sessions.flatMap((s) => s.messages.map((m) => m.content)).join('\n');
  assert.match(contents, /SAVE-1/, 'the question asked while saves failed is saved too');
  assert.match(contents, /SAVE-2/);
});
