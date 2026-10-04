// The app under test sees a home folder of its own (#702).
//
// --user-data-dir moves the profile, but main reads global memory, global
// instructions and global skills below the home folder. Before #702 every e2e
// run on a developer machine read that developer's real ones, and their content
// ended up in prompts and in the output of failing assertions. launchApp now
// hands each start an empty home of its own; this test plants a sentinel in one
// and checks that it is the one the app reads, all the way into the prompt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir } from './helpers/app.mjs';

const SENTINEL = 'home-sentinel-702-only-in-the-test-home';

// launchApp leaves the home folder alone on Windows (see there).
const skip = process.platform === 'win32' ? 'the home folder is not isolated on Windows yet' : false;

const appHome = (snotra) => snotra.app.evaluate(() => process.getBuiltinModule('node:os').homedir());

test('the app reads global memory from the test home, never from the real one', { timeout: 120000, skip }, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-home-ws-');
  const userDataDir = await makeTempDir('snotra-home-userdata-');
  const home = await makeTempDir('snotra-home-planted-');
  await mkdir(path.join(home, '.snotra'), { recursive: true });
  await writeFile(path.join(home, '.snotra', 'memory.md'), `# Memory · global\n- 2026-10-04 — ${SENTINEL}\n`, 'utf8');
  await writeFile(path.join(workspace, 'notes.txt'), 'one\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });

  const snotra = await launchApp({ userDataDir, home });
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });
  const { page } = snotra;

  assert.equal(snotra.home, home);
  assert.equal(path.resolve(await appHome(snotra)), path.resolve(home));

  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });
  model.queueAnswer({ match: 'Who am I?', text: 'Nobody yet.' });
  await page.evaluate(() => {
    const input = document.getElementById('chat-input');
    input.value = 'Who am I?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  });
  await poll(() => Boolean(model.requestFor('Who am I?')), { what: 'request at the model', timeoutMs: 30000 });
  // Only whether it is there — the prompt itself is not printed.
  const body = JSON.stringify(model.requestFor('Who am I?').body);
  assert.ok(body.includes(SENTINEL), 'the global memory of the test home reached the prompt');
});

test('a start without a home of its own still gets an empty one, not the real one', { timeout: 60000, skip }, async (t) => {
  const userDataDir = await makeTempDir('snotra-home-default-userdata-');
  const snotra = await launchApp({ userDataDir });
  t.after(() => snotra.stop().catch(() => {}));

  const seen = path.resolve(await appHome(snotra));
  assert.ok(snotra.home, 'launchApp made a home folder');
  assert.equal(seen, path.resolve(snotra.home));
  assert.notEqual(seen, path.resolve(homedir()), 'the app must not see the real home folder');
});
