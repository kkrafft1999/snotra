// The sandbox asks when it blocks something (#792), end to end: the real app,
// shell_execute, the real sandbox with its network proxy, and a fake model
// that calls the tool.
//
//  1. A write outside the folder is refused. The card after the run offers
//     the folder, it is allowed, the command runs a second time and the file
//     is there.
//  2. A connection the command waits for: the card appears while curl waits,
//     it is allowed, and curl carries on and gets its answer.
//  3. A connection denied with Esc: the command cannot reach the host, and the
//     model is told not to work around it.
//
// All of it runs in "Auto", where every other call goes through unasked — the
// sandbox asks there all the same. "Auto" needs encrypted storage; without it
// (a Linux runner without a keyring) the same steps run in "Smart", which asks
// about each command first and gets "Allow once".
//
// No sandbox on Windows: skipped. Where it is missing elsewhere — a test
// process that is sandboxed itself, since macOS does not nest — skipped as
// well, except on CI or with SNOTRA_REQUIRE_SANDBOX=1: a skipped sandbox test
// must not pass for a green one. Step 2 needs the network (www.example.com),
// like test/sandbox-isolation.test.js; step 3 does not, a denied connection
// never leaves the proxy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { startFakeModel } from './helpers/fake-model.mjs';
import { launchApp, prepareUserData, poll, makeTempDir, rendererToolEvents } from './helpers/app.mjs';

const REQUIRED = process.env.SNOTRA_REQUIRE_SANDBOX === '1' || process.env.CI === 'true';
const curl = (url) => `curl -sS -m 60 -o /dev/null -w "%{http_code}" ${url}`;

function ask(page, question) {
  return page.evaluate((text) => {
    const input = document.getElementById('chat-input');
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('btn-chat-send').click();
  }, question);
}

/**
 * One look at the chat. An access card of "Smart" is answered with "Allow
 * once" on the way; otherwise it reports whether the run is still going and
 * the open sandbox card, if any — `live` while the command waits for a
 * connection, the card after the run otherwise.
 */
function lookAtChat(page) {
  return page.evaluate(() => {
    const ready = (card) => {
      const button = card.querySelector('button[data-response="allow-once"]');
      return button && !button.disabled ? button : null;
    };
    const pending = [...document.querySelectorAll('#chat-messages .chat-approval-card[data-state="pending"]')];
    const access = pending.find((card) => !card.classList.contains('chat-approval-card--sandbox'));
    if (access) {
      const button = ready(access);
      button?.click();
      return { accessAnswered: Boolean(button) };
    }
    const sandbox = pending.find((card) => card.classList.contains('chat-approval-card--sandbox') && ready(card));
    return {
      running: document.getElementById('btn-chat-send').classList.contains('chat-send--stop'),
      card: sandbox
        ? {
          live: /connection waiting/i.test(sandbox.querySelector('.chat-approval-card__title')?.textContent || ''),
          text: sandbox.textContent.replace(/\s+/g, ' ').trim(),
        }
        : null,
    };
  });
}

/**
 * Clicks the open sandbox card's "Allow" for this run. `option` picks among
 * the first entry's paths — where it has a choice: on Linux a file that does
 * not exist yet is offered only as its folder, and the card shows no group
 * for a single path. The duration stays at its first option, this run.
 */
function allowSandboxCard(page, { option = 0 } = {}) {
  return page.evaluate((index) => {
    const card = document.querySelector('#chat-messages .chat-approval-card--sandbox[data-state="pending"]');
    const groups = [...card.querySelectorAll('.chat-approval-card__choice')];
    const paths = groups.find((group) => ![...group.querySelectorAll('input')].some((i) => i.value === 'session'));
    const choices = paths?.querySelectorAll('input') ?? [];
    choices[Math.min(index, choices.length - 1)]?.click();
    card.querySelector('button[data-response="allow-once"]').click();
  }, option);
}

