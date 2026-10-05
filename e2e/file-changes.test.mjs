// "Show changes" in the running app (#348): an edit by the agent gets a chip
// under the answer, the chip opens the diff in the preview column, the switch
// goes back to the content — and after a restart the chip stays as a record
// that says the change is no longer kept.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

test('an edit can be opened as a diff from the chat, and is gone after a restart', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-changes-');
  const userDataDir = await makeTempDir('snotra-changes-userdata-');
  await writeFile(path.join(workspace, 'notes.txt'), 'one\ntwo\nthree\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  let snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  let { page } = snotra;

  // What the app shows and what the model was asked, for a wait that runs
  // out. Only ever seen failing on a fresh macOS runner (#679, #689), never
  // locally — so the failure has to bring its own evidence.
  const evidence = async (target) => {
    const shown = await target.page.evaluate(() => ({
      messages: [...document.querySelectorAll('#chat-messages > li')]
        .map((li) => `${li.className}: ${li.textContent.replace(/\s+/g, ' ').slice(0, 120)}`),
      cards: [...document.querySelectorAll('.chat-approval-card')].map((card) => ({
        state: card.dataset.state ?? null,
        buttons: [...card.querySelectorAll('button[data-response]')]
          .map((b) => `${b.dataset.response}${b.disabled ? ' (disabled)' : ''}${b.closest('[hidden]') ? ' (hidden)' : ''}`),
      })),
      sendButton: document.getElementById('btn-chat-send')?.className ?? null,
      changes: [...document.querySelectorAll('.chat-changes > *')]
        .map((el) => `${el.tagName.toLowerCase()}.${el.className}`),
    })).catch((e) => ({ error: String(e) }));
    return [
      `app: ${JSON.stringify(shown, null, 1)}`,
      `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}`,
      `answers not taken: ${JSON.stringify(model.pendingAnswers())}`,
      `profile: ${(await readdir(userDataDir).catch((e) => [String(e)])).join(', ')}`,
      `notes.txt: ${JSON.stringify(await readFile(path.join(workspace, 'notes.txt'), 'utf8').catch((e) => String(e)))}`,
      `main:\n${target.mainOutput()}`,
    ].join('\n');
  };

  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  model.queueAnswer({
    match: 'Fix the second line',
    toolCalls: [{ name: 'edit_file', arguments: { relative_path: 'notes.txt', old_string: 'two', new_string: 'TWO' } }],
  });
  model.queueAnswer({ text: 'Done.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Fix the second line.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });
  await poll(async () => {
    await page.evaluate(() => {
      document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])')?.click();
    });
    return page.evaluate(() =>
      !document.getElementById('btn-chat-send').classList.contains('chat-send--stop')
      && Boolean(document.querySelector('.chat-changes button.chat-change-file')));
  }, { what: 'run through with a chip', timeoutMs: 60000, explain: () => evidence(snotra) });

  const chip = await page.evaluate(() => {
    const button = document.querySelector('.chat-changes button.chat-change-file');
    return { label: button.getAttribute('aria-label'), text: button.textContent };
  });
  assert.equal(chip.label, 'Show changes to notes.txt: 1 line added, 1 line removed');

  await page.click('.chat-changes button.chat-change-file');
  await poll(() => page.evaluate(() => document.querySelectorAll('#preview-body .diff-row').length > 0),
    { what: 'diff rows' });
  const diff = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('#preview-body .diff-row')].map((row) =>
      `${row.querySelector('.diff-mark span[aria-hidden]').textContent || ' '}${row.querySelector('.diff-text').textContent}`),
    meta: document.getElementById('preview-meta').textContent,
    selected: document.querySelector('#tree-container .tree-item.active')?.dataset.path ?? null,
  }));
  assert.deepEqual(diff.rows, [' one', '−two', '+TWO', ' three']);
  assert.equal(diff.meta, '+1 −1');
  assert.ok(diff.selected?.endsWith('notes.txt'), 'the row of the file is selected');

  await page.click('#preview-tools input[value="content"]', { force: true });
  await poll(() => page.evaluate(() => document.getElementById('preview-content')?.textContent === 'one\nTWO\nthree\n'),
    { what: 'content after the switch' });

  // A restart forgets the snapshots; the chat keeps the record.
  const firstStart = snotra;
  await firstStart.stop();
  snotra = await launchApp({ userDataDir });
  page = snotra.page;
  await poll(() => page.evaluate(() => Boolean(document.querySelector('.chat-changes'))), {
    what: 'restored chat with its changed files',
    timeoutMs: 30000,
    // What the restart found, next to main's output of the first start: did
    // the chat come back at all, was the history file set aside?
    explain: async () => `${await evidence(snotra)}\nmain, first start:\n${firstStart.mainOutput()}`,
  });
  const after = await page.evaluate(() => ({
    buttons: document.querySelectorAll('.chat-changes button').length,
    note: document.querySelector('.chat-changes-note')?.textContent ?? null,
  }));
  assert.equal(after.buttons, 0);
  assert.equal(after.note, 'Changes are no longer available (app restarted).');
});
