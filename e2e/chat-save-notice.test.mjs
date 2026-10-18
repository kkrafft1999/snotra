// A chat that cannot be saved says so, in the real app (#977).
//
// The history's index (`chat-history/index.json`, #985) is made a folder: it
// is there, and reading it fails on every platform. Main then skips each save
// rather than write an empty history over it (#473) — and the chat has to say
// that its chats are not being kept. Once the file can be read again, the next
// save goes through and the banner goes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat, sendChat, storedChats } from './helpers/app.mjs';
import { removeDir } from '../test/helpers/temp-dir.js';

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
  const historyFile = path.join(userDataDir, 'chat-history', 'index.json');
  await mkdir(historyFile, { recursive: true });
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
  await removeDir(historyFile);
  model.queueAnswer({ match: 'SAVE-2', text: 'About 2 cm deep.' });
  await sendChat(page, 'And how deep? SAVE-2', { explain });
  await poll(async () => (await banner(page)) === null, { what: 'the banner to go', explain });
  // Waits for the state with SAVE-2, not for any file: on Windows a write
  // from the failed round may still be retrying its rename onto the folder
  // (#472) and land first, with the older state. The writes to one file run
  // one after the other, so the newer one follows it.
  const savedContents = async () => (await storedChats(page)).flatMap((s) => s.messages.map((m) => m.content)).join('\n');
  await poll(async () => /SAVE-2/.test(await savedContents()), { what: 'a saved history with SAVE-2', explain });
  assert.ok((await readFile(historyFile, 'utf8')).length > 0, 'the history is on disk again');
  assert.match(await savedContents(), /SAVE-1/, 'the question asked while saves failed is saved too');
});
