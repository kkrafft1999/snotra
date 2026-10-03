// The middle column opens with the folder's README (#351), in the real app:
// at the start, on every folder switch, closed again for a folder without one
// or with one too large to show, and closed for a restored chat (#208).
//
// Every step is a change of state the test waits for, so that no step passes
// just because the app had not got round to it yet.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const column = (page) => page.evaluate(() => ({
  open: !document.getElementById('app').classList.contains('app--no-preview'),
  file: document.getElementById('file-preview').classList.contains('hidden')
    ? null
    : document.getElementById('preview-filename').textContent,
  doc: document.querySelector('.md-doc')?.textContent ?? null,
  root: document.getElementById('project-name')?.textContent ?? null,
  selected: document.querySelector('#tree-container .tree-item.active')?.dataset.path ?? null,
}));

test('the column opens with the folder README and follows every folder switch', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const base = await makeTempDir('snotra-readme-');
  const userDataDir = await makeTempDir('snotra-readme-userdata-');
  const folders = {
    room: { 'README.md': '# Room\n\nWhat this folder is about.\n', 'main.js': '\n' },
    plain: { 'main.js': '\n', 'AGENTS.md': '# Agents\n' },
    second: { 'README.md': '# Second\n\nAnother folder.\n' },
    huge: { 'README.md': `# Huge\n\n${'y'.repeat(1024 * 1024 + 1)}\n` },
  };
  const dirs = {};
  for (const [name, files] of Object.entries(folders)) {
    dirs[name] = path.join(base, name);
    await mkdir(dirs[name]);
    for (const [file, content] of Object.entries(files)) await writeFile(path.join(dirs[name], file), content);
  }
  await prepareUserData(userDataDir, { workspace: dirs.room, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'folder-history.json'), JSON.stringify({ paths: Object.values(dirs) }));

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;

  const switchTo = (name) => page.evaluate((folderPath) => {
    document.querySelector(`#folder-history-menu [role="menuitem"][data-path="${CSS.escape(folderPath)}"]`).click();
  }, dirs[name]);
  const waitFor = (what, check) => poll(async () => {
    const state = await column(page);
    return check(state) ? state : null;
  }, { what });

  // The start: no stored choice, no chat — the README opens the column.
  let state = await waitFor('README shown at the start', (s) => s.open && s.file === 'README.md' && s.doc?.includes('What this folder is about'));
  assert.equal(state.selected, null, 'shown, not selected');

  model.queueAnswer({ match: 'Hello', text: 'Hi.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Hello';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });
  await poll(() => page.evaluate(() =>
    !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
    && document.querySelectorAll('#chat-messages .chat-msg.assistant').length > 0), { what: 'answer' });

  // No README (AGENTS.md does not count): closed, as before #351.
  await switchTo('plain');
  await waitFor('column closed for a folder without a README', (s) => s.root === 'plain' && !s.open);

  // A folder with one opens it again, with its own README.
  await switchTo('second');
  await waitFor('README of the second folder', (s) => s.root === 'second' && s.open && s.doc?.includes('Another folder'));

  // Back in the folder with the chat: the chat is restored and wins (#208).
  await switchTo('room');
  await waitFor('column closed for the restored chat', (s) => s.root === 'room' && !s.open);

  // A README too large to show is no reason to open the column.
  await switchTo('second');
  await waitFor('README of the second folder again', (s) => s.root === 'second' && s.open);
  await switchTo('huge');
  await waitFor('column closed for a README too large to show', (s) => s.root === 'huge' && !s.open);
});