test('the sandbox asks after the run and while the command waits, also in Auto', {
  timeout: 300_000,
  skip: process.platform === 'win32' && 'no sandbox on Windows',
}, async (t) => {
  const model = await startFakeModel();
  const workspace = await makeTempDir('snotra-e2e-sandbox-');
  const userDataDir = await makeTempDir('snotra-e2e-sandbox-userdata-');
  // A file, so the tree draws and tells the folder is open.
  await writeFile(path.join(workspace, 'schema.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf8');
  await prepareUserData(userDataDir, { workspace, modelBaseUrl: model.baseUrl });
  await writeFile(
    path.join(userDataDir, 'ui-preferences.json'),
    JSON.stringify({ appLocale: 'en', shellExecutionEnabled: true }),
    'utf8',
  );

  const snotra = await launchApp({ userDataDir });
  const { page, app } = snotra;
  t.after(async () => {
    await snotra.stop().catch(() => {});
    await model.close();
  });


  const toolResult = () => JSON.parse(model.requests
    .map((r) => r.body?.messages?.findLast?.((m) => m.role === 'tool')?.content)
    .filter(Boolean).at(-1) || '{}');
  const explain = async () => ({
    toolResult: toolResult(),
    renderer: (await rendererToolEvents(page)).split('\n').slice(-25).join('\n'),
    main: snotra.mainOutput().slice(-2000),
  });

  let accessAnswered = 0;
  /** Waits until the run has started — the send button turns into "Stop". */
  const started = () => poll(async () => (await lookAtChat(page)).running, { what: 'run started', explain });
  /** The next sandbox card, or `{ ended }` when the run finished without one. */
  const nextCard = (what) => poll(async () => {
    const seen = await lookAtChat(page);
    if (seen.accessAnswered) { accessAnswered += 1; return null; }
    if (seen.card) return seen.card;
    return seen.running === false ? { ended: true } : null;
  }, { what, timeoutMs: 90_000, explain });
  const finished = () => poll(async () => {
    const seen = await lookAtChat(page);
    if (seen.accessAnswered) { accessAnswered += 1; return null; }
    return seen.running === false;
  }, { what: 'run finished', timeoutMs: 90_000, explain });

  let commands = 0;
  /**
   * Has the model run `command` and waits for the first sandbox card. Seen on
   * macOS CI (#368, #714): curl did not reach the sandbox's proxy at all, and
   * the run says so itself in <sandbox_network>. No card can come then; the
   * step records it and asks once more, like test/sandbox-isolation.test.js.
   * Any other run that ends without a card fails with what the model was told.
   */
  async function runForCard(question, command, what) {
    for (let attempt = 1; ; attempt += 1) {
      const prompt = attempt === 1 ? question : `${question} Once more.`;
      model.queueAnswer({ match: prompt, toolCalls: [{ name: 'shell_execute', arguments: { command } }] });
      commands += 1;
      await ask(page, prompt);
      await started();
      const card = await nextCard(what);
      if (!card.ended) return card;
      const { stderr = '' } = toolResult();
      if (attempt === 1 && stderr.includes('<sandbox_network>')) {
        t.diagnostic(`${what}: the sandbox's proxy was not reached, asking once more — ${stderr}`);
        continue;
      }
      assert.fail(`${what}: the run ended without a card\n${JSON.stringify(await explain(), null, 1)}`);
    }
  }

  await poll(() => page.evaluate(() => document.querySelectorAll('#tree-container .tree-item').length > 0),
    { what: 'drawn tree' });

  const isolation = await poll(async () => {
    const state = await page.evaluate(() => window.electronAPI.getToolPermissionState());
    const described = state?.executionIsolation;
    return described && !described.pending ? { ...described, encryptionAvailable: state.encryptionAvailable } : null;
  }, { what: 'sandbox detection', timeoutMs: 60_000 });
  assert.ok(isolation.tools.includes('shell_execute'), `shell_execute is not offered: ${JSON.stringify(isolation)}`);
  if (isolation.unisolated) {
    const why = `sandbox not available: ${isolation.reason || 'unknown reason'}`;
    if (REQUIRED) assert.fail(why);
    t.skip(why);
    return;
  }

  // "Auto" asks in a system dialog first; the test confirms it itself.
  const auto = isolation.encryptionAvailable === true;
  if (auto) {
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await page.evaluate(() => window.electronAPI.setToolPermissionMode('auto'));
    await poll(() => page.evaluate(() => document.getElementById('chat-tool-mode-wrap').dataset.mode === 'auto'),
      { what: 'Auto mode' });
  } else {
    t.diagnostic('no encrypted storage here: the steps run in "Smart" instead of "Auto"');
  }

  // 1. A write outside the folder: the card after the run, the folder allowed, a second run.
  const home = await app.evaluate(() => process.env.HOME);
  const cache = path.join(home, 'Library', 'Caches', 'snotra-e2e');
  await mkdir(cache, { recursive: true });
  const engine = path.join(cache, 'query-engine');
  const afterRun = await runForCard('Generate the client please.',
    `echo engine > "${engine}" && echo generated`, 'card after the run');
  assert.equal(afterRun.live, false, `expected the card after the run: ${afterRun.text}`);
  assert.match(afterRun.text, /query-engine/, 'the card names the refused file');
  // The folder around the file: it exists, the file does not yet. On macOS
  // it is the second choice, on Linux the only one.
  await allowSandboxCard(page, { option: 1 });
  await finished();
  assert.equal(await readFile(engine, 'utf8'), 'engine\n', 'the second run wrote the file');
  const written = toolResult();
  assert.equal(written.exit_code, 0, JSON.stringify(written));
  assert.match(written.sandbox_decision, /^The user allowed .+ for this run, and the command ran a second time\./);

  // 2. A connection the command waits for: allowed while curl waits, curl gets through.
  const live = await runForCard('Fetch the example page.', curl('https://www.example.com'),
    'card while the command waits');
  assert.equal(live.live, true, `expected the card while curl waits: ${live.text}`);
  assert.match(live.text, /www\.example\.com/);
  await allowSandboxCard(page);
  await finished();
  const fetched = toolResult();
  assert.equal(fetched.stdout?.trim(), '200', JSON.stringify(fetched));
  assert.match(fetched.sandbox_connections, /the user allowed www\.example\.com:443 for this run\./);
  assert.equal(fetched.sandbox_decision, undefined, 'no card after the run: the connection was open already');

  // 3. A connection denied with Esc: the model is told not to work around it.
  const denied = await runForCard('Now the other page.', curl('https://www.example.org'),
    'card for the denied connection');
  assert.equal(denied.live, true, `expected the card while curl waits: ${denied.text}`);
  assert.match(denied.text, /www\.example\.org/);
  await page.keyboard.press('Escape');
  await finished();
  const refused = toolResult();
  assert.notEqual(refused.stdout?.trim(), '200', JSON.stringify(refused));
  assert.match(refused.sandbox_connections,
    /^The user denied the connection to www\.example\.org:443 while the command ran, .+ Do not work around it/);
  assert.equal(refused.sandbox_decision, undefined, 'nothing is asked after a denial');

  // In "Auto" nothing was asked about but the sandbox's; in "Smart" each command was.
  assert.equal(accessAnswered, auto ? 0 : commands,
    auto ? 'no access card in "Auto"' : 'one access card per command in "Smart"');
});
