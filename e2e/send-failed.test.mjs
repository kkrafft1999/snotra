// A send that throws after taking its draft is not lost (#919). In the real
// app: the text goes back into the input, the composer says so, the error
// reaches main's log and the debug buffer, and the next try gets through.
//
// Before, the same throw left an empty input, the greeting alone, no request
// and an empty log — the trace of a message dropped "at start-up" while the
// config proposal test of #774 was being written.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import {
  launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat, sendChat, composerState, rendererToolEvents,
} from './helpers/app.mjs';

test('a send that throws gives its draft back and says why, the next one goes through', { timeout: 120000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-send-failed-');
  const userDataDir = await makeTempDir('snotra-send-failed-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;
  const explain = async () => [
    `composer: ${JSON.stringify(await composerState(page))}`,
    `note: ${await page.evaluate(() => document.getElementById('chat-token-usage-value')?.textContent)}`,
    `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}`,
    `renderer tool events: ${await rendererToolEvents(page)}`,
    `main:\n${snotra.mainOutput()}`,
  ].join('\n');
  await waitForFolderChat(page, { explain });

  // The chat taking in the user's message throws, once — standing in for
  // whatever breaks between taking the draft and starting the run.
  await page.evaluate(() => {
    const original = Array.prototype.push;
    Array.prototype.push = function push(...items) {
      if (items[0]?.role === 'user' && String(items[0]?.content).includes('MARK-F')) {
        Array.prototype.push = original;
        throw new Error('injected send failure');
      }
      return original.apply(this, items);
    };
  });
  // A raw click on purpose, not sendChat: this send is meant to fail and give
  // the draft back, which is exactly what sendChat would report as an error.
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Read the page MARK-F';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });

  await poll(() => page.evaluate(() => document.getElementById('chat-input').value === 'Read the page MARK-F'),
    { what: 'the draft back in the input', explain });
  const note = await page.evaluate(() => document.getElementById('chat-token-usage-value').textContent);
  assert.equal(note, 'Not sent');
  const messages = await page.evaluate(() => [...document.querySelectorAll('#chat-messages > .chat-msg')]
    .map((el) => el.className));
  assert.equal(messages.some((name) => /\buser\b/.test(name)), false, JSON.stringify(messages));
  assert.equal(model.requests.length, 0);
  assert.match(await rendererToolEvents(page), /send failed \{"message":"injected send failure"/);
  await poll(() => /\[renderer\] \[chat\] send failed: Error: injected send failure/.test(snotra.mainOutput()),
    { what: "the failure in main's log", explain });

  // Sent again, it reaches the model.
  model.queueAnswer({ match: 'MARK-F', text: 'Read it.' });
  await sendChat(page, 'Read the page MARK-F', { explain, t });
  await poll(() => model.requests.some((r) => !r.isTitleRequest
    && r.body.messages?.some((m) => m.role === 'user' && String(m.content).includes('MARK-F'))),
  { what: 'the second try reaching the model', explain });
  await poll(() => page.evaluate(() => [...document.querySelectorAll('#chat-messages > .chat-msg.user')]
    .some((el) => el.textContent.includes('MARK-F'))), { what: 'the user bubble', explain });
});

test('an error nobody catches in the renderer reaches the debug buffer and main', { timeout: 120000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-uncaught-');
  const userDataDir = await makeTempDir('snotra-uncaught-userdata-');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

  const snotra = await launchApp({ userDataDir });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;
  // The renderer's modules, and with them the listeners, are in place.
  await waitForFolderChat(page);
  await page.evaluate(() => {
    setTimeout(() => { throw new Error('UNCAUGHT-THROW'); }, 0);
    void Promise.reject(new Error('UNCAUGHT-REJECTION'));
  });
  await poll(async () => {
    const events = await rendererToolEvents(page);
    return events.includes('"source":"error","message":"UNCAUGHT-THROW"')
      && events.includes('"source":"rejection","message":"UNCAUGHT-REJECTION"');
  }, { what: 'both errors in the debug buffer', explain: () => rendererToolEvents(page) });
  await poll(() => /\[renderer\].*UNCAUGHT-THROW/.test(snotra.mainOutput())
    && /\[renderer\].*UNCAUGHT-REJECTION/.test(snotra.mainOutput()),
  { what: "both errors in main's log", explain: () => snotra.mainOutput() });
});
