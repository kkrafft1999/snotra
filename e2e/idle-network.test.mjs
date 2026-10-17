// PRI-1: an idle session contacts nothing (#988, AR-13).
//
// docs/quality-requirements.md says the app runs without the user sending
// anything, and that with the update check switched off it contacts nothing at
// all. Until this test nothing measured that. It starts the real app with the
// update check off (launchApp sets SNOTRA_NO_UPDATE_CHECK), lets it sit with a
// folder open and a few words typed into the composer, and asserts that no
// request left the machine — not from the renderer, not from main's Node
// stack, not from Chromium's spell checker, which fetches dictionaries from a
// CDN on Windows and Linux.
//
// The second test keeps the first honest: a probe that sees nothing proves
// nothing unless it is shown to see a request when there is one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat } from './helpers/app.mjs';
import { networkProbeLaunchOptions, mainRecords, readNetLog, outbound } from './helpers/network-probe.mjs';

// Long enough for what an app does on its own after the start: a dictionary
// download begins within a second of the first text field, timers of a few
// seconds come due. Not a wait for something to happen, only a window to watch.
const IDLE_MS = 10_000;

async function startProbed(t) {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-idle-ws-');
  const userDataDir = await makeTempDir('snotra-idle-userdata-');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  const { netLogFile, options } = await networkProbeLaunchOptions();
  const snotra = await launchApp({ userDataDir, ...options });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await snotra.stop();
  };
  t.after(async () => {
    await stop().catch(() => {});
    await model.close();
  });
  await waitForFolderChat(snotra.page);
  return { snotra, model, netLogFile, stop };
}

test('an idle session sends no request anywhere (PRI-1)', { timeout: 120000 }, async (t) => {
  const { snotra, netLogFile, stop } = await startProbed(t);
  const { page } = snotra;

  // A misspelled sentence in the composer: the spell checker only starts its
  // work, and its dictionary, once there is text to check.
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.focus();
    input.value = 'Teh quik brwn fox jumpd ovr the lazi dog';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await new Promise((resolve) => setTimeout(resolve, IDLE_MS));

  const fromMain = await mainRecords(snotra);
  assert.ok(Array.isArray(fromMain), 'the probe is loaded into main');
  await stop();
  const fromChromium = await readNetLog(netLogFile);

  const outbound_ = [...outbound(fromMain), ...outbound(fromChromium)];
  assert.deepEqual(outbound_, [], `an idle session must not leave the machine, but it did:\n${outbound_.join('\n')}`);
});

test('the probe sees a request when there is one', { timeout: 120000 }, async (t) => {
  const { snotra, model, netLogFile, stop } = await startProbed(t);
  const url = `${model.baseUrl.replace(/\/$/, '')}/probe-check`;

  await snotra.app.evaluate(async ({ net }, target) => {
    await fetch(target).catch(() => {});
    await net.fetch(target).catch(() => {});
  }, url);

  const fromMain = await mainRecords(snotra);
  await stop();
  const fromChromium = await readNetLog(netLogFile);

  assert.ok(fromMain.some((r) => r.kind === 'fetch' && r.url === url), "main's fetch is recorded");
  const port = Number(new URL(url).port);
  assert.ok(fromMain.some((r) => r.kind === 'socket' && r.port === port), "main's socket to the server is recorded");
  assert.ok(fromChromium.some((r) => r.url === url), "Chromium's net.fetch is in the net log");
  assert.ok(fromChromium.some((r) => r.address?.endsWith(`:${port}`)), "Chromium's connection to the server is in the net log");
  // It is loopback, so the idle assertion would let it pass — by design.
  assert.deepEqual([...outbound(fromMain), ...outbound(fromChromium)], []);
});
