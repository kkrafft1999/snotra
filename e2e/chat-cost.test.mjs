// The estimated chat cost in the real app (#949): the chip appears after the
// first answer, sums the turns, shows in the history, and comes back after a
// restart with the chat.
//
// The fake model runs on localhost, which Snotra prices as a local model
// ($0). A price of the user's own wins over that, so the test sets one —
// the path a user with a local proxy to a paid API takes as well.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, waitForFolderChat, sendChat } from './helpers/app.mjs';

// The fake model reports 11 prompt and 7 completion tokens per answer:
// 11 × $0.01 + 7 × $0.02 = $0.25 per turn.
const PRICE = { input: 0.01, output: 0.02 };

function chipText(page) {
  return page.evaluate(() => {
    const wrap = document.querySelector('.chat-cost-wrap');
    return wrap && !wrap.hidden ? document.getElementById('chat-cost-value').textContent : null;
  });
}

async function showHistory(page) {
  await page.evaluate(() => {
    if (document.getElementById('app').classList.contains('app--no-history')) {
      document.getElementById('btn-toggle-chat-history').click();
    }
  });
}

function currentHistoryCost(page) {
  return page.evaluate(() => document.querySelector('.chat-history-row--current .chat-history-row-cost')?.textContent ?? null);
}

test('the chat cost adds up, shows in the history and survives a restart', { timeout: 180000 }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-chat-cost-');
  const userDataDir = await makeTempDir('snotra-chat-cost-userdata-');
  await writeFile(path.join(workspace, 'README.md'), '# Example\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(path.join(userDataDir, 'ui-preferences.json'), JSON.stringify({ appLocale: 'en' }), 'utf8');
  await writeFile(path.join(userDataDir, 'model-prices.json'), JSON.stringify({ overrides: { 'fake-model': PRICE } }), 'utf8');
  t.after(() => model.close());

  let snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));
  let { page } = snotra;
  const explain = async () => [
    `chip: ${await chipText(page).catch(() => '?')}`,
    `model requests: ${JSON.stringify(model.describeRequests(), null, 1)}`,
    `main:\n${snotra.mainOutput()}`,
  ].join('\n');
  await waitForFolderChat(page, { explain });

  // Nothing spent yet: no chip, and in particular no "$0.00".
  assert.equal(await chipText(page), null);

  model.queueAnswer({ match: 'COST-1', text: 'First answer.' });
  await sendChat(page, 'COST-1', { explain, t });
  await poll(async () => (await chipText(page)) === '~$0.25', { what: 'the cost of the first turn', explain });

  model.queueAnswer({ match: 'COST-2', text: 'Second answer.' });
  await sendChat(page, 'COST-2', { explain, t });
  await poll(async () => (await chipText(page)) === '~$0.50', { what: 'the cost of both turns', explain });

  // The popover splits it by model and kind of token.
  await page.evaluate(() => document.getElementById('chat-cost').click());
  const popover = await page.evaluate(() => {
    const panel = document.getElementById('chat-cost-breakdown');
    return {
      open: !panel.classList.contains('hidden'),
      models: [...panel.querySelectorAll('.chat-cost__model-name')].map((n) => n.textContent),
      rows: [...panel.querySelectorAll('tbody th')].map((n) => n.textContent),
      text: panel.textContent,
    };
  });
  assert.equal(popover.open, true);
  assert.deepEqual(popover.models, ['fake-model']);
  assert.deepEqual(popover.rows, ['Input', 'Output']);
  assert.match(popover.text, /~\$0\.50 · 22 in \/ 14 out · estimate/);
  await page.keyboard.press('Escape');

  await showHistory(page);
  await poll(async () => (await currentHistoryCost(page)) === '~$0.50', { what: 'the cost in the history', explain });

  // After a restart the chat comes back with its sum.
  await snotra.stop();
  snotra = await launchApp({ userDataDir });
  page = snotra.page;
  await waitForFolderChat(page, { explain });
  await poll(async () => (await chipText(page)) === '~$0.50', { what: 'the cost after the restart', explain });
  await showHistory(page);
  await poll(async () => (await currentHistoryCost(page)) === '~$0.50', { what: 'the cost in the history after the restart', explain });
});
