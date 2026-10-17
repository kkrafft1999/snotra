// A run cut off half-way keeps its finished steps and says that it was cut
// off (#979) — whether the app was killed, quit or its window reloaded.
//
// The model answers the first round with a tool call and holds the second
// round after its first chunk, so the run is in flight with one step done. The
// renderer saves the turn after that step; what comes back is that save.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat, sendChat, rendererToolEvents } from './helpers/app.mjs';

const HELD_TEXT = 'This answer never finishes.';

/**
 * Ends the app the way a crash does: no quit, no unload. On Windows the whole
 * tree goes — killing only the main process left its renderer and GPU
 * processes behind, they kept the profile's single-instance lock, and the
 * restart quit at once (#979).
 */
async function killHard(child) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGKILL');
  await exited;
}

/** The chat as main hands it out — the saved state, not the one on screen. */
async function savedTurn(page) {
  const history = await page.evaluate(() => window.electronAPI.getChatHistory());
  const session = (history?.sessions || []).find((s) => s.messages.some((m) => /CUT-OFF/.test(m.content)));
  return session ? session.messages[session.messages.length - 1] : null;
}

function shownChat(page) {
  return page.evaluate(() => {
    const list = document.getElementById('chat-messages');
    const turn = [...list.querySelectorAll('.chat-msg.assistant')].pop();
    return {
      text: list.textContent.replace(/\s+/g, ' ').trim(),
      note: turn?.querySelector('.chat-interrupted-note')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      log: turn?.querySelector('.chat-tool-log')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
      running: document.getElementById('btn-chat-send')?.classList.contains('chat-send--stop') ?? null,
    };
  });
}

for (const how of ['kill', 'quit', 'reload']) {
  test(`a run cut off by a ${how} comes back with its finished step, marked as interrupted`, { timeout: 180000 }, async (t) => {
    const model = await startFakeModel();
    const workspace = await makeTempDir(`snotra-cut-off-${how}-`);
    const userDataDir = await makeTempDir(`snotra-cut-off-${how}-userdata-`);
    await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
    await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
    await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
    t.after(() => model.close());

    let snotra = await launchApp({ userDataDir });
    t.after(() => snotra.stop().catch(() => {}));
    let { page } = snotra;
    const explain = async () => [
      `saved turn: ${JSON.stringify(await savedTurn(page).catch((e) => String(e)))}`,
      `shown: ${JSON.stringify(await shownChat(page).catch((e) => String(e)))}`,
      `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}`,
      `renderer tool events: ${await rendererToolEvents(page).catch((e) => String(e))}`,
      `main:\n${snotra.mainOutput()}`,
    ].join('\n');
    await waitForFolderChat(page, { explain });

    model.queueAnswer({ match: 'CUT-OFF', toolCalls: [{ name: 'list_directory', arguments: { relative_path: '' } }] });
    model.queueAnswer({ match: 'CUT-OFF', text: HELD_TEXT, holdUntil: new Promise(() => {}) });
    await sendChat(page, 'What is in this folder? CUT-OFF', { t, explain });

    // The second round is under way and held: the step before it is done.
    const heldRound = () => model.requests.find((r) => r.answer?.text === HELD_TEXT) ?? null;
    await poll(async () => {
      // A read needs no approval in the default mode; should a card come up
      // all the same, it is answered so the run gets to its second round.
      await page.evaluate(() => {
        document.querySelector('.chat-approval-card button[data-response="allow-once"]:not([disabled])')?.click();
      });
      return heldRound() !== null;
    }, { what: 'the second round under way', timeoutMs: 60000, explain });

    // The step is saved while the run goes on, and the turn as cut off.
    await poll(async () => {
      const turn = await savedTurn(page);
      return turn?.interrupted === true && turn.toolTrace.some((e) => e?.tool === 'list_directory');
    }, { what: 'the finished step saved mid-run', explain });
    assert.equal((await shownChat(page)).running, true, 'the run is still going when it is cut off');

    if (how === 'kill') {
      // On Windows the key that encrypts the history lives in Chromium's
      // `Local State`, which is written a few seconds after the first start.
      // A kill before that loses the key, and the restart has to set the
      // history aside as undecryptable — a different story from this one.
      if (process.platform === 'win32') {
        await poll(async () => (await readFile(path.join(userDataDir, 'Local State'), 'utf8').catch(() => '')).includes('encrypted_key'),
          { what: 'the encryption key written to Local State', timeoutMs: 60000, explain });
      }
      // No quit, no unload: the process is gone at once, as in a crash.
      await killHard(snotra.app.process());
    } else if (how === 'quit') {
      await snotra.stop();
    } else {
      await page.reload();
      // Main stops the run of the reloaded window: the held round is aborted.
      await poll(() => heldRound()?.aborted === true, { what: 'the held round aborted after the reload', explain });
    }

    if (how !== 'reload') {
      snotra = await launchApp({ userDataDir });
      page = snotra.page;
    }
    await poll(async () => (await shownChat(page)).note !== null, {
      what: 'the restored chat with its interrupted note', timeoutMs: 30000, explain,
    });
    const shown = await shownChat(page);
    assert.match(shown.note, /^Interrupted\. Snotra was closed or reloaded before this answer was finished/);
    assert.match(shown.text, /What is in this folder\? CUT-OFF/, 'the question is there');
    assert.match(shown.log ?? '', /Project folder searched/, 'the finished step is there');
    assert.doesNotMatch(shown.text, /This answer/, 'the round that was cut off left no text behind');
    assert.equal(shown.running, false, 'nothing runs after the restore');
  });
}
